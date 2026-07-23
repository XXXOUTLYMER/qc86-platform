const assert = require('assert');
const axios = require('axios');
const qc86 = require('../api/qc86');
const providerService = require('../api/providerService');

async function withMockedAxios(response, callback) {
  const originalGet = axios.get;
  axios.get = async () => ({ data: response });
  try {
    await callback();
  } finally {
    axios.get = originalGet;
  }
}

async function run() {
  await withMockedAxios({ success: true, data: { phone: '17012345678' } }, async () => {
    const result = await qc86.getPhone('token', 'project', 0, null, { base_url: 'https://api.example.test/api' });
    assert.equal(result.success, true);
    assert.equal(result.data.mobile, '17012345678');
  });

  await withMockedAxios({ success: false, msg: 'Token 已过期，请重新登录' }, async () => {
    const result = await qc86.getPhone('token', 'project', 0, null, { base_url: 'https://api.example.test/api' });
    assert.equal(qc86.isTokenFailure(result), true);
  });

  const originalGetPhone = qc86.getPhone;
  const originalLogin = qc86.login;
  const seenTokens = [];
  qc86.getPhone = async token => {
    seenTokens.push(token);
    return token === 'old-token'
      ? { success: false, msg: 'Token 已过期' }
      : { success: true, data: { mobile: '17012345678' } };
  };
  qc86.login = async () => 'fresh-token';
  try {
    const result = await providerService.getPhone(
      { provider_type: 'qc86', base_url: 'https://api.example.test/api' },
      { channel_id: 'project', operator: 0, scope: '' },
      'old-token'
    );
    assert.deepEqual(seenTokens, ['old-token', 'fresh-token']);
    assert.equal(result.data.mobile, '17012345678');
    assert.equal(result.providerToken, 'fresh-token');
  } finally {
    qc86.getPhone = originalGetPhone;
    qc86.login = originalLogin;
  }

  console.log('qc86 API adapter checks passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
