const assert = require('assert');
const axios = require('axios');
const uoomsg = require('../api/uoomsg');
const providerService = require('../api/providerService');

const provider = {
  provider_type: 'uoomsg',
  base_url: 'https://api.example.test/data.php',
  token: 'uoomsg-test-token'
};

const channel = {
  api_keyword: '测试平台',
  api_phone: '17000000000',
  api_province: '广东',
  api_card_type: '虚卡'
};

async function withMockedAxios(responses, callback) {
  const originalGet = axios.get;
  const calls = [];
  axios.get = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { data: next };
  };
  try {
    await callback(calls);
  } finally {
    axios.get = originalGet;
  }
}

async function run() {
  await withMockedAxios(['19.80'], async calls => {
    const result = await uoomsg.getBalance(provider, provider.token);
    assert.equal(result.balance, '19.80');
    assert.deepEqual(calls[0].options.params, { code: 'leftAmount', token: provider.token });
  });

  await withMockedAxios(['17012345678'], async calls => {
    const result = await uoomsg.getPhone(provider, provider.token, channel);
    assert.equal(result.data.mobile, '17012345678');
    assert.deepEqual(calls[0].options.params, {
      code: 'getPhone',
      token: provider.token,
      keyWord: '测试平台',
      phone: '17000000000',
      province: '广东',
      cardType: '虚卡'
    });
  });

  await withMockedAxios(['【测试平台】验证码 846226，30 分钟内有效'], async calls => {
    const result = await uoomsg.getCode(provider, provider.token, channel, '17012345678');
    assert.equal(result.data.code, '846226');
    assert.equal(calls[0].options.params.code, 'getMsg');
    assert.equal(calls[0].options.params.keyWord, channel.api_keyword);
  });

  await withMockedAxios(['[尚未收到]'], async () => {
    assert.equal(await uoomsg.getCode(provider, provider.token, channel, '17012345678'), null);
  });

  await withMockedAxios(['释放成功', '拉黑成功'], async calls => {
    assert.equal((await uoomsg.releasePhone(provider, provider.token, '17012345678')).msg, '释放成功');
    assert.equal((await uoomsg.blacklistPhone(provider, provider.token, '17012345678')).msg, '拉黑成功');
    assert.equal(calls[0].options.params.code, 'release');
    assert.equal(calls[1].options.params.code, 'block');
  });

  await withMockedAxios(['发送成功'], async calls => {
    const result = await uoomsg.sendSms(provider, provider.token, {
      phone: '17012345678',
      toPhone: '106900000000',
      projId: 'project-1',
      content: '测试短信'
    });
    assert.equal(result.msg, '发送成功');
    assert.deepEqual(calls[0].options.params, {
      code: 'send',
      token: provider.token,
      phone: '17012345678',
      toPhone: '106900000000',
      content: '测试短信',
      projId: 'project-1'
    });
  });

  await withMockedAxios(['记录一\n记录二\n'], async () => {
    const result = await uoomsg.queryUsed(provider, provider.token);
    assert.deepEqual(result.data.records, ['记录一', '记录二']);
  });

  await withMockedAxios(['ERROR:Token 无效'], async () => {
    await assert.rejects(() => uoomsg.getBalance(provider, provider.token), /Token 无效/);
  });

  assert.equal(await providerService.getToken(provider), provider.token);

  const originalGetPhone = uoomsg.getPhone;
  const originalReleasePhone = uoomsg.releasePhone;
  const sequence = ['13100000000', '17099999999'];
  const rejected = [];
  uoomsg.getPhone = async () => ({ success: true, data: { mobile: sequence.shift() } });
  uoomsg.releasePhone = async () => {
    throw new Error('号段过滤不应直接同步释放，释放由 rejected_phones 延迟任务负责');
  };
  try {
    const result = await providerService.getPhoneWithPrefix(provider, {
      ...channel,
      api_phone: '',
      prefix: '170',
      prefix_enabled: 1,
      prefix_max_requests: 2,
      prefix_request_interval_ms: 500
    }, {
      token: provider.token,
      onRejected: phone => rejected.push(phone)
    });
    assert.equal(result.data.mobile, '17099999999');
    assert.deepEqual(rejected, ['13100000000']);
    assert.equal(result.requestCount, 2);
  } finally {
    uoomsg.getPhone = originalGetPhone;
    uoomsg.releasePhone = originalReleasePhone;
  }

  const noMatchSequence = ['13100000001', '13200000002', '13300000003'];
  const progress = [];
  uoomsg.getPhone = async () => ({ success: true, data: { mobile: noMatchSequence.shift() } });
  try {
    const result = await providerService.getPhoneWithPrefix(provider, {
      ...channel,
      api_phone: '',
      prefix: '170',
      prefix_enabled: 1,
      prefix_max_requests: 3,
      prefix_request_interval_ms: 500
    }, {
      token: provider.token,
      onProgress: update => progress.push(update.attempt)
    });
    assert.equal(result.success, false);
    assert.equal(result.requestCount, 3);
    assert.equal(result.maxRequests, 3);
    assert.deepEqual(progress, [1, 2, 3]);
  } finally {
    uoomsg.getPhone = originalGetPhone;
  }

  console.log('uoomsg mock API tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
