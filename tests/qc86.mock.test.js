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

  const directScopeCalls = [];
  const rejected = [];
  const released = [];
  qc86.getPhone = async (token, channelId, operator, scope) => {
    directScopeCalls.push({ token, channelId, operator, scope });
    // The upstream deliberately ignores scope. The platform must never return
    // this wrong number to the caller.
    return { success: true, data: { mobile: '13100000000' } };
  };
  const originalBlacklistPhone = qc86.blacklistPhone;
  const originalReleasePhone = qc86.releasePhone;
  qc86.blacklistPhone = async (token, channelId, phone) => {
    released.push({ action: 'blacklist', token, channelId, phone });
    return { success: true };
  };
  qc86.releasePhone = async (token, channelId, phone) => {
    released.push({ action: 'release', token, channelId, phone });
    return { success: true };
  };
  try {
    const result = await providerService.getPhoneWithPrefix(
      { provider_type: 'qc86', base_url: 'https://api.example.test/api' },
      {
        channel_id: 'project',
        operator: 0,
        scope: 'old-region-scope',
        direct_scope: '170',
        prefix: '170',
        prefix_enabled: 1,
        prefix_max_requests: 20,
        prefix_concurrency: 10
      },
      {
        token: 'scope-token',
        onRejected: phone => rejected.push(phone)
      }
    );
    assert.equal(result.success, false);
    assert.match(result.msg, /未按指定号段 170 返回号码/);
    assert.equal(result.requestCount, 1);
    assert.equal(result.maxRequests, 1);
    assert.equal(result.concurrency, 1);
    assert.equal(result.usedDirectScope, true);
    assert.deepEqual(directScopeCalls, [{ token: 'scope-token', channelId: 'project', operator: 0, scope: '170' }]);
    assert.deepEqual(rejected, ['13100000000']);
    assert.deepEqual(released, [
      { action: 'blacklist', token: 'scope-token', channelId: 'project', phone: '13100000000' },
      { action: 'release', token: 'scope-token', channelId: 'project', phone: '13100000000' }
    ]);
  } finally {
    qc86.getPhone = originalGetPhone;
    qc86.blacklistPhone = originalBlacklistPhone;
    qc86.releasePhone = originalReleasePhone;
  }

  console.log('qc86 API adapter checks passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
