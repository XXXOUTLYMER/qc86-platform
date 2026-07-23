const { getDb, saveDb } = require('../database');
const providerService = require('../api/providerService');
const { registerRejectedPhone } = require('../routes/rejectedPhones');

const activeJobs = new Set();
let pendingJobSaveTimer = null;

function scheduleJobSave(delayMs = 800) {
  if (pendingJobSaveTimer) return;
  pendingJobSaveTimer = setTimeout(() => {
    pendingJobSaveTimer = null;
    saveDb();
  }, delayMs);
  if (pendingJobSaveTimer.unref) pendingJobSaveTimer.unref();
}

function formatSmsMessage(provider, message) {
  const raw = String(message || '').trim();
  if (!raw || !provider || Number(provider.strip_sms_metadata) === 0) return raw;
  return raw.replace(/^\s*(?:\+?86[-\s]?)?1\d{10}\s*\/\s*\d+(?:\.\d+)?\s*\/\s*/, '');
}

function getPhoneRequestJob(cardId) {
  return getDb().prepare('SELECT * FROM phone_request_jobs WHERE card_key_id=?').get([cardId]);
}

function updateJob(cardId, state, message, extra = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE phone_request_jobs
    SET state=?, message=?, request_count=?, max_requests=?, attempt_counted=?,
        updated_at=datetime('now','localtime'),
        completed_at=CASE WHEN ? IN ('success', 'failed') THEN datetime('now','localtime') ELSE NULL END
    WHERE card_key_id=?
  `).run([
    state,
    String(message || ''),
    Number(extra.requestCount || 0),
    Number(extra.maxRequests || 1),
    Number(extra.attemptCounted || 0),
    state,
    cardId
  ]);
  // sql.js exports the whole database on every save. Progress updates can happen
  // up to 20 times per request, so persist them in a short batch instead of
  // blocking the event loop (and status page) for every rejected number.
  if (state === 'success' || state === 'failed') saveDb();
  else scheduleJobSave();
}

function getPrefixOptions(card, channel) {
  return {
    enabled: channel.prefix_enabled,
    maxRequests: channel.prefix_max_requests,
    concurrency: channel.prefix_concurrency,
    requestIntervalMs: channel.prefix_request_interval_ms,
    onRejected(phone, attempt, rejection) {
      registerRejectedPhone({
        cardId: card.id,
        channelId: channel.id,
        phone,
        channelName: channel.name,
        reason: rejection && rejection.reason,
        deferSave: true
      });
    },
    onProgress(progress) {
      const job = getPhoneRequestJob(card.id) || {};
      const totalRequests = Math.min(20, Math.max(1, parseInt(progress.maxRequests, 10) || 1));
      const concurrency = Math.min(totalRequests, Math.min(10, Math.max(1, parseInt(channel.prefix_concurrency, 10) || 1)));
      updateJob(card.id, 'running', concurrency > 1 ? '正在并发筛选指定号段的号码' : '正在逐个筛选指定号段的号码', {
        requestCount: progress.attempt,
        maxRequests: progress.maxRequests,
        attemptCounted: job.attempt_counted
      });
    }
  };
}

async function releasePreviousPhone(provider, channel, token, card) {
  if (!card.phone_number) return;
  try {
    await providerService.blacklistPhone(provider, channel, token, card.phone_number);
    await providerService.releasePhone(provider, channel, token, card.phone_number);
  } catch (error) {
    // A failed cleanup must not keep the browser request open or block the new task.
    console.error('Failed to release previous phone:', error.message);
  }
}

async function pollForCode(cardId, phoneNumber, interval) {
  const db = getDb();
  const card = db.prepare('SELECT * FROM card_keys WHERE id=?').get([cardId]);
  if (!card || card.is_test) return;

  const timeoutSetting = (db.prepare("SELECT value FROM settings WHERE key='release_timeout'").get() || {}).value || '5';
  const timeoutMinutes = parseInt(timeoutSetting, 10) || 5;
  const pollInterval = Math.max(interval || 5000, 3000);
  const maxPolls = Math.ceil(timeoutMinutes * 60 * 1000 / pollInterval);
  const channel = db.prepare('SELECT * FROM channels WHERE id=?').get([card.channel_id]);
  if (!channel) return;

  let provider;
  let token;
  try {
    provider = providerService.getProviderForChannel(channel);
    token = card.token || await providerService.getToken(provider);
  } catch (error) {
    console.error('SMS polling provider error:', error.message);
    return;
  }

  for (let index = 0; index < maxPolls; index++) {
    try {
      const result = await providerService.getCode(provider, channel, token, phoneNumber);
      if (result && result.success && result.data && result.data.code) {
        const smsCode = result.data.code;
        const smsMessage = formatSmsMessage(provider, result.data.modle || '');
        db.prepare('UPDATE card_keys SET sms_code=?, sms_message=? WHERE id=?').run([smsCode, smsMessage, cardId]);
        db.prepare("UPDATE card_keys SET status='used' WHERE id=? AND sms_code IS NOT NULL AND sms_code != ''").run([cardId]);
        db.prepare("UPDATE usage_records SET sms_code=?, sms_message=?, status='completed' WHERE card_key_id=? AND status='pending'").run([smsCode, smsMessage, cardId]);
        saveDb();

        try {
          await providerService.blacklistPhone(provider, channel, token, phoneNumber);
          await providerService.releasePhone(provider, channel, token, phoneNumber);
        } catch (error) {
          console.error('Failed to release phone after SMS:', error.message);
        }
        return;
      }
    } catch (error) {
      // Keep polling until the configured release timeout is reached.
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  db.prepare("UPDATE card_keys SET phone_number='', token='', sms_task_id='' WHERE id=? AND (sms_code IS NULL OR sms_code = '')").run([cardId]);
  db.prepare("UPDATE usage_records SET status='timeout' WHERE card_key_id=? AND status='pending'").run([cardId]);
  saveDb();
  try {
    await providerService.blacklistPhone(provider, channel, token, phoneNumber);
    await providerService.releasePhone(provider, channel, token, phoneNumber);
  } catch (error) {
    console.error('Failed to release timed-out phone:', error.message);
  }
}

function runPhoneRequest(cardId) {
  const numericCardId = Number(cardId);
  if (!numericCardId || activeJobs.has(numericCardId)) return;
  activeJobs.add(numericCardId);

  setImmediate(async () => {
    try {
      const db = getDb();
      let card = db.prepare('SELECT * FROM card_keys WHERE id=?').get([numericCardId]);
      if (!card) {
        updateJob(numericCardId, 'failed', '卡密不存在');
        return;
      }
      if (card.sms_code) {
        updateJob(numericCardId, 'failed', '卡密已使用，不能继续获取号码');
        return;
      }
      if (card.attempts >= (card.max_attempts || 3)) {
        updateJob(numericCardId, 'failed', '卡密获取次数已用完');
        return;
      }

      const channel = db.prepare('SELECT * FROM channels WHERE id=?').get([card.channel_id]);
      if (!channel || !channel.is_active) {
        updateJob(numericCardId, 'failed', '项目不可用');
        return;
      }

      const maxRequests = Number(channel.prefix_enabled) !== 0 && String(channel.prefix || '').trim()
        ? Math.min(20, Math.max(1, parseInt(channel.prefix_max_requests, 10) || 20))
        : 1;
      const existingJob = getPhoneRequestJob(numericCardId) || {};
      updateJob(numericCardId, 'running', '正在连接号码服务', {
        requestCount: existingJob.request_count || 0,
        maxRequests,
        attemptCounted: existingJob.attempt_counted || 0
      });

      const provider = providerService.getProviderForChannel(channel);
      const token = await providerService.getToken(provider);

      await releasePreviousPhone(provider, channel, token, card);
      if (card.phone_number) {
        db.prepare("UPDATE card_keys SET phone_number='', token='', sms_task_id='' WHERE id=? AND (sms_code IS NULL OR sms_code = '')").run([numericCardId]);
      }

      // Filtering can request and release several non-matching numbers. A card
      // is charged only after a matching number is actually assigned to it.
      updateJob(numericCardId, 'running', '正在逐个筛选指定号段的号码', {
        requestCount: 0,
        maxRequests,
        attemptCounted: 0
      });

      card = db.prepare('SELECT * FROM card_keys WHERE id=?').get([numericCardId]);
      const phoneResult = await providerService.getPhoneWithPrefix(provider, channel, {
        token,
        ...getPrefixOptions(card, channel)
      });
      if (!phoneResult.success || !phoneResult.data || !phoneResult.data.mobile) {
        const job = getPhoneRequestJob(numericCardId) || {};
        updateJob(numericCardId, 'failed', phoneResult.msg || '暂未找到可用号码，请稍后重试', {
          requestCount: phoneResult.requestCount || job.request_count || 0,
          maxRequests: phoneResult.maxRequests || job.max_requests || maxRequests,
          attemptCounted: 0
        });
        return;
      }

      const phoneNumber = phoneResult.data.mobile;
      const refreshTime = phoneResult.data.refreshTime || 5000;
      const smsTaskId = phoneResult.data.smsTask?.id || '';
      const tokenValue = phoneResult.data.smsTask?.token || token;
      db.prepare(`
        UPDATE card_keys
        SET phone_number=?, token=?, sms_task_id=?, used_at=datetime('now','localtime'),
            attempts=attempts+1,
            status=CASE WHEN attempts+1 >= CASE WHEN max_attempts IS NULL OR max_attempts < 1 THEN 3 ELSE max_attempts END THEN 'used' ELSE 'unused' END
        WHERE id=?
      `).run([phoneNumber, tokenValue, smsTaskId, numericCardId]);
      db.prepare('INSERT INTO usage_records (card_key_id, card_code, channel_name, phone_number, status) VALUES (?, ?, ?, ?, ?)')
        .run([numericCardId, card.code, channel.name, phoneNumber, 'pending']);
      updateJob(numericCardId, 'success', '已获取到号码，正在等待验证码', {
        requestCount: phoneResult.requestCount || 1,
        maxRequests: phoneResult.maxRequests || maxRequests,
        attemptCounted: 1
      });
      saveDb();
      pollForCode(numericCardId, phoneNumber, refreshTime).catch(error => {
        console.error('SMS polling failed:', error.message);
      });
    } catch (error) {
      const previous = getPhoneRequestJob(numericCardId) || {};
      updateJob(numericCardId, 'failed', '获取号码失败：' + (error.message || '系统错误'), {
        requestCount: previous.request_count || 0,
        maxRequests: previous.max_requests || 1,
        attemptCounted: previous.attempt_counted || 0
      });
    } finally {
      activeJobs.delete(numericCardId);
    }
  });
}

function startPhoneRequest(cardId) {
  const numericCardId = Number(cardId);
  if (!numericCardId) throw new Error('卡密参数错误');
  const existing = getPhoneRequestJob(numericCardId);
  if (existing && (existing.state === 'queued' || existing.state === 'running')) {
    return { started: false, job: existing };
  }

  const db = getDb();
  db.prepare('DELETE FROM phone_request_jobs WHERE card_key_id=?').run([numericCardId]);
  db.prepare(`
    INSERT INTO phone_request_jobs (card_key_id, state, message, request_count, max_requests, attempt_counted)
    VALUES (?, 'queued', '正在准备筛选号码', 0, 1, 0)
  `).run([numericCardId]);
  saveDb();
  runPhoneRequest(numericCardId);
  return { started: true, job: getPhoneRequestJob(numericCardId) };
}

function resumePhoneRequestJobs() {
  const jobs = getDb().prepare("SELECT card_key_id FROM phone_request_jobs WHERE state IN ('queued', 'running') ORDER BY updated_at ASC").all();
  jobs.forEach((job, index) => {
    setTimeout(() => runPhoneRequest(job.card_key_id), index * 250);
  });
  return jobs.length;
}

module.exports = {
  getPhoneRequestJob,
  startPhoneRequest,
  resumePhoneRequestJobs
};
