const axios = require('axios');
const config = require('../config');
const { getDb, saveDb } = require('../database');

function providerBaseUrl(provider) {
  return provider && provider.base_url ? String(provider.base_url).replace(/\/$/, '') : config.qc86.baseUrl;
}

function getToken(provider) {
  if (provider && provider.id) return provider.token || '';
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key='qc86_token'").get();
  return row ? row.value : '';
}

async function login(provider) {
  const db = getDb();
  const username = provider && provider.username
    ? provider.username
    : db.prepare("SELECT value FROM settings WHERE key='qc86_username'").get()?.value;
  const password = provider && provider.password
    ? provider.password
    : db.prepare("SELECT value FROM settings WHERE key='qc86_password'").get()?.value;
  if (!username || !password) throw new Error('未配置API用户名密码');
  const resp = await axios.get(`${providerBaseUrl(provider)}/login`, {
    params: { username, password },
    timeout: 10000
  });
  if (resp.data.success && resp.data.data.token) {
    if (provider && provider.id) {
      db.prepare('UPDATE api_providers SET token=? WHERE id=?').run([resp.data.data.token, provider.id]);
    }
    if (!provider || provider.is_system) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qc86_token', ?)").run(resp.data.data.token);
    }
    saveDb();
    return resp.data.data.token;
  }
  throw new Error('登录失败: ' + resp.data.msg);
}

async function getWallet(token, provider) {
  const resp = await axios.get(`${providerBaseUrl(provider)}/getWallet`, {
    params: { token },
    timeout: 10000
  });
  return resp.data;
}

async function getPhone(token, channelId, operator = 0, scope = null, provider) {
  const params = { token, channelId, operator };
  if (scope) params.scope = scope;
  const resp = await axios.get(`${providerBaseUrl(provider)}/getPhone`, {
    params, timeout: 10000
  });
  return resp.data;
}

async function getCode(token, channelId, phoneNum, maxAttempts = 100, provider) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await axios.get(`${providerBaseUrl(provider)}/getCode`, {
        params: { token, channelId, phoneNum },
        timeout: 10000
      });
      if (resp.data.success && resp.data.data && resp.data.data.code) {
        return resp.data;
      }
    } catch (e) {
      // continue retrying
    }
    // Wait 1 second between attempts
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

async function blacklistPhone(token, channelId, phoneNo, provider) {
  const resp = await axios.get(`${providerBaseUrl(provider)}/phoneCollectAdd`, {
    params: { token, channelId, phoneNo, type: 0 },
    timeout: 10000
  });
  return resp.data;
}

async function releasePhone(token, channelId, phoneNo, provider) {
  const resp = await axios.get(`${providerBaseUrl(provider)}/release`, {
    params: { token, channelId, phoneNo, status: 2 },
    timeout: 10000
  });
  return resp.data;
}

async function getPhoneWithPrefix(token, channelId, operator, scope, prefix, options = {}, provider) {
  const prefixList = prefix
    ? String(prefix).split(/[,，\s]+/).map(p => p.trim()).filter(Boolean)
    : [];
  const enabled = options.enabled !== false && Number(options.enabled) !== 0;
  const parsedMaxRequests = parseInt(options.maxRequests, 10);
  const maxRequests = Math.min(20, Math.max(1, Number.isFinite(parsedMaxRequests) ? parsedMaxRequests : 20));
  const parsedIntervalMs = parseInt(options.requestIntervalMs, 10);
  const requestIntervalMs = Math.min(10000, Math.max(500, Number.isFinite(parsedIntervalMs) ? parsedIntervalMs : 500));
  const onRejected = typeof options.onRejected === 'function' ? options.onRejected : null;

  if (!enabled || prefixList.length === 0) {
    const result = await getPhone(token, channelId, operator, scope, provider);
    return { ...result, rejected: [], requestCount: 1, maxRequests: 1, requestIntervalMs };
  }

  const rejected = [];
  for (let attempt = 1; attempt <= maxRequests; attempt++) {
    const result = await getPhone(token, channelId, operator, scope, provider);
    if (result.success && result.data && result.data.mobile) {
      const phone = String(result.data.mobile);
      if (prefixList.some(p => phone.startsWith(p))) {
        return { ...result, rejected, requestCount: attempt, maxRequests, requestIntervalMs };
      }

      rejected.push(phone);
      if (onRejected) {
        try {
          await onRejected(phone, attempt);
        } catch (e) {
          console.error('Failed to register rejected phone:', e.message);
        }
      }
    }

    if (attempt < maxRequests) await new Promise(r => setTimeout(r, requestIntervalMs));
  }

  return {
    success: false,
    msg: '已逐个请求 ' + maxRequests + ' 次，暂未获取到指定号段(' + prefixList.join(', ') + ')的号码，请稍后重试',
    rejected,
    requestCount: maxRequests,
    maxRequests,
    requestIntervalMs
  };
}
 
module.exports = { getToken, login, getWallet, getPhone, getCode, blacklistPhone, releasePhone, getPhoneWithPrefix };
