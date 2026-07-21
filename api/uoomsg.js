const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.uoomsg.com/zc/data.php';

function baseUrl(provider) {
  return provider && provider.base_url ? provider.base_url : DEFAULT_BASE_URL;
}

function parseTextResponse(data) {
  const text = String(data == null ? '' : data).trim();
  if (!text) throw new Error('API返回为空');
  if (/^ERROR[:：]/i.test(text)) throw new Error(text.replace(/^ERROR[:：]\s*/i, '') || 'API请求失败');
  return text;
}

async function request(provider, params) {
  const response = await axios.get(baseUrl(provider), {
    params,
    timeout: 15000,
    responseType: 'text',
    transformResponse: [data => data]
  });
  return parseTextResponse(response.data);
}

async function getBalance(provider, token) {
  const value = await request(provider, { code: 'leftAmount', token });
  return { success: true, data: { balances: value }, balance: value };
}

async function getPhone(provider, token, channel) {
  const params = {
    code: 'getPhone',
    token,
    keyWord: channel.api_keyword || '',
    phone: channel.api_phone || '',
    province: channel.api_province || '',
    cardType: channel.api_card_type || '全部'
  };
  Object.keys(params).forEach(key => {
    if (params[key] === '') delete params[key];
  });
  const phone = await request(provider, params);
  if (!/^\d{7,20}$/.test(phone)) throw new Error('API返回的手机号格式不正确: ' + phone);
  return { success: true, data: { mobile: phone, refreshTime: 5000 } };
}

async function getCode(provider, token, channel, phone) {
  const message = await request(provider, {
    code: 'getMsg',
    token,
    phone,
    keyWord: channel.api_keyword || ''
  });
  if (message.includes('[尚未收到]') || message.includes('尚未收到')) return null;
  const match = message.match(/(?<!\d)(\d{4,8})(?!\d)/);
  if (!match) return null;
  return { success: true, data: { code: match[1], modle: message } };
}

async function releasePhone(provider, token, phone) {
  const result = await request(provider, { code: 'release', token, phone });
  return { success: true, msg: result };
}

async function blacklistPhone(provider, token, phone) {
  const result = await request(provider, { code: 'block', token, phone });
  return { success: true, msg: result };
}

async function sendSms(provider, token, options = {}) {
  const phone = String(options.phone || '').trim();
  const toPhone = String(options.toPhone || '').trim();
  const content = String(options.content || '').trim();
  if (!phone || !toPhone || !content) {
    throw new Error('发送短信需要填写手机号、目标号码和短信内容');
  }
  const params = {
    code: 'send',
    token,
    phone,
    toPhone,
    content,
    projId: String(options.projId || '').trim()
  };
  if (!params.projId) delete params.projId;
  const result = await request(provider, params);
  return { success: true, msg: result };
}

async function queryUsed(provider, token) {
  const result = await request(provider, { code: 'queryUsed', token });
  const records = result
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return { success: true, data: { raw: result, records } };
}

module.exports = {
  DEFAULT_BASE_URL,
  parseTextResponse,
  getBalance,
  getPhone,
  getCode,
  releasePhone,
  blacklistPhone,
  sendSms,
  queryUsed
};
