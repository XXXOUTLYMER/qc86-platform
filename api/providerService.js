const { getDb } = require('../database');
const qc86 = require('./qc86');
const uoomsg = require('./uoomsg');

function getProviderForChannel(channel) {
  if (!channel) throw new Error('项目不存在');
  const db = getDb();
  let provider = null;
  if (channel.provider_id) {
    provider = db.prepare('SELECT * FROM api_providers WHERE id=?').get([channel.provider_id]);
  }
  if (!provider) {
    provider = db.prepare("SELECT * FROM api_providers WHERE provider_type='qc86' AND is_system=1 ORDER BY id LIMIT 1").get();
  }
  if (!provider) throw new Error('项目未绑定API服务商');
  if (!provider.is_active) throw new Error('该API服务商已停用');
  return provider;
}

function providerType(provider) {
  return String(provider.provider_type || '').toLowerCase();
}

async function getToken(provider) {
  if (providerType(provider) === 'uoomsg') {
    if (!provider.token) throw new Error('未配置 uoomsg API Token');
    return provider.token;
  }
  let token = qc86.getToken(provider);
  if (!token) token = await qc86.login(provider);
  return token;
}

async function getBalance(provider) {
  const token = await getToken(provider);
  if (providerType(provider) === 'uoomsg') return uoomsg.getBalance(provider, token);
  return qc86.getWallet(token, provider);
}

async function getPhone(provider, channel, token, options = {}) {
  if (providerType(provider) === 'uoomsg') {
    const requestChannel = options.phone
      ? { ...channel, api_phone: options.phone }
      : channel;
    return uoomsg.getPhone(provider, token, requestChannel);
  }
  const requestPhone = requestToken => qc86.getPhone(
    requestToken,
    channel.channel_id,
    channel.operator,
    channel.scope || null,
    provider
  );
  const firstResult = await requestPhone(token);

  // qc86 tokens can expire while a long-running platform is online. Refresh
  // once and repeat the same request so the user does not see a false failure.
  if (!qc86.isTokenFailure(firstResult)) return firstResult;
  const refreshedToken = await qc86.login(provider);
  const retriedResult = await requestPhone(refreshedToken);
  return { ...retriedResult, providerToken: refreshedToken };
}

async function getCode(provider, channel, token, phone) {
  if (providerType(provider) === 'uoomsg') return uoomsg.getCode(provider, token, channel, phone);
  return qc86.getCode(token, channel.channel_id, phone, 1, provider);
}

async function blacklistPhone(provider, channel, token, phone) {
  if (providerType(provider) === 'uoomsg') return uoomsg.blacklistPhone(provider, token, phone);
  return qc86.blacklistPhone(token, channel.channel_id, phone, provider);
}

async function releasePhone(provider, channel, token, phone) {
  if (providerType(provider) === 'uoomsg') return uoomsg.releasePhone(provider, token, phone);
  return qc86.releasePhone(token, channel.channel_id, phone, provider);
}

async function sendSms(provider, token, options = {}) {
  if (providerType(provider) !== 'uoomsg') {
    throw new Error('当前 API 服务商不支持发送短信工具');
  }
  return uoomsg.sendSms(provider, token, options);
}

async function queryUsed(provider, token) {
  if (providerType(provider) !== 'uoomsg') {
    throw new Error('当前 API 服务商不支持历史记录工具');
  }
  return uoomsg.queryUsed(provider, token);
}

async function getPhoneWithPrefix(provider, channel, options = {}) {
  let token = options.token || await getToken(provider);
  const prefixList = channel.prefix
    ? String(channel.prefix).split(/[,，\s]+/).map(value => value.trim()).filter(Boolean)
    : [];
  const enabled = Number(channel.prefix_enabled) !== 0 && prefixList.length > 0;
  const filterMode = channel.prefix_filter_mode === 'exclude' ? 'exclude' : 'include';
  const maxRequests = enabled
    ? Math.min(20, Math.max(1, parseInt(channel.prefix_max_requests, 10) || 20))
    : 1;
  const requestedConcurrency = parseInt(channel.prefix_concurrency, 10);
  const concurrency = enabled
    ? Math.min(maxRequests, Math.min(10, Math.max(1, Number.isFinite(requestedConcurrency) ? requestedConcurrency : 1)))
    : 1;
  const requestIntervalMs = Math.min(10000, Math.max(500, parseInt(channel.prefix_request_interval_ms, 10) || 500));
  const rejected = [];

  let nextAttempt = 1;
  let requestCount = 0;
  let acceptedResult = null;

  async function reportProgress(attempt, matched) {
    if (typeof options.onProgress !== 'function') return;
    try {
      await options.onProgress({
        attempt,
        requestCount,
        maxRequests,
        concurrency,
        rejectedCount: rejected.length,
        matched
      });
    } catch (error) {
      console.error('Failed to report phone request progress:', error.message);
    }
  }

  async function releaseExtraMatch(phone) {
    try {
      await blacklistPhone(provider, channel, token, phone);
      await releasePhone(provider, channel, token, phone);
    } catch (error) {
      console.error('Failed to release extra matched phone:', error.message);
    }
  }

  async function requestWorker() {
    while (!acceptedResult && nextAttempt <= maxRequests) {
      const attempt = nextAttempt++;
      requestCount = Math.max(requestCount, attempt);
      let result;
      try {
        result = await getPhone(provider, channel, token, options);
        if (result && result.providerToken) token = result.providerToken;
      } catch (error) {
        result = { success: false, msg: error.message };
      }

      if (result && result.success && result.data && result.data.mobile) {
        const phone = String(result.data.mobile);
        const matches = prefixList.some(prefix => phone.startsWith(prefix));
        const accepted = !enabled || (filterMode === 'exclude' ? !matches : matches);
        if (accepted) {
          if (!acceptedResult) {
            acceptedResult = { ...result, attempt };
            await reportProgress(attempt, true);
          } else {
            // Concurrent requests can finish together. Keep the first matching
            // number and immediately release any other matching result.
            await releaseExtraMatch(phone);
          }
          return;
        }

        rejected.push(phone);
        if (typeof options.onRejected === 'function') {
          try {
            await options.onRejected(phone, attempt, {
              mode: filterMode,
              prefixes: prefixList,
              reason: filterMode === 'exclude'
                ? '命中排除号段：' + prefixList.join(', ')
                : '不符合指定号段：' + prefixList.join(', ')
            });
          } catch (error) {
            console.error('Failed to register rejected phone:', error.message);
          }
        }
      }

      await reportProgress(attempt, false);
      if (!acceptedResult && nextAttempt <= maxRequests) {
        await new Promise(resolve => setTimeout(resolve, requestIntervalMs));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, requestWorker));

  if (acceptedResult) {
    return {
      ...acceptedResult,
      token,
      rejected,
      requestCount,
      maxRequests,
      concurrency,
      requestIntervalMs
    };
  }

  return {
    success: false,
    msg: enabled
      ? '已请求 ' + requestCount + ' 次（同时 ' + concurrency + ' 个），' + (filterMode === 'exclude'
        ? '获取到的号码均命中排除号段(' + prefixList.join(', ') + ')，请稍后重试'
        : '暂未获取到指定号段(' + prefixList.join(', ') + ')的号码，请稍后重试')
      : '获取号码失败，请稍后重试',
    token,
    rejected,
    requestCount,
    maxRequests,
    concurrency,
    requestIntervalMs
  };
}

module.exports = {
  getProviderForChannel,
  getToken,
  getBalance,
  getPhone,
  getCode,
  blacklistPhone,
  releasePhone,
  sendSms,
  queryUsed,
  getPhoneWithPrefix
};
