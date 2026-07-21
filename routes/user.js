const express = require('express');
const { getDb } = require('../database');
const providerService = require('../api/providerService');
const { registerRejectedPhone } = require('./rejectedPhones');
const phoneRequests = require('../services/phoneRequests');

// Helper: get configurable cooldown seconds from settings
function getCooldownSeconds() {
  const db = getDb();
  const setting = db.prepare("SELECT value FROM settings WHERE key='cooldown_seconds'").get();
  const seconds = setting ? parseInt(setting.value, 10) : NaN;
  return Number.isFinite(seconds) && seconds >= 10 && seconds <= 3600 ? seconds : 60;
}

// Server-side cooldown check
function getCooldownRemaining(card) {
  if (!card.used_at) return 0;
  const cooldownSeconds = getCooldownSeconds();
  const [d, t] = card.used_at.split(' ');
  const [y, M, day] = d.split('-').map(Number);
  const [h, m, s] = t.split(':').map(Number);
  const usedTs = new Date(y, M - 1, day, h, m, s).getTime();
  const elapsed = Math.floor((Date.now() - usedTs) / 1000);
  return Math.max(0, cooldownSeconds - elapsed);
}

function formatSmsMessage(provider, message) {
  const raw = String(message || '').trim();
  if (!raw || !provider || Number(provider.strip_sms_metadata) === 0) return raw;

  // Some providers prepend transport metadata such as "170xxxxxxxx/0.4/".
  // It is not part of the received SMS and should not be shown to end users.
  return raw.replace(/^\s*(?:\+?86[-\s]?)?1\d{10}\s*\/\s*\d+(?:\.\d+)?\s*\/\s*/, '');
}

function getCardResultSnapshot(db, card) {
  if (card.phone_number) return card;

  const lastRecord = db.prepare(`
    SELECT phone_number, sms_code, sms_message
    FROM usage_records
    WHERE card_key_id = ? AND phone_number IS NOT NULL AND phone_number != ''
    ORDER BY CASE WHEN sms_code IS NOT NULL AND sms_code != '' THEN 0 ELSE 1 END, id DESC
    LIMIT 1
  `).get(card.id);

  if (!lastRecord) return card;
  return {
    ...card,
    phone_number: lastRecord.phone_number || '',
    sms_code: card.sms_code || lastRecord.sms_code || '',
    sms_message: card.sms_message || lastRecord.sms_message || ''
  };
}

function renderCardResult(res, db, channels, originalCard) {
  const card = getCardResultSnapshot(db, originalCard);
  const channel = db.prepare('SELECT name FROM channels WHERE id = ?').get(card.channel_id);

  return res.render('user/index', {
    channels,
    step: 'waiting',
    error: null,
    cardCode: card.code,
    channelId: card.channel_id,
    phoneNumber: card.phone_number || '',
    smsCode: card.sms_code || '',
    smsMessage: formatSmsMessage(
      db.prepare('SELECT ap.strip_sms_metadata FROM channels ch LEFT JOIN api_providers ap ON ap.id=ch.provider_id WHERE ch.id=?').get(card.channel_id),
      card.sms_message
    ),
    channelName: channel ? channel.name : '',
    cardId: card.id,
    attempts: card.attempts || 0,
    maxAttempts: card.max_attempts || 3,
    refreshInterval: 5000,
    cooldownRemaining: getCooldownRemaining(card),
    cooldownSeconds: getCooldownSeconds(),
    isTest: card.is_test || false
  });
}

function renderFilteringResult(res, db, channels, card, job) {
  const channel = db.prepare('SELECT name FROM channels WHERE id = ?').get(card.channel_id);
  return res.render('user/index', {
    channels,
    step: 'filtering',
    error: null,
    cardCode: card.code,
    channelId: card.channel_id,
    channelName: channel ? channel.name : '',
    cardId: card.id,
    filterMessage: job.message || '正在逐个筛选号码，请稍候',
    filterRequestCount: job.request_count || 0,
    filterMaxRequests: job.max_requests || 1,
    phoneNumber: '',
    smsCode: '',
    smsMessage: ''
  });
}

function renderStoredCardState(res, db, channels, card) {
  const job = phoneRequests.getPhoneRequestJob(card.id);
  if (job && (job.state === 'queued' || job.state === 'running')) {
    renderFilteringResult(res, db, channels, card, job);
    return true;
  }
  if (job && job.state === 'failed') {
    res.render('user/index', {
      channels,
      step: 'enter_card',
      error: job.message || '本次筛选未找到可用号码，请稍后再试',
      cardCode: card.code,
      channelId: '',
      phoneNumber: '',
      smsCode: '',
      smsMessage: '',
      channelName: ''
    });
    return true;
  }
  const snapshot = getCardResultSnapshot(db, card);
  if (snapshot.phone_number) {
    renderCardResult(res, db, channels, card);
    return true;
  }
  return false;
}

function getCardResultUrl(code) {
  return '/?card=' + encodeURIComponent(String(code || '').trim().toUpperCase());
}


function getPrefixRequestOptions(card, channel) {
  return {
    enabled: channel.prefix_enabled,
    maxRequests: channel.prefix_max_requests,
    requestIntervalMs: channel.prefix_request_interval_ms,
    onRejected(phone, attempt, rejection) {
      registerRejectedPhone({
        cardId: card.id,
        channelId: channel.id,
        phone,
        channelName: channel.name,
        reason: rejection && rejection.reason
      });
    }
  };
}

// Test card: auto-generate SMS code after 30 seconds
function startTestCardSmsTimer(cardId) {
  setTimeout(function() {
    try {
      const db = getDb();
      const card = db.prepare('SELECT id, is_test, phone_number, sms_code FROM card_keys WHERE id=?').get([cardId]);
      if (!card || !card.is_test) return;
      if (card.sms_code) return; // already has code

      const fakeCode = String(Math.floor(100000 + Math.random() * 900000));
      const fakeMessage = '【测试平台】您的验证码是' + fakeCode + '，30分钟内有效';

      db.prepare('UPDATE card_keys SET sms_code=?, sms_message=? WHERE id=?').run([fakeCode, fakeMessage, cardId]);
      db.prepare("UPDATE card_keys SET status='used' WHERE id=? AND sms_code IS NOT NULL AND sms_code != ''").run([cardId]);
      db.prepare("UPDATE usage_records SET sms_code=?, sms_message=?, status='completed' WHERE card_key_id=? AND status='pending'").run([fakeCode, fakeMessage, cardId]);
    } catch(e) {
      console.error('Test card SMS timer error:', e.message);
    }
  }, 30000);
}

const router = express.Router();

router.use((req, res, next) => {
  try {
    const setting = getDb().prepare("SELECT value FROM settings WHERE key='site_name'").get();
    res.locals.siteName = setting && String(setting.value || '').trim()
      ? String(setting.value).trim()
      : '卡密接码';
  } catch (e) {
    res.locals.siteName = '卡密接码';
  }
  next();
});

// Check card info (auto-match project)
router.get('/check-card', (req, res) => {
  const db = getDb();
  const code = (req.query.code || '').trim().toUpperCase();
  if (code.length < 8) return res.json({ found: false });
  const card = db.prepare(`
    SELECT ck.code, ck.status, ck.attempts, ck.max_attempts, ck.is_test, ck.phone_number, ck.sms_code, ch.name as channel_name
    FROM card_keys ck
    LEFT JOIN channels ch ON ck.channel_id = ch.id
    WHERE ck.code = ?
  `).get([code]);
  if (card && card.channel_name) {
    const maxAtt = card.max_attempts || 3;
    if (card.sms_code) {
      return res.json({ found: true, channel_name: card.channel_name, status: '已使用，可查看最后的手机号和验证码', can_use: false, can_view: true, is_test: card.is_test });
    }
    if (card.phone_number) {
      return res.json({ found: true, channel_name: card.channel_name, status: '已有手机号，可继续查看', can_use: false, can_view: true, is_test: card.is_test });
    }
    if (card.attempts >= maxAtt) {
      return res.json({ found: true, channel_name: card.channel_name, status: '次数已用完（' + card.attempts + '/' + maxAtt + '）', can_use: false, is_test: card.is_test });
    }
    return res.json({ found: true, channel_name: card.channel_name, status: '可用（' + (card.attempts || 0) + '/' + maxAtt + '）', can_use: true });
  }
  res.json({ found: false });
});

// Check card status by ID (used for localStorage recovery after tab close)
router.get('/check-card-status/:cardId', (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT id, code, phone_number, sms_code, attempts, max_attempts, status, channel_id FROM card_keys WHERE id=?').get(req.params.cardId);
  if (!card) return res.json({ found: false });
  if (card.phone_number) {
    const channel = db.prepare('SELECT name FROM channels WHERE id=?').get(card.channel_id);
    const channelName = channel ? channel.name : '';
    return res.json({ found: true, active: true, phoneNumber: card.phone_number, smsCode: card.sms_code || '', channelName, cardCode: card.code });
  }
  const channel = db.prepare('SELECT name FROM channels WHERE id=?').get(card.channel_id);
  return res.json({ found: true, active: false, channelName: channel ? channel.name : '' });
});

// Check card status by code (used for localStorage recovery with card key)
router.get('/check-card-status-by-code/:code', (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT * FROM card_keys WHERE code = ?').get(req.params.code.trim().toUpperCase());
  if (!card) return res.json({ found: false });
  if (card.phone_number) {
    const channel = db.prepare('SELECT name FROM channels WHERE id=?').get(card.channel_id);
    const channelName = channel ? channel.name : '';
    return res.json({ found: true, active: true, phoneNumber: card.phone_number, smsCode: card.sms_code || '', channelName, cardCode: card.code });
  }
  const channel = db.prepare('SELECT name FROM channels WHERE id=?').get(card.channel_id);
  return res.json({ found: true, active: false, channelName: channel ? channel.name : '' });
});

// User home page - enter card key
router.get('/', (req, res) => {
  const db = getDb();
  const channels = db.prepare('SELECT id, name FROM channels WHERE is_active=1').all();
  const exitRequested = req.query.exit === '1';

  // An explicit exit must not be restored by the server-side last-card session.
  if (exitRequested) delete req.session.lastCardId;

  // If card_id is provided (e.g. refresh during cooldown), restore waiting state
  // More secure: accept ?card=CODE (card key, not numeric ID)
  const cardCode = req.query.card;
  if (cardCode) {
    const card = db.prepare('SELECT * FROM card_keys WHERE code = ?').get(cardCode.trim().toUpperCase());
    if (card) {
      if (renderStoredCardState(res, db, channels, card)) return;
    } else {
      return res.render('user/index', {
        channels, step: 'enter_card', error: '卡密不存在或已被删除',
        cardCode: cardCode.trim().toUpperCase(), channelId: '',
        phoneNumber: '', smsCode: '', smsMessage: '', channelName: ''
      });
    }
  }
 
  const cardId = req.query.card_id;
  if (cardId) {
    const card = db.prepare('SELECT * FROM card_keys WHERE id = ?').get(cardId);
    if (card) {
      if (renderStoredCardState(res, db, channels, card)) return;
    }
  }

  // Fallback: card_id from session (user closed tab and came back)
  if (!exitRequested && !cardId && req.session.lastCardId) {
    const card = db.prepare('SELECT * FROM card_keys WHERE id = ?').get(req.session.lastCardId);
    if (card) {
      if (renderStoredCardState(res, db, channels, card)) return;
    }
  }

  res.render('user/index', {
    channels,
    step: 'enter_card',
    error: null,
    cardCode: '',
    channelId: '',
    phoneNumber: '',
    smsCode: '',
    smsMessage: '',
    channelName: ''
  });
});

// A refreshed legacy POST result can otherwise land on a missing GET route.
// Send it back through the stable card-aware home page instead.
router.get('/redeem', (req, res) => {
  res.redirect(302, '/');
});

// Redeem card key - Step 1: validate card
router.post('/redeem', async (req, res) => {
  const db = getDb();
  const channels = db.prepare('SELECT id, name FROM channels WHERE is_active=1').all();
  const { card_code } = req.body;

  const normalizedCode = card_code.trim().toUpperCase();

  const card = db.prepare('SELECT * FROM card_keys WHERE code = ?').get(normalizedCode);
  if (!card) {
    return res.render('user/index', {
      channels, step: 'enter_card', error: '卡密不存在',
      cardCode: card_code, channelId: '',
      phoneNumber: '', smsCode: '', smsMessage: '', channelName: ''
    });
  }

  const resultSnapshot = getCardResultSnapshot(db, card);
  if (resultSnapshot.phone_number) {
    req.session.lastCardId = card.id;
    return res.redirect(303, getCardResultUrl(card.code));
  }

  if (card.sms_code) {
    return res.render('user/index', {
      channels, step: 'enter_card', error: '该卡密已使用，但没有可查看的手机号记录',
      cardCode: '', channelId: '',
      phoneNumber: '', smsCode: '', smsMessage: '', channelName: ''
    });
  }

  const maxAtt = card.max_attempts || 3;
  if (card.attempts >= maxAtt) {
    return res.render('user/index', {
      channels, step: 'enter_card', error: '卡密使用次数已用完（' + card.attempts + '/' + maxAtt + '）',
      cardCode: card_code, channelId: '',
      phoneNumber: '', smsCode: '', smsMessage: '', channelName: ''
    });
  }

  const cooldownRemaining = getCooldownRemaining(card);
  if (cooldownRemaining > 0) {
    return res.render('user/index', {
      channels, step: 'enter_card', error: '冷却中，请等待 ' + cooldownRemaining + ' 秒后再获取新号码',
      cardCode: card_code, channelId: '', phoneNumber: card.phone_number || '',
      smsCode: '', smsMessage: '', channelName: ''
    });
  }

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(card.channel_id);
  if (!channel || !channel.is_active) {
    return res.render('user/index', {
      channels, step: 'enter_card', error: '项目不可用',
      cardCode: card_code, channelId: '',
      phoneNumber: '', smsCode: '', smsMessage: '', channelName: ''
    });
  }

  // ===== Test card: skip qc86 API =====
  if (card.is_test) {
    const fakePhone = '1380000' + String(card.id).padStart(4, '0');
    db.prepare(`
      UPDATE card_keys
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= CASE WHEN max_attempts IS NULL OR max_attempts < 1 THEN 3 ELSE max_attempts END THEN 'used' ELSE status END
      WHERE id=?
    `).run([card.id]);
    db.prepare("UPDATE card_keys SET phone_number=?, used_at=datetime('now','localtime') WHERE id=?").run([fakePhone, card.id]);
    db.prepare('INSERT INTO usage_records (card_key_id, card_code, channel_name, phone_number, status) VALUES (?, ?, ?, ?, ?)').run([card.id, normalizedCode, channel.name, fakePhone, 'pending']);

    // Start 30s timer for test card SMS
    startTestCardSmsTimer(card.id);

    req.session.lastCardId = card.id;

    return res.redirect(303, getCardResultUrl(normalizedCode));
  }

  try {
    phoneRequests.startPhoneRequest(card.id);
    req.session.lastCardId = card.id;
    return res.redirect(303, getCardResultUrl(normalizedCode));
  } catch (e) {
    return res.render('user/index', {
      channels, step: 'enter_card', error: '系统错误: ' + e.message,
      cardCode: card_code, channelId: '',
      phoneNumber: '', smsCode: '', smsMessage: '', channelName: ''
    });
  }
});

// Poll for SMS code (called via AJAX)
router.get('/check-sms/:cardId', (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT phone_number, sms_code, sms_message FROM card_keys WHERE id = ?').get(req.params.cardId);
  if (!card) return res.json({ found: false });
  res.json({
    found: card.sms_code ? true : false,
    phoneNumber: card.phone_number,
    smsCode: card.sms_code,
    smsMessage: card.sms_message
  });
});

// Browser-safe polling endpoint for long-running prefix filtering.
// The actual provider requests run in the background, so this responds quickly.
router.get('/phone-request-status/:cardId', (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT id, code, phone_number, attempts, max_attempts FROM card_keys WHERE id=?').get(req.params.cardId);
  if (!card) return res.json({ found: false });
  const job = phoneRequests.getPhoneRequestJob(card.id);
  res.json({
    found: true,
    state: job ? job.state : (card.phone_number ? 'success' : 'idle'),
    message: job ? job.message : '',
    requestCount: job ? job.request_count : 0,
    maxRequests: job ? job.max_requests : 1,
    phoneNumber: card.phone_number || '',
    attempts: card.attempts || 0,
    maxAttempts: card.max_attempts || 3,
    cardCode: card.code
  });
});

// Blacklist and release - for cleanup when user is done
router.post('/cleanup', async (req, res) => {
  const db = getDb();
  const { card_id, phone_number } = req.body;
  const card = db.prepare('SELECT * FROM card_keys WHERE id = ?').get(card_id);
  if (!card) return res.json({ success: false, msg: 'no card found' });
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(card.channel_id);
  if (!channel) return res.json({ success: false, msg: 'no channel' });

  try {
    const provider = providerService.getProviderForChannel(channel);
    const token = card.token || await providerService.getToken(provider);
    await providerService.blacklistPhone(provider, channel, token, phone_number || card.phone_number);
    await providerService.releasePhone(provider, channel, token, phone_number || card.phone_number);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

// Get a new phone number (without re-entering card) - supports up to 3 numbers per card
router.post('/get-new-phone', async (req, res) => {
  const db = getDb();
  const { card_id } = req.body;

  const card = db.prepare('SELECT * FROM card_keys WHERE id = ?').get(card_id);
  if (!card) return res.json({ success: false, error: '卡密不存在' });
  if (card.sms_code) return res.json({ success: false, error: '卡密已使用（已验证码已获取）' });

  const maxAtt = card.max_attempts || 3;
  if (card.attempts >= maxAtt) {
    return res.json({ success: false, error: '获取次数已用完（' + card.attempts + '/' + maxAtt + '）' });
  }

  const cooldownRemaining = getCooldownRemaining(card);
  if (cooldownRemaining > 0) {
    return res.json({
      success: false,
      error: '冷却中，请等待 ' + cooldownRemaining + ' 秒后再获取新号码',
      currentPhone: card.phone_number || '',
      cooldownRemaining,
      cooldownSeconds: getCooldownSeconds(),
      attempts: card.attempts || 0,
      maxAttempts: maxAtt
    });
  }

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(card.channel_id);
  if (!channel || !channel.is_active) return res.json({ success: false, error: '项目不可用' });

  // ===== Test card: skip qc86 API =====
  if (card.is_test) {
    const fakePhone = '1380000' + String(card.id).padStart(4, '0');
    db.prepare(`
      UPDATE card_keys
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= CASE WHEN max_attempts IS NULL OR max_attempts < 1 THEN 3 ELSE max_attempts END THEN 'used' ELSE status END
      WHERE id=?
    `).run([card.id]);
    db.prepare("UPDATE card_keys SET phone_number=?, used_at=datetime('now','localtime') WHERE id=?").run([fakePhone, card.id]);

    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(card.channel_id);
    db.prepare('INSERT INTO usage_records (card_key_id, card_code, channel_name, phone_number, status) VALUES (?, ?, ?, ?, ?)').run([card.id, card.code, ch ? ch.name : '测试', fakePhone, 'pending']);

    // Start 30s timer for test card SMS
    startTestCardSmsTimer(card.id);

    const updatedCard = db.prepare('SELECT * FROM card_keys WHERE id=?').get(card.id);

    return res.json({
      success: true,
      phoneNumber: fakePhone,
      attempts: updatedCard.attempts,
      maxAttempts: maxAtt,
      cooldownSeconds: getCooldownSeconds(),
      cooldownRemaining: getCooldownRemaining(updatedCard)
    });
  }

  try {
    const request = phoneRequests.startPhoneRequest(card.id);
    return res.json({
      success: true,
      pending: true,
      started: request.started,
      cardCode: card.code,
      attempts: card.attempts || 0,
      maxAttempts: maxAtt
    });
  } catch (e) {
    res.json({ success: false, error: '系统错误: ' + e.message });
  }
});

// Background polling function
async function pollForCode(cardId, phoneNumber, interval) {
  const db_check = getDb();
  const card_check = db_check.prepare('SELECT is_test FROM card_keys WHERE id=?').get([cardId]);
  if (card_check && card_check.is_test) return;

  const db = getDb();
  const timeoutSetting = (db.prepare("SELECT value FROM settings WHERE key='release_timeout'").get() || {}).value || '5';
  const timeoutMinutes = parseInt(timeoutSetting) || 5;
  const pollInterval = Math.max(interval || 5000, 3000);
  const maxAttempts = Math.ceil(timeoutMinutes * 60 * 1000 / pollInterval);
  const maxAttSetting = (db.prepare('SELECT max_attempts FROM card_keys WHERE id=?').get([cardId]) || {}).max_attempts || 3;
  const card = db.prepare('SELECT * FROM card_keys WHERE id=?').get([cardId]);
  if (!card) return;
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

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await providerService.getCode(provider, channel, token, phoneNumber);
      if (result && result.success && result.data && result.data.code) {
        const smsCode = result.data.code;
        const smsMessage = formatSmsMessage(provider, result.data.modle || '');

        db.prepare('UPDATE card_keys SET sms_code=?, sms_message=? WHERE id=?').run([smsCode, smsMessage, cardId]);
        db.prepare("UPDATE card_keys SET status='used' WHERE id=? AND sms_code IS NOT NULL AND sms_code != ''").run([cardId]);
        db.prepare("UPDATE usage_records SET sms_code=?, sms_message=?, status='completed' WHERE card_key_id=? AND status='pending'").run([smsCode, smsMessage, cardId]);

        try {
          await providerService.blacklistPhone(provider, channel, token, phoneNumber);
          await providerService.releasePhone(provider, channel, token, phoneNumber);
        } catch (e) { /* ignore cleanup errors */ }

        return;
      }
    } catch (e) {
      // continue polling
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  db.prepare("UPDATE card_keys SET phone_number='', token='', sms_task_id='' WHERE id=? AND (sms_code IS NULL OR sms_code = '')").run([cardId]);
  try {
    await providerService.blacklistPhone(provider, channel, token, phoneNumber);
    await providerService.releasePhone(provider, channel, token, phoneNumber);
  } catch (e) { /* ignore */ }

  db.prepare("UPDATE usage_records SET status='timeout' WHERE card_key_id=? AND status='pending'").run([cardId]);
}

module.exports = router;
