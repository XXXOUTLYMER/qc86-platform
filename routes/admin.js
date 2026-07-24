const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, saveDb, createSyncPackage, importSyncPackage } = require('../database');
const { requireAdmin } = require('../middleware/auth');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const qc86 = require('../api/qc86');
const { getPhoneWithPrefix } = qc86;
const providerService = require('../api/providerService');
const { extractProviderBalance } = require('../api/providerBalance');
const uoomsg = require('../api/uoomsg');
const { registerRejectedPhone, releaseRejectedPhone } = require('./rejectedPhones');
const { generateCardCode } = require('../services/cardKeyCodes');
const { createBatchId, groupCardsByBatch, normalizeBatchId } = require('../services/cardBatches');
const githubPublisher = require('../services/githubPublisher');

const router = express.Router();

function requireBetaPublisher(req, res, next) {
  if (config.app.stage !== 'beta') return res.status(404).send('Page not found');
  next();
}

function normalizePrefixEnabled(value) {
  if (Array.isArray(value)) return value.includes('1') ? 1 : 0;
  return value === true || value === '1' || value === 'on' ? 1 : 0;
}

function normalizePrefixFilterMode(value, legacyEnabled) {
  if (value === 'include' || value === 'exclude' || value === 'disabled') return value;
  return normalizePrefixEnabled(legacyEnabled) ? 'include' : 'disabled';
}

function normalizePrefixMaxRequests(value) {
  const parsed = parseInt(value, 10);
  return Math.min(20, Math.max(1, Number.isFinite(parsed) ? parsed : 20));
}

function normalizePrefixConcurrency(value) {
  const parsed = parseInt(value, 10);
  return Math.min(10, Math.max(1, Number.isFinite(parsed) ? parsed : 1));
}

function normalizePrefixRequestIntervalMs(value) {
  const parsedSeconds = parseFloat(value);
  const intervalMs = Number.isFinite(parsedSeconds) ? Math.round(parsedSeconds * 1000) : 500;
  return Math.min(10000, Math.max(500, intervalMs));
}

function normalizeDirectScope(value) {
  const scope = String(value || '').trim();
  if (!scope) return '';
  if (!/^\d{1,11}$/.test(scope)) {
    throw new Error('API 直接指定号段只能填写 1 至 11 位数字，例如：170');
  }
  return scope;
}

function submittedOrExisting(body, key, existingValue) {
  return Object.prototype.hasOwnProperty.call(body || {}, key) ? body[key] : existingValue;
}

function verifySavedDirectScope(db, channelId, expectedScope) {
  const savedChannel = db.prepare('SELECT id, direct_scope FROM channels WHERE id=?').get([channelId]);
  if (!savedChannel) throw new Error('项目保存后不存在，可能已被删除');
  if (String(savedChannel.direct_scope || '') !== String(expectedScope || '')) {
    throw new Error('API 指定号段没有写入数据库，请刷新页面后重试');
  }
  return savedChannel;
}

function normalizeCooldownSeconds(value) {
  const parsed = parseInt(value, 10);
  return Math.min(3600, Math.max(10, Number.isFinite(parsed) ? parsed : 60));
}

function normalizeReleaseTimeoutMinutes(value) {
  const parsed = parseInt(value, 10);
  return Math.min(60, Math.max(1, Number.isFinite(parsed) ? parsed : 5));
}

function normalizeUsageRecordRetentionDays(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(3650, Math.max(1, parsed));
}

function normalizeCleanupAgeDays(value, fallback = 7) {
  const parsed = parseInt(value, 10);
  return Math.min(3650, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function normalizeCardAttempts(value, fallback) {
  const parsed = parseInt(value, 10);
  return Math.min(100, Math.max(0, Number.isFinite(parsed) ? parsed : fallback));
}

function normalizeCardMaxAttempts(value, fallback) {
  const parsed = parseInt(value, 10);
  return Math.min(100, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function deleteUsageRecordsBefore(db, retentionDays) {
  const days = normalizeUsageRecordRetentionDays(retentionDays);
  if (days === 0) return 0;
  const count = db.prepare("SELECT COUNT(*) AS c FROM usage_records WHERE created_at < datetime('now', 'localtime', '-' || ? || ' days')")
    .get([days]).c;
  if (count > 0) {
    db.prepare("DELETE FROM usage_records WHERE created_at < datetime('now', 'localtime', '-' || ? || ' days')")
      .run([days]);
    db.exec('VACUUM');
  }
  return count;
}

function countCleanupRows(db, sql, params = []) {
  return Number((db.prepare(sql).get(params) || {}).c || 0);
}

function getCleanupStats(db, retentionDays) {
  const retention = normalizeUsageRecordRetentionDays(retentionDays);
  const terminalJobStates = "('success', 'failed')";
  return {
    usageRecords: countCleanupRows(db, 'SELECT COUNT(*) AS c FROM usage_records'),
    expiredUsageRecords: retention > 0
      ? countCleanupRows(db, "SELECT COUNT(*) AS c FROM usage_records WHERE created_at < datetime('now', 'localtime', '-' || ? || ' days')", [retention])
      : 0,
    releasedRejected: countCleanupRows(db, 'SELECT COUNT(*) AS c FROM rejected_phones WHERE released=1'),
    pendingRejected: countCleanupRows(db, 'SELECT COUNT(*) AS c FROM rejected_phones WHERE released=0'),
    finishedJobs: countCleanupRows(db, `SELECT COUNT(*) AS c FROM phone_request_jobs WHERE state IN ${terminalJobStates}`),
    activeJobs: countCleanupRows(db, "SELECT COUNT(*) AS c FROM phone_request_jobs WHERE state IN ('queued', 'running')")
  };
}

function getProviders(db, activeOnly = false) {
  return db.prepare(`
    SELECT ap.*, COUNT(ch.id) AS channel_count
    FROM api_providers ap
    LEFT JOIN channels ch ON ch.provider_id = ap.id
    ${activeOnly ? 'WHERE ap.is_active=1' : ''}
    GROUP BY ap.id
    ORDER BY ap.is_system DESC, ap.id DESC
  `).all();
}

function renderChannels(res, req, db, error = null) {
  const channels = db.prepare(`
    SELECT ch.*, ap.name AS provider_name, ap.provider_type
    FROM channels ch
    LEFT JOIN api_providers ap ON ap.id = ch.provider_id
    ORDER BY ch.id DESC
  `).all();
  res.render('admin/channels', {
    admin: req.session.admin,
    channels,
    providers: getProviders(db, true),
    error,
    success: req.query.success || null
  });
}

// Admin login page
router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/dashboard');
  res.render('admin/login', { error: null });
});

// Admin login handler
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get([username]);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.render('admin/login', { error: '用户名或密码错误' });
  }
  req.session.admin = { id: admin.id, username: admin.username };
  res.redirect('/admin/dashboard');
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// Account security
router.get('/account', requireAdmin, (req, res) => {
  res.render('admin/account', {
    admin: req.session.admin,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/account/password', requireAdmin, (req, res) => {
  const db = getDb();
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');
  const admin = db.prepare('SELECT * FROM admins WHERE id=?').get([req.session.admin.id]);

  function redirectError(message) {
    return res.redirect('/admin/account?error=' + encodeURIComponent(message));
  }

  if (!admin || !bcrypt.compareSync(currentPassword, admin.password_hash)) {
    return redirectError('当前密码不正确');
  }
  if (newPassword.length < 8) {
    return redirectError('新密码至少需要 8 个字符');
  }
  if (newPassword !== confirmPassword) {
    return redirectError('两次输入的新密码不一致');
  }
  if (bcrypt.compareSync(newPassword, admin.password_hash)) {
    return redirectError('新密码不能与当前密码相同');
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run([passwordHash, admin.id]);
  saveDb();
  res.redirect('/admin/account?success=' + encodeURIComponent('管理员密码已更新'));
});

// Data sync center. Packages contain operational data only; administrator
// accounts and in-progress phone sessions intentionally stay local.
router.get('/sync', requireAdmin, (req, res) => {
  const db = getDb();
  const countRows = table => {
    try {
      return db.prepare('SELECT COUNT(*) AS c FROM "' + table + '"').get().c;
    } catch (error) {
      return 0;
    }
  };

  try {
    res.render('admin/sync', {
      admin: req.session.admin,
      stats: {
        providers: countRows('api_providers'),
        projects: countRows('channels'),
        cards: countRows('card_keys'),
        records: countRows('usage_records'),
        rejected: countRows('rejected_phones')
      },
      pageError: null
    });
  } catch (error) {
    // Keep the administrator inside the backend if an old database or a
    // partially-upgraded template has a problem. A useful message is much
    // better than Express returning an empty white screen.
    res.status(500).render('admin/sync', {
      admin: req.session.admin,
      stats: { providers: 0, projects: 0, cards: 0, records: 0, rejected: 0 },
      pageError: '同步中心暂时无法读取完整数据：' + (error.message || '未知错误')
    });
  }
});

router.get('/sync/export', requireAdmin, (req, res) => {
  try {
    const syncPackage = createSyncPackage();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="qc86-data-sync-' + date + '.json"');
    res.send(JSON.stringify(syncPackage, null, 2));
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || '导出同步包失败' });
  }
});

router.post('/sync/import', requireAdmin, (req, res) => {
  if (String(req.body.confirmation || '') !== 'SYNC') {
    return res.status(400).json({ success: false, error: '请确认导入操作后再试' });
  }

  try {
    const result = importSyncPackage(req.body.syncPackage);
    res.json({
      success: true,
      message: '数据已同步完成。导入前的 NAS 数据库已自动备份。',
      backupFilename: result.backupFilename,
      stats: result.stats
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || '导入同步包失败' });
  }
});

// This center is deliberately only available on the local Beta instance.
// The production/NAS process never receives a route that can execute Git.
router.get('/publish', requireAdmin, requireBetaPublisher, async (req, res) => {
  try {
    const gitStatus = await githubPublisher.getGitStatus();
    res.render('admin/publish', {
      admin: req.session.admin,
      gitStatus,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (error) {
    res.status(500).render('admin/publish', {
      admin: req.session.admin,
      gitStatus: null,
      success: null,
      error: error.message || '暂时无法读取本地 Git 状态'
    });
  }
});

router.post('/publish/beta', requireAdmin, requireBetaPublisher, async (req, res) => {
  try {
    const result = await githubPublisher.publishBeta();
    const text = result.createdCommit
      ? `Beta 已发布到 GitHub，共提交 ${result.files.length} 个文件。`
      : 'Beta 已发布到 GitHub，本地没有新的文件改动。';
    res.redirect('/admin/publish?success=' + encodeURIComponent(text));
  } catch (error) {
    res.redirect('/admin/publish?error=' + encodeURIComponent(error.message || 'Beta 发布失败'));
  }
});

router.post('/publish/release', requireAdmin, requireBetaPublisher, async (req, res) => {
  try {
    const result = await githubPublisher.publishRelease(req.body.version);
    const text = result.createdCommit
      ? `正式版 ${result.version} 已发布到 GitHub，共提交 ${result.files.length} 个文件。`
      : `正式版 ${result.version} 已发布到 GitHub。`;
    res.redirect('/admin/publish?success=' + encodeURIComponent(text));
  } catch (error) {
    res.redirect('/admin/publish?error=' + encodeURIComponent(error.message || '正式版发布失败'));
  }
});

// Dashboard
router.get('/dashboard', requireAdmin, (req, res) => {
  const db = getDb();
  const channelCount = db.prepare('SELECT COUNT(*) as c FROM channels').get().c;
  const cardTotal = db.prepare('SELECT COUNT(*) as c FROM card_keys').get().c;
  const cardUsed = db.prepare("SELECT COUNT(*) as c FROM card_keys WHERE status='used'").get().c;
  const cardUnused = db.prepare("SELECT COUNT(*) as c FROM card_keys WHERE status='unused'").get().c;
  const recordToday = db.prepare("SELECT COUNT(*) as c FROM usage_records WHERE date(created_at)=date('now','localtime')").get().c;
  res.render('admin/dashboard', {
    admin: req.session.admin, channelCount, cardTotal, cardUsed, cardUnused, recordToday
  });
});

// API provider management
router.get('/api-providers', requireAdmin, (req, res) => {
  const db = getDb();
  const channels = db.prepare(`
    SELECT ch.id, ch.name, ch.channel_id, ch.operator, ch.scope, ch.direct_scope, ch.api_keyword,
           ap.id AS provider_id, ap.name AS provider_name, ap.provider_type
    FROM channels ch
    JOIN api_providers ap ON ap.id=ch.provider_id
    WHERE ch.is_active=1 AND ap.is_active=1
    ORDER BY ch.id DESC
  `).all();
  const uoomsgProviders = db.prepare(`
    SELECT id, name
    FROM api_providers
    WHERE provider_type='uoomsg' AND is_active=1
    ORDER BY id DESC
  `).all();
  res.render('admin/api-providers', {
    admin: req.session.admin,
    providers: getProviders(db),
    channels,
    uoomsgProviders,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post('/api-providers/add', requireAdmin, (req, res) => {
  const db = getDb();
  const type = req.body.provider_type === 'uoomsg' ? 'uoomsg' : 'qc86';
  const defaultBaseUrl = type === 'uoomsg' ? uoomsg.DEFAULT_BASE_URL : config.qc86.baseUrl;
  if (!String(req.body.name || '').trim()) {
    return res.redirect('/admin/api-providers?error=' + encodeURIComponent('请填写服务商名称'));
  }
  if (type === 'uoomsg' && !String(req.body.token || '').trim()) {
    return res.redirect('/admin/api-providers?error=' + encodeURIComponent('uoomsg 必须填写 API Token'));
  }
  db.prepare(`
    INSERT INTO api_providers (name, provider_type, base_url, username, password, token, description, is_active, strip_sms_metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run([
    String(req.body.name).trim(),
    type,
    String(req.body.base_url || defaultBaseUrl).trim(),
    String(req.body.username || '').trim(),
    String(req.body.password || ''),
    String(req.body.token || '').trim(),
    String(req.body.description || '').trim(),
    req.body.is_active === '0' ? 0 : 1,
    req.body.strip_sms_metadata === '1' ? 1 : 0
  ]);
  saveDb();
  res.redirect('/admin/api-providers?success=' + encodeURIComponent('API 服务商添加成功'));
});

router.post('/api-providers/edit/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const current = db.prepare('SELECT * FROM api_providers WHERE id=?').get([req.params.id]);
  if (!current) return res.redirect('/admin/api-providers?error=' + encodeURIComponent('服务商不存在'));
  const type = req.body.provider_type === 'uoomsg' ? 'uoomsg' : 'qc86';
  const resolvedType = current.is_system ? 'qc86' : type;
  const typeChanged = current.provider_type !== resolvedType;
  const defaultBaseUrl = resolvedType === 'uoomsg' ? uoomsg.DEFAULT_BASE_URL : config.qc86.baseUrl;
  const submittedUsername = String(req.body.username || '').trim();
  const submittedPassword = String(req.body.password || '');
  const submittedToken = String(req.body.token || '').trim();
  const username = typeChanged ? submittedUsername : submittedUsername || current.username || '';
  const password = typeChanged ? submittedPassword : submittedPassword || current.password || '';
  const token = typeChanged ? submittedToken : submittedToken || current.token || '';
  if (resolvedType === 'uoomsg' && !token) {
    return res.redirect('/admin/api-providers?error=' + encodeURIComponent('uoomsg 必须填写 API Token'));
  }
  db.prepare(`
    UPDATE api_providers
    SET name=?, provider_type=?, base_url=?, username=?, password=?, token=?, description=?, is_active=?, strip_sms_metadata=?
    WHERE id=?
  `).run([
    String(req.body.name || current.name).trim(),
    resolvedType,
    String(req.body.base_url || defaultBaseUrl).trim(),
    username,
    password,
    token,
    String(req.body.description || '').trim(),
    req.body.is_active === '0' ? 0 : 1,
    req.body.strip_sms_metadata === '1' ? 1 : 0,
    current.id
  ]);
  if (current.is_system) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qc86_username', ?)").run([username]);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qc86_password', ?)").run([password]);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qc86_token', ?)").run([token]);
  }
  saveDb();
  res.redirect('/admin/api-providers?success=' + encodeURIComponent('API 服务商保存成功'));
});

router.post('/api-providers/delete/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const provider = db.prepare('SELECT * FROM api_providers WHERE id=?').get([req.params.id]);
  if (!provider) return res.redirect('/admin/api-providers?error=' + encodeURIComponent('服务商不存在'));
  if (provider.is_system) return res.redirect('/admin/api-providers?error=' + encodeURIComponent('原有 qc86 服务商不能删除'));
  const count = db.prepare('SELECT COUNT(*) AS count FROM channels WHERE provider_id=?').get([provider.id]).count;
  if (count > 0) return res.redirect('/admin/api-providers?error=' + encodeURIComponent('仍有项目绑定此服务商，请先修改项目绑定'));
  db.prepare('DELETE FROM api_providers WHERE id=?').run([provider.id]);
  saveDb();
  res.redirect('/admin/api-providers?success=' + encodeURIComponent('API 服务商已删除'));
});

router.post('/api-providers/test/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const provider = db.prepare('SELECT * FROM api_providers WHERE id=?').get([req.params.id]);
  if (!provider) return res.json({ success: false, error: '服务商不存在' });
  try {
    const result = await providerService.getBalance(provider);
    const balance = extractProviderBalance(result);
    const hasBalance = balance !== null && balance !== undefined && balance !== '';
    res.json({
      success: true,
      balance,
      message: hasBalance
        ? ''
        : provider.provider_type === 'qc86'
          ? 'QC86 连接成功，Token 已验证。该账户的余额接口未返回余额字段，不影响取号、取码或 API 指定号段。'
          : '连接成功，但服务商未返回余额数值'
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Channel management
router.get('/channels', requireAdmin, (req, res) => {
  const db = getDb();
  renderChannels(res, req, db);
});

router.post('/channels/add', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, channel_id, operator, scope, prefix, description, api_keyword, api_phone, api_province, api_card_type } = req.body;
  const provider = db.prepare('SELECT * FROM api_providers WHERE id=? AND is_active=1').get([req.body.provider_id]);
  if (!provider) return renderChannels(res, req, db, '请选择有效的 API 服务商');
  if (provider.provider_type === 'qc86' && !String(channel_id || '').trim()) return renderChannels(res, req, db, 'qc86 项目必须填写 channelId');
  if (provider.provider_type === 'uoomsg' && !String(api_keyword || '').trim()) return renderChannels(res, req, db, 'uoomsg 项目必须填写短信关键词');
  const prefixFilterMode = normalizePrefixFilterMode(req.body.prefix_filter_mode, req.body.prefix_enabled);
  const prefixEnabled = prefixFilterMode === 'disabled' ? 0 : 1;
  const prefixMaxRequests = normalizePrefixMaxRequests(req.body.prefix_max_requests);
  const prefixConcurrency = Math.min(prefixMaxRequests, normalizePrefixConcurrency(req.body.prefix_concurrency));
  const prefixRequestIntervalMs = normalizePrefixRequestIntervalMs(req.body.prefix_request_interval_seconds);
  try {
    const directScope = provider.provider_type === 'qc86' ? normalizeDirectScope(req.body.direct_scope) : '';
    db.prepare(`
      INSERT INTO channels (name, channel_id, provider_id, api_keyword, api_phone, api_province, api_card_type, operator, scope, direct_scope, prefix, prefix_enabled, prefix_filter_mode, prefix_max_requests, prefix_concurrency, prefix_request_interval_ms, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run([
      name,
      String(channel_id || '').trim(),
      provider.id,
      String(api_keyword || '').trim(),
      String(api_phone || '').trim(),
      String(api_province || '').trim(),
      ['实卡', '虚卡', '全部'].includes(api_card_type) ? api_card_type : '全部',
      parseInt(operator || 0),
      scope || '',
      directScope,
      String(prefix || '').trim(),
      prefixEnabled,
      prefixFilterMode,
      prefixMaxRequests,
      prefixConcurrency,
      prefixRequestIntervalMs,
      description || ''
    ]);
    saveDb();
    res.redirect('/admin/channels?success=添加成功');
  } catch (e) {
    renderChannels(res, req, db, '添加失败: ' + e.message);
  }
});

router.post('/channels/edit/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const currentChannel = db.prepare('SELECT * FROM channels WHERE id=?').get([req.params.id]);
  if (!currentChannel) return renderChannels(res, req, db, '项目不存在，可能已被删除');

  // Mobile browsers or a provider-specific UI can omit a hidden field. Keep the
  // existing value in that case, while still allowing an intentionally blank
  // submitted value to clear the setting.
  const providerId = submittedOrExisting(req.body, 'provider_id', currentChannel.provider_id);
  const name = submittedOrExisting(req.body, 'name', currentChannel.name);
  const channelId = submittedOrExisting(req.body, 'channel_id', currentChannel.channel_id);
  const operator = submittedOrExisting(req.body, 'operator', currentChannel.operator);
  const scope = submittedOrExisting(req.body, 'scope', currentChannel.scope);
  const prefix = submittedOrExisting(req.body, 'prefix', currentChannel.prefix);
  const description = submittedOrExisting(req.body, 'description', currentChannel.description);
  const isActive = submittedOrExisting(req.body, 'is_active', currentChannel.is_active);
  const apiKeyword = submittedOrExisting(req.body, 'api_keyword', currentChannel.api_keyword);
  const apiPhone = submittedOrExisting(req.body, 'api_phone', currentChannel.api_phone);
  const apiProvince = submittedOrExisting(req.body, 'api_province', currentChannel.api_province);
  const apiCardType = submittedOrExisting(req.body, 'api_card_type', currentChannel.api_card_type);
  const provider = db.prepare('SELECT * FROM api_providers WHERE id=?').get([providerId]);
  if (!provider) return renderChannels(res, req, db, '请选择有效的 API 服务商');
  if (provider.provider_type === 'qc86' && !String(channelId || '').trim()) return renderChannels(res, req, db, 'qc86 项目必须填写 channelId');
  if (provider.provider_type === 'uoomsg' && !String(apiKeyword || '').trim()) return renderChannels(res, req, db, 'uoomsg 项目必须填写短信关键词');
  const prefixFilterMode = normalizePrefixFilterMode(
    submittedOrExisting(req.body, 'prefix_filter_mode', currentChannel.prefix_filter_mode),
    submittedOrExisting(req.body, 'prefix_enabled', currentChannel.prefix_enabled)
  );
  const prefixEnabled = prefixFilterMode === 'disabled' ? 0 : 1;
  const prefixMaxRequests = normalizePrefixMaxRequests(submittedOrExisting(req.body, 'prefix_max_requests', currentChannel.prefix_max_requests));
  const prefixConcurrency = Math.min(prefixMaxRequests, normalizePrefixConcurrency(submittedOrExisting(req.body, 'prefix_concurrency', currentChannel.prefix_concurrency)));
  const prefixRequestIntervalMs = normalizePrefixRequestIntervalMs(submittedOrExisting(
    req.body,
    'prefix_request_interval_seconds',
    (Number(currentChannel.prefix_request_interval_ms) || 500) / 1000
  ));
  try {
    const directScope = provider.provider_type === 'qc86'
      ? normalizeDirectScope(submittedOrExisting(req.body, 'direct_scope', currentChannel.direct_scope))
      : '';
    const result = db.prepare(`
      UPDATE channels
      SET name=?, channel_id=?, provider_id=?, api_keyword=?, api_phone=?, api_province=?, api_card_type=?, operator=?, scope=?, direct_scope=?, prefix=?, prefix_enabled=?, prefix_filter_mode=?, prefix_max_requests=?, prefix_concurrency=?, prefix_request_interval_ms=?, description=?, is_active=?
      WHERE id=?
    `).run([
      String(name || '').trim(),
      String(channelId || '').trim(),
      provider.id,
      String(apiKeyword || '').trim(),
      String(apiPhone || '').trim(),
      String(apiProvince || '').trim(),
      ['实卡', '虚卡', '全部'].includes(apiCardType) ? apiCardType : '全部',
      parseInt(operator || 0),
      scope || '',
      directScope,
      String(prefix || '').trim(),
      prefixEnabled,
      prefixFilterMode,
      prefixMaxRequests,
      prefixConcurrency,
      prefixRequestIntervalMs,
      description || '',
      parseInt(isActive || 0),
      req.params.id
    ]);
    if (!result || result.changes !== 1) throw new Error('项目没有保存成功，请刷新页面后重试');
    saveDb();
    verifySavedDirectScope(db, req.params.id, directScope);
    const directScopeMessage = directScope ? '，API 指定号段：' + directScope : '，API 指定号段已关闭';
    res.redirect('/admin/channels?success=' + encodeURIComponent('更新成功' + directScopeMessage));
  } catch (e) {
    renderChannels(res, req, db, '更新失败: ' + e.message);
  }
});

// This endpoint intentionally updates only the upstream QC86 scope. It avoids
// accidental loss of unrelated project fields when an admin only changes the
// API-provided prefix setting.
router.post('/channels/:id/direct-scope', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const channel = db.prepare(`
      SELECT channels.id, channels.provider_id, api_providers.provider_type
      FROM channels
      LEFT JOIN api_providers ON api_providers.id = channels.provider_id
      WHERE channels.id=?
    `).get([req.params.id]);
    if (!channel) return res.status(404).json({ success: false, error: '项目不存在，可能已被删除' });
    if (channel.provider_type !== 'qc86') {
      return res.status(400).json({ success: false, error: '只有 QC86 项目可以设置 API 指定号段' });
    }

    const directScope = normalizeDirectScope(req.body.direct_scope);
    const result = db.prepare('UPDATE channels SET direct_scope=? WHERE id=?').run([directScope, channel.id]);
    if (!result || result.changes !== 1) throw new Error('API 指定号段没有保存成功');
    saveDb();
    verifySavedDirectScope(db, channel.id, directScope);

    res.json({
      success: true,
      direct_scope: directScope,
      message: directScope ? 'API 指定号段已保存：' + directScope : 'API 指定号段已关闭'
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message || '保存 API 指定号段失败' });
  }
});

router.post('/channels/delete/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM channels WHERE id=?').run([req.params.id]);
  res.redirect('/admin/channels?success=删除成功');
});

// Card management
router.get('/cards', requireAdmin, (req, res) => {
  const db = getDb();
  const channels = db.prepare('SELECT * FROM channels WHERE is_active=1').all();
  const defaultChannel = db.prepare("SELECT value FROM settings WHERE key='default_channel_id'").get();
  const allowedStatuses = ['unused', 'used', 'expired'];
  const statusFilter = allowedStatuses.includes(req.query.status) ? req.query.status : 'all';
  const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const effectiveStatusSql = `CASE
    WHEN ck.status='expired' THEN 'expired'
    WHEN ck.sms_code IS NOT NULL AND ck.sms_code != '' THEN 'used'
    WHEN ck.attempts >= CASE WHEN ck.max_attempts IS NULL OR ck.max_attempts < 1 THEN 3 ELSE ck.max_attempts END THEN 'used'
    ELSE 'unused'
  END`;
  const where = [];
  const params = [];
  if (statusFilter !== 'all') {
    where.push(effectiveStatusSql + ' = ?');
    params.push(statusFilter);
  }
  if (searchQuery) {
    const searchTerm = '%' + searchQuery + '%';
    where.push('(ck.code LIKE ? OR ck.phone_number LIKE ? OR ck.remark LIKE ? OR ch.name LIKE ?)');
    params.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const cardsSql = `
    SELECT ck.*, ch.name as channel_name, ch.prefix as channel_prefix,
      ${effectiveStatusSql} AS display_status
    FROM card_keys ck
    LEFT JOIN channels ch ON ck.channel_id = ch.id
    ${whereSql}
    ORDER BY ck.id DESC LIMIT 200
  `;
  const cardsStmt = db.prepare(cardsSql);
  const cards = params.length ? cardsStmt.all(params) : cardsStmt.all();
  const cardBatches = groupCardsByBatch(cards);
  const totalStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN ${effectiveStatusSql}='unused' THEN 1 ELSE 0 END) as unused,
      SUM(CASE WHEN ${effectiveStatusSql}='used' THEN 1 ELSE 0 END) as used,
      SUM(CASE WHEN ${effectiveStatusSql}='expired' THEN 1 ELSE 0 END) as expired
    FROM card_keys ck
  `).get();
  res.render('admin/cards', {
    admin: req.session.admin,
    channels,
    cards,
    cardBatches,
    defaultChannel: defaultChannel ? defaultChannel.value : '',
    statusFilter,
    searchQuery,
    totalStats,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get('/cards/batches/:batchId/export', requireAdmin, (req, res) => {
  const db = getDb();
  const batchId = normalizeBatchId(req.params.batchId);

  if (!batchId || batchId.length > 80) {
    return res.status(400).json({ success: false, error: '批次号无效' });
  }

  const cards = db.prepare('SELECT code FROM card_keys WHERE batch_id=? ORDER BY id ASC').all([batchId]);
  if (!cards.length) {
    return res.status(404).json({ success: false, error: '未找到该批次卡密' });
  }

  res.json({ success: true, batchId, codes: cards.map((card) => card.code) });
});

router.post('/cards/generate', requireAdmin, (req, res) => {
  const db = getDb();
  const { channel_id, count, remark, max_attempts } = req.body;
  const qty = parseInt(count) || 10;
  const maxAtt = parseInt(max_attempts) || 3;
  const batchId = createBatchId();

  try {
    db.exec('BEGIN');
    try {
      for (let i = 0; i < qty; i++) {
        // Reserve an AUTOINCREMENT id first. It makes the public card code
        // unique by construction, while the signed suffix keeps it unguessable.
        const placeholder = `__PENDING_CARD_KEY__${crypto.randomUUID()}`;
        db.prepare('INSERT INTO card_keys (code, channel_id, batch_id, remark, max_attempts, is_test) VALUES (?, ?, ?, ?, ?, ?)')
          .run([placeholder, channel_id, batchId, remark || '', maxAtt, req.body.is_test ? 1 : 0]);

        const inserted = db.prepare('SELECT last_insert_rowid() AS id').get();
        if (!inserted || !inserted.id) throw new Error('卡密编号生成失败');

        const code = generateCardCode(inserted.id);
        db.prepare('UPDATE card_keys SET code=? WHERE id=?').run([code, inserted.id]);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    // Do not leave newly issued keys only in the in-memory sql.js cache.
    saveDb();
    res.redirect('/admin/cards?success=成功生成 ' + qty + ' 张卡密，批次号: ' + batchId);
  } catch (e) {
    res.redirect('/admin/cards?error=生成失败: ' + encodeURIComponent(e.message));
  }
});

router.post('/cards/delete/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM card_keys WHERE id=?').run([req.params.id]);
  res.redirect('/admin/cards?success=删除成功');
});

router.post('/cards/attempts/:id', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const card = db.prepare('SELECT * FROM card_keys WHERE id=?').get([req.params.id]);
    if (!card) {
      return res.redirect('/admin/cards?error=' + encodeURIComponent('卡密不存在'));
    }

    const maxAttempts = normalizeCardMaxAttempts(req.body.max_attempts, card.max_attempts || 3);
    const attempts = normalizeCardAttempts(req.body.attempts, card.attempts || 0);
    const status = card.status === 'expired'
      ? 'expired'
      : (card.sms_code ? 'used' : (attempts >= maxAttempts ? 'used' : 'unused'));

    db.prepare('UPDATE card_keys SET attempts=?, max_attempts=?, status=? WHERE id=?')
      .run([attempts, maxAttempts, status, card.id]);
    saveDb();

    const message = card.sms_code
      ? '次数已调整；该卡密已收到验证码，仍保持不可继续取号'
      : '卡密次数已调整';
    return res.redirect('/admin/cards?success=' + encodeURIComponent(message));
  } catch (error) {
    console.error('Failed to update card attempts:', error);
    return res.redirect('/admin/cards?error=' + encodeURIComponent('保存次数失败：' + (error.message || '系统错误')));
  }
});

// ====== API 调试工具 ======

function findAdminChannel(db, body) {
  const projectId = Number(body.project_id || body.channel_db_id || 0);
  if (projectId > 0) {
    return db.prepare('SELECT * FROM channels WHERE id=? AND is_active=1').get([projectId]);
  }
  if (String(body.channel_id || '').trim()) {
    return db.prepare('SELECT * FROM channels WHERE channel_id=? AND is_active=1').get([String(body.channel_id).trim()]);
  }
  return null;
}

function findAdminProvider(db, body) {
  const providerId = Number(body.provider_id || 0);
  if (providerId > 0) return db.prepare('SELECT * FROM api_providers WHERE id=? AND is_active=1').get([providerId]);
  return db.prepare("SELECT * FROM api_providers WHERE provider_type='qc86' AND is_system=1 AND is_active=1 ORDER BY id LIMIT 1").get();
}

function getUoomsgHistoryCooldown(db, providerId) {
  const key = 'uoomsg_query_used_last_' + providerId;
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get([key]);
  const last = row ? Number(row.value) : 0;
  const remaining = Math.ceil((60000 - (Date.now() - last)) / 1000);
  return { key, last, remaining: Math.max(0, remaining) };
}

// Balance check API. The optional provider_id keeps this endpoint backward compatible.
router.get('/api/balance', requireAdmin, async (req, res) => {
  const db = getDb();
  const provider = findAdminProvider(db, req.query);
  if (!provider) return res.json({ success: false, error: '没有可用的 API 服务商' });
  try {
    const result = await providerService.getBalance(provider);
    const balance = extractProviderBalance(result);
    res.json({
      success: true,
      balance,
      message: balance == null ? '连接成功，但服务商未返回余额数值' : ''
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 获取临时号码：按项目绑定的服务商自动分流，保留原 channel_id 调用方式。
router.post('/api/get-phone', requireAdmin, async (req, res) => {
  const db = getDb();
  const channel = findAdminChannel(db, req.body);
  if (!channel) return res.json({ success: false, error: '请选择有效项目' });
  const provider = providerService.getProviderForChannel(channel);
  const requestChannel = {
    ...channel,
    operator: req.body.operator == null ? channel.operator : parseInt(req.body.operator || 0),
    // Project settings are authoritative. Do not let a stale debug page clear
    // the direct scope that was already saved for this project.
    scope: channel.scope,
    direct_scope: channel.direct_scope
  };
  try {
    const token = await providerService.getToken(provider);
    const result = await providerService.getPhoneWithPrefix(provider, requestChannel, {
      token,
      phone: req.body.phone_num || '',
      onRejected: async (phone, attempt, rejection) => {
        const immediateRelease = Boolean(rejection && rejection.immediateRelease);
        const recordId = registerRejectedPhone({
          channelId: channel.id,
          phone,
          channelName: channel.name,
          reason: rejection && rejection.reason,
          releaseDelayMs: immediateRelease ? null : undefined
        });
        if (!immediateRelease) return null;
        try {
          await releaseRejectedPhone(recordId);
          return { releaseHandled: true };
        } catch (error) {
          console.error('Failed to immediately release API debug mismatch:', error.message);
          return null;
        }
      }
    });
    res.json(result);
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 查询验证码
router.post('/api/get-code', requireAdmin, async (req, res) => {
  const db = getDb();
  const channel = findAdminChannel(db, req.body);
  const phone = String(req.body.phone_num || req.body.phone_no || '').trim();
  if (!channel || !phone) return res.json({ success: false, error: '请选择项目并填写手机号' });
  const provider = providerService.getProviderForChannel(channel);
  try {
    const token = await providerService.getToken(provider);
    const result = await providerService.getCode(provider, channel, token, phone);
    res.json(result || { success: false, msg: '暂无验证码' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

async function handlePhoneAction(req, res, action) {
  const db = getDb();
  const channel = findAdminChannel(db, req.body);
  const phone = String(req.body.phone_no || req.body.phone_num || '').trim();
  if (!channel || !phone) return res.json({ success: false, error: '请选择项目并填写手机号' });
  const provider = providerService.getProviderForChannel(channel);
  try {
    const token = await providerService.getToken(provider);
    const result = action === 'blacklist'
      ? await providerService.blacklistPhone(provider, channel, token, phone)
      : await providerService.releasePhone(provider, channel, token, phone);
    res.json(result);
  } catch (e) { res.json({ success: false, error: e.message }); }
}

router.post('/api/blacklist', requireAdmin, (req, res) => handlePhoneAction(req, res, 'blacklist'));
router.post('/api/release', requireAdmin, (req, res) => handlePhoneAction(req, res, 'release'));

// uoomsg 专属：发送短信。默认不在用户取码流程中调用，必须由管理员显式操作。
router.post('/api/uoomsg/send', requireAdmin, async (req, res) => {
  const db = getDb();
  const provider = findAdminProvider(db, { provider_id: req.body.provider_id });
  if (!provider || provider.provider_type !== 'uoomsg') return res.json({ success: false, error: '请选择启用中的 uoomsg 服务商' });
  try {
    const token = await providerService.getToken(provider);
    const result = await providerService.sendSms(provider, token, req.body);
    res.json(result);
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// uoomsg 专属：查询最近历史。官方限制每分钟最多调用一次，时间戳持久化到数据库。
router.post('/api/uoomsg/history', requireAdmin, async (req, res) => {
  const db = getDb();
  const provider = findAdminProvider(db, { provider_id: req.body.provider_id });
  if (!provider || provider.provider_type !== 'uoomsg') return res.json({ success: false, error: '请选择启用中的 uoomsg 服务商' });
  const cooldown = getUoomsgHistoryCooldown(db, provider.id);
  if (cooldown.remaining > 0) {
    return res.json({ success: false, error: '历史记录查询冷却中，请 ' + cooldown.remaining + ' 秒后再试', retryAfter: cooldown.remaining });
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run([cooldown.key, String(Date.now())]);
  saveDb();
  try {
    const token = await providerService.getToken(provider);
    const result = await providerService.queryUsed(provider, token);
    res.json(result);
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Settings
router.get('/settings', requireAdmin, (req, res) => {
  const db = getDb();
  const siteName = db.prepare("SELECT value FROM settings WHERE key='site_name'").get();
  const releaseTimeout = db.prepare("SELECT value FROM settings WHERE key='release_timeout'").get();
  const cooldownSeconds = db.prepare("SELECT value FROM settings WHERE key='cooldown_seconds'").get();
  res.render('admin/settings', {
    admin: req.session.admin,
    siteName: siteName && siteName.value ? siteName.value : '卡密接码',
    releaseTimeout: normalizeReleaseTimeoutMinutes(releaseTimeout && releaseTimeout.value),
    cooldownSeconds: normalizeCooldownSeconds(cooldownSeconds && cooldownSeconds.value),
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/settings', requireAdmin, (req, res) => {
  const db = getDb();
  const { qc86_username, qc86_password, qc86_token } = req.body;
  const siteName = String(req.body.site_name || '').trim().slice(0, 40) || '卡密接码';
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('site_name', ?)").run([siteName]);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('release_timeout', ?)").run([String(normalizeReleaseTimeoutMinutes(req.body.release_timeout))]);
  // 兼容旧版表单：只有明确提交默认项目时才更新，独立网站设置页不会误清空旧值。
  if (Object.prototype.hasOwnProperty.call(req.body, 'default_channel_id')) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_channel_id', ?)").run([req.body.default_channel_id || '']);
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cooldown_seconds', ?)").run([String(normalizeCooldownSeconds(req.body.cooldown_seconds))]);
  // API 凭证在统一的 API 服务商编辑窗口保存；这里不触碰凭证，避免保存运行参数时清空旧 qc86 配置。
  if (String(qc86_username || '').trim() || String(qc86_password || '') || String(qc86_token || '').trim()) {
    const currentUser = (db.prepare("SELECT value FROM settings WHERE key='qc86_username'").get() || {}).value || '';
    const currentPass = (db.prepare("SELECT value FROM settings WHERE key='qc86_password'").get() || {}).value || '';
    const currentToken = (db.prepare("SELECT value FROM settings WHERE key='qc86_token'").get() || {}).value || '';
    const username = String(qc86_username || '').trim() || currentUser;
    const password = String(qc86_password || '') || currentPass;
    const token = String(qc86_token || '').trim() || currentToken;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qc86_username', ?)").run([username]);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qc86_password', ?)").run([password]);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qc86_token', ?)").run([token]);
    db.prepare(`UPDATE api_providers SET username=?, password=?, token=? WHERE provider_type='qc86' AND is_system=1`).run([username, password, token]);
  }
  saveDb();
  res.redirect('/admin/settings?success=' + encodeURIComponent('设置保存成功'));
});

router.post('/settings/get-token', requireAdmin, async (req, res) => {
  const db = getDb();
  const username = (db.prepare("SELECT value FROM settings WHERE key='qc86_username'").get() || {}).value || '';
  const password = (db.prepare("SELECT value FROM settings WHERE key='qc86_password'").get() || {}).value || '';
  if (!username || !password) return res.redirect('/admin/api-providers?error=请先在原有 qc86 服务商中填写用户名和密码');
  try {
    const resp = await axios.get(config.qc86.baseUrl + '/login', {
      params: { username, password }, timeout: 10000
    });
    if (resp.data.success && resp.data.data.token) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qc86_token', ?)").run([resp.data.data.token]);
      db.prepare("UPDATE api_providers SET token=? WHERE provider_type='qc86' AND is_system=1").run([resp.data.data.token]);
      saveDb();
      res.redirect('/admin/api-providers?success=Token获取成功');
    } else { res.redirect('/admin/api-providers?error=登录失败: ' + encodeURIComponent(resp.data.msg)); }
  } catch (e) { res.redirect('/admin/api-providers?error=请求失败: ' + encodeURIComponent(e.message)); }
});

// Rejected phones page
router.get('/rejected', requireAdmin, (req, res) => {
  const db = getDb();
  const pageSize = 100;
  const requestedPage = parseInt(req.query.page, 10);
  const status = ['all', 'pending', 'released'].includes(req.query.status) ? req.query.status : 'all';
  const searchQuery = String(req.query.q || '').trim().slice(0, 80);
  const where = [];
  const params = [];

  if (status === 'pending') {
    where.push('released=0');
  } else if (status === 'released') {
    where.push('released=1');
  }

  if (searchQuery) {
    const searchTerm = '%' + searchQuery + '%';
    where.push('(phone_number LIKE ? OR channel_name LIKE ? OR reason LIKE ?)');
    params.push(searchTerm, searchTerm, searchTerm);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const filteredTotal = Number((db.prepare(`SELECT COUNT(*) AS c FROM rejected_phones ${whereSql}`).get(params) || {}).c || 0);
  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const currentPage = Math.min(totalPages, Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1));
  const offset = (currentPage - 1) * pageSize;
  const rejected = db.prepare(`SELECT * FROM rejected_phones ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(params.concat([pageSize, offset]));
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN released=0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN released=1 THEN 1 ELSE 0 END) AS released
    FROM rejected_phones
  `).get() || {};

  res.render('admin/rejected', {
    admin: req.session.admin,
    rejected,
    totalCount: Number(stats.total || 0),
    pendingCount: Number(stats.pending || 0),
    releasedCount: Number(stats.released || 0),
    filteredTotal,
    currentPage,
    totalPages,
    pageSize,
    status,
    searchQuery
  });
});

// Release a specific rejected phone (admin action)
router.post('/rejected/release', requireAdmin, async (req, res) => {
  const db = getDb();
  const { id } = req.body;
  const record = db.prepare('SELECT * FROM rejected_phones WHERE id=? AND released=0').get([id]);
  if (!record) return res.json({ success: false, error: '记录不存在或已释放' });
  try {
    await releaseRejectedPhone(id);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// Release all unreleased rejected phones
router.post('/rejected/release-all', requireAdmin, async (req, res) => {
  const db = getDb();
  const records = db.prepare('SELECT * FROM rejected_phones WHERE released=0').all();
  if (records.length === 0) return res.json({ success: true, count: 0 });
  try {
    let released = 0;
    for (const record of records) {
      try {
        if (await releaseRejectedPhone(record.id)) released++;
      } catch(e) {}
    }
    res.json({ success: true, count: released });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// Records
router.get('/records', requireAdmin, (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim().slice(0, 80);
  const status = ['all', 'pending', 'completed', 'timeout'].includes(req.query.status) ? req.query.status : 'all';
  const conditions = [];
  const params = [];
  if (q) {
    const like = '%' + q + '%';
    conditions.push('(card_code LIKE ? OR channel_name LIKE ? OR phone_number LIKE ? OR sms_code LIKE ? OR sms_message LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (status !== 'all') {
    conditions.push('status=?');
    params.push(status);
  }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const resultCount = db.prepare('SELECT COUNT(*) AS c FROM usage_records' + where).get(params).c;
  const totalCount = db.prepare('SELECT COUNT(*) AS c FROM usage_records').get().c;
  const records = db.prepare('SELECT * FROM usage_records' + where + ' ORDER BY id DESC LIMIT 300').all(params);
  const retentionRow = db.prepare("SELECT value FROM settings WHERE key='usage_record_retention_days'").get();
  const retentionDays = normalizeUsageRecordRetentionDays((retentionRow || {}).value || '90');
  res.render('admin/records', {
    admin: req.session.admin,
    records,
    q,
    status,
    resultCount,
    totalCount,
    retentionDays,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/records/retention', requireAdmin, (req, res) => {
  const db = getDb();
  const retentionDays = normalizeUsageRecordRetentionDays(req.body.retention_days);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('usage_record_retention_days', ?)").run([String(retentionDays)]);
  const removed = deleteUsageRecordsBefore(db, retentionDays);
  saveDb();
  const message = retentionDays === 0
    ? '已关闭自动清理，历史记录会继续保留'
    : '已设置自动保留 ' + retentionDays + ' 天，并清理了 ' + removed + ' 条过期记录';
  res.redirect('/admin/records?success=' + encodeURIComponent(message));
});

router.post('/records/clear', requireAdmin, (req, res) => {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS c FROM usage_records').get().c;
  if (count > 0) {
    db.prepare('DELETE FROM usage_records').run();
    db.exec('VACUUM');
  }
  saveDb();
  res.redirect('/admin/records?success=' + encodeURIComponent('已清空 ' + count + ' 条使用记录，并已压缩数据库'));
});

// Data cleanup center. It intentionally only touches completed history data;
// card keys, projects, providers and active phone allocation tasks are kept.
router.get('/cleanup', requireAdmin, (req, res) => {
  const db = getDb();
  const retentionRow = db.prepare("SELECT value FROM settings WHERE key='usage_record_retention_days'").get();
  const retentionDays = normalizeUsageRecordRetentionDays((retentionRow || {}).value || '90');
  res.render('admin/cleanup', {
    admin: req.session.admin,
    retentionDays,
    stats: getCleanupStats(db, retentionDays),
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/cleanup/retention', requireAdmin, (req, res) => {
  const db = getDb();
  const retentionDays = normalizeUsageRecordRetentionDays(req.body.retention_days);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('usage_record_retention_days', ?)").run([String(retentionDays)]);
  const removed = deleteUsageRecordsBefore(db, retentionDays);
  saveDb();
  const message = retentionDays === 0
    ? '已关闭使用记录自动清理'
    : '已设置保留 ' + retentionDays + ' 天，并清理 ' + removed + ' 条过期使用记录';
  res.redirect('/admin/cleanup?success=' + encodeURIComponent(message));
});

router.post('/cleanup/usage-records', requireAdmin, (req, res) => {
  const db = getDb();
  const scope = req.body.scope === 'all' ? 'all' : 'expired';
  const retentionRow = db.prepare("SELECT value FROM settings WHERE key='usage_record_retention_days'").get();
  const retentionDays = normalizeUsageRecordRetentionDays((retentionRow || {}).value || '90');
  let count = 0;

  if (scope === 'all') {
    count = countCleanupRows(db, 'SELECT COUNT(*) AS c FROM usage_records');
    if (count > 0) db.prepare('DELETE FROM usage_records').run();
  } else if (retentionDays > 0) {
    count = countCleanupRows(db, "SELECT COUNT(*) AS c FROM usage_records WHERE created_at < datetime('now', 'localtime', '-' || ? || ' days')", [retentionDays]);
    if (count > 0) {
      db.prepare("DELETE FROM usage_records WHERE created_at < datetime('now', 'localtime', '-' || ? || ' days')").run([retentionDays]);
    }
  }

  if (count > 0) saveDb();
  const message = scope === 'all'
    ? '已删除 ' + count + ' 条使用记录'
    : retentionDays === 0
      ? '自动保留已关闭，未删除任何使用记录'
      : '已删除 ' + count + ' 条超过 ' + retentionDays + ' 天的使用记录';
  res.redirect('/admin/cleanup?success=' + encodeURIComponent(message));
});

router.post('/cleanup/released-rejected', requireAdmin, (req, res) => {
  const db = getDb();
  const days = normalizeCleanupAgeDays(req.body.older_than_days, 7);
  const count = countCleanupRows(
    db,
    "SELECT COUNT(*) AS c FROM rejected_phones WHERE released=1 AND rejected_at < datetime('now', 'localtime', '-' || ? || ' days')",
    [days]
  );
  if (count > 0) {
    db.prepare("DELETE FROM rejected_phones WHERE released=1 AND rejected_at < datetime('now', 'localtime', '-' || ? || ' days')").run([days]);
    saveDb();
  }
  res.redirect('/admin/cleanup?success=' + encodeURIComponent('已删除 ' + count + ' 条已释放且超过 ' + days + ' 天的号段过滤记录'));
});

router.post('/cleanup/finished-phone-jobs', requireAdmin, (req, res) => {
  const db = getDb();
  const days = normalizeCleanupAgeDays(req.body.older_than_days, 7);
  const count = countCleanupRows(
    db,
    "SELECT COUNT(*) AS c FROM phone_request_jobs WHERE state IN ('success', 'failed') AND COALESCE(completed_at, updated_at, created_at) < datetime('now', 'localtime', '-' || ? || ' days')",
    [days]
  );
  if (count > 0) {
    db.prepare("DELETE FROM phone_request_jobs WHERE state IN ('success', 'failed') AND COALESCE(completed_at, updated_at, created_at) < datetime('now', 'localtime', '-' || ? || ' days')").run([days]);
    saveDb();
  }
  res.redirect('/admin/cleanup?success=' + encodeURIComponent('已删除 ' + count + ' 条已结束且超过 ' + days + ' 天的取号任务'));
});

router.post('/cleanup/vacuum', requireAdmin, (req, res) => {
  const db = getDb();
  db.exec('VACUUM');
  saveDb();
  res.redirect('/admin/cleanup?success=' + encodeURIComponent('数据库空间已整理完成'));
});

// Batch delete cards
router.post('/cards/batch-delete', requireAdmin, (req, res) => {
  const db = getDb();
  const ids = req.body.ids;
  if (!ids) return res.redirect('/admin/cards');
  const idArr = Array.isArray(ids) ? ids : [ids];
  db.exec('BEGIN');
  try {
    for (const id of idArr) {
      db.prepare('DELETE FROM card_keys WHERE id=?').run([id]);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); }
  res.redirect('/admin/cards?success=' + encodeURIComponent('已删除 ' + idArr.length + ' 张卡密'));
});


// Release phone for a specific card (admin action)
router.post('/cards/release-phone/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT * FROM card_keys WHERE id=?').get([req.params.id]);
  if (!card || !card.phone_number) {
    return res.json({ success: false, error: '该卡密没有已分配的手机号' });
  }
  try {
    const channel = db.prepare('SELECT * FROM channels WHERE id=?').get([card.channel_id]);
    if (channel) {
      const provider = providerService.getProviderForChannel(channel);
      const token = card.token || await providerService.getToken(provider);
      try { await providerService.blacklistPhone(provider, channel, token, card.phone_number); } catch(e) {}
      try { await providerService.releasePhone(provider, channel, token, card.phone_number); } catch(e) {}
    }
  } catch (e) { /* don't block on API errors */ }

  db.prepare("UPDATE card_keys SET phone_number='', token='', sms_task_id='', used_at=NULL WHERE id=?")
    .run([card.id]);
  res.json({ success: true, message: '手机号已释放' });
});

// Check and release phone if it doesn't match the channel's prefix
router.post('/cards/check-prefix/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT ck.*, ch.prefix as channel_prefix, ch.prefix_enabled, ch.prefix_filter_mode FROM card_keys ck LEFT JOIN channels ch ON ck.channel_id = ch.id WHERE ck.id=?').get([req.params.id]);
  if (!card) return res.json({ success: false, error: '卡密不存在' });

  const mode = card.prefix_filter_mode === 'exclude' ? 'exclude' : 'include';
  const filterEnabled = Number(card.prefix_enabled) !== 0 && String(card.channel_prefix || '').trim();
  if (!filterEnabled) {
    return res.json({ success: false, error: '该项目未启用号段过滤', match: true });
  }

  if (!card.phone_number) {
    return res.json({ success: false, error: '该卡密没有已分配的手机号', match: false });
  }

  const prefixList = card.channel_prefix.split(/[,，\s]+/).map(p => p.trim()).filter(Boolean);
  const phone = String(card.phone_number);
  const matches = prefixList.some(p => phone.startsWith(p));

  const accepted = mode === 'exclude' ? !matches : matches;
  if (accepted) {
    return res.json({ success: true, match: true, message: mode === 'exclude' ? '当前号码未命中排除号段: ' + card.channel_prefix : '当前号码符合指定号段: ' + card.channel_prefix });
  }

  // Release the phone
  try {
    const channel = db.prepare('SELECT * FROM channels WHERE id=?').get([card.channel_id]);
    if (channel) {
      const provider = providerService.getProviderForChannel(channel);
      const token = card.token || await providerService.getToken(provider);
      try { await providerService.blacklistPhone(provider, channel, token, card.phone_number); } catch(e) {}
      try { await providerService.releasePhone(provider, channel, token, card.phone_number); } catch(e) {}
    }
  } catch (e) { /* don't block on API errors */ }

  db.prepare("UPDATE card_keys SET phone_number='', token='', sms_task_id='', used_at=NULL WHERE id=?")
    .run([card.id]);

  res.json({ success: true, match: false, message: '号码 ' + card.phone_number + ' 不匹配号段(' + card.channel_prefix + ')，已释放' });
});


// ====== 测试管理 ======

// Helper: auto-generate SMS for test cards after 30 seconds
function scheduleTestCardSms(cardId) {
  setTimeout(function() {
    try {
      const db = getDb();
      const card = db.prepare('SELECT id, is_test, phone_number, sms_code FROM card_keys WHERE id=?').get([cardId]);
      if (!card || !card.is_test) return;
      if (card.sms_code) return;

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

// Test page
router.get('/test', requireAdmin, (req, res) => {
  const db = getDb();
  const { card_code } = req.query;
  let card = null;
  if (card_code) {
    card = db.prepare('SELECT ck.*, ch.name as channel_name, ch.prefix as channel_prefix FROM card_keys ck LEFT JOIN channels ch ON ck.channel_id = ch.id WHERE ck.code = ?').get([card_code.trim().toUpperCase()]);
  }
  // Also pass recent test cards
  const recentCards = db.prepare("SELECT ck.*, ch.name as channel_name, ch.prefix as channel_prefix FROM card_keys ck LEFT JOIN channels ch ON ck.channel_id = ch.id WHERE ck.is_test=1 ORDER BY ck.id DESC LIMIT 10").all();
  res.render('admin/test', { admin: req.session.admin, card, searchCode: card_code || '', recentCards, error: null, success: null });
});

// User interface preview mode. This is intentionally database-free and never calls the provider API.
router.get('/test/preview', requireAdmin, (req, res) => {
  const allowedStates = new Set(['waiting', 'cooldown', 'success']);
  const previewState = allowedStates.has(req.query.state) ? req.query.state : 'waiting';
  const hasSms = previewState === 'success';

  res.render('user/index', {
    channels: [],
    step: 'waiting',
    error: null,
    cardCode: 'TEST-PREVIEW-MODE',
    channelId: '',
    phoneNumber: '13800000047',
    smsCode: hasSms ? '846226' : '',
    smsMessage: hasSms ? '【测试平台】您的验证码是846226，30分钟内有效' : '',
    channelName: '界面测试',
    cardId: '',
    attempts: 1,
    maxAttempts: 3,
    refreshInterval: 5000,
    cooldownSeconds: 60,
    cooldownRemaining: previewState === 'cooldown' ? 45 : 0,
    isTest: true,
    previewMode: true,
    previewState
  });
});

// Test: get a fake phone number for a test card
router.post('/test/get-phone', requireAdmin, async (req, res) => {
  const db = getDb();
  const { card_code } = req.body;
  if (!card_code) return res.json({ success: false, error: '请填写卡密' });

  const card = db.prepare('SELECT * FROM card_keys WHERE code = ?').get([card_code.trim().toUpperCase()]);
  if (!card) return res.json({ success: false, error: '卡密不存在' });
  if (card.sms_code) return res.json({ success: false, error: '该测试卡密已收到验证码，不能继续获取号码' });
  const maxAttempts = card.max_attempts || 3;
  if (card.attempts >= maxAttempts) return res.json({ success: false, error: '该测试卡密获取次数已用完' });
  
  const fakePhone = '1380000' + String(card.id).padStart(4, '0');
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get([card.channel_id]);
  
  db.prepare(`
    UPDATE card_keys
    SET phone_number=?, used_at=datetime('now','localtime'), attempts=attempts+1,
        status=CASE WHEN attempts+1 >= CASE WHEN max_attempts IS NULL OR max_attempts < 1 THEN 3 ELSE max_attempts END THEN 'used' ELSE status END
    WHERE id=?
  `).run([fakePhone, card.id]);
  
  const channelName = channel ? channel.name : '测试项目';
  db.prepare('INSERT INTO usage_records (card_key_id, card_code, channel_name, phone_number, status) VALUES (?, ?, ?, ?, ?)')
    .run([card.id, card.code, channelName, fakePhone, 'pending']);

  // Start 30-second timer for auto SMS
  scheduleTestCardSms(card.id);

  const updated = db.prepare('SELECT * FROM card_keys WHERE id=?').get([card.id]);
  res.json({ success: true, phoneNumber: fakePhone, card: updated });
});

// Test: check SMS status (for auto-polling)
router.get('/test/check-sms/:cardId', requireAdmin, (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT phone_number, sms_code, sms_message, status FROM card_keys WHERE id=? AND is_test=1').get([req.params.cardId]);
  if (!card) return res.json({ found: false });
  res.json({
    found: !!card.sms_code,
    phoneNumber: card.phone_number,
    smsCode: card.sms_code || '',
    smsMessage: card.sms_message || '',
    status: card.status
  });
});

// Test: list recent test cards as JSON
router.get('/test/recent', requireAdmin, (req, res) => {
  const db = getDb();
  const cards = db.prepare("SELECT ck.id, ck.code, ck.phone_number, ck.sms_code, ck.sms_message, ck.status, ck.is_test, ck.attempts, ck.max_attempts, ck.created_at, ch.name as channel_name FROM card_keys ck LEFT JOIN channels ch ON ck.channel_id = ch.id WHERE ck.is_test=1 ORDER BY ck.id DESC LIMIT 10").all();
    res.json({ cards });
});

// Test: send phone number card code (simulate receiving SMS)
router.post('/test/send-code', requireAdmin, async (req, res) => {
  const db = getDb();
  const { card_code, sms_code, sms_message } = req.body;
  if (!card_code || !sms_code) return res.json({ success: false, error: '请填写卡密和验证码' });

  const card = db.prepare('SELECT * FROM card_keys WHERE code = ?').get([card_code.trim().toUpperCase()]);
  if (!card) return res.json({ success: false, error: '卡密不存在' });

  db.prepare('UPDATE card_keys SET sms_code=?, sms_message=?, status=? WHERE id=?')
    .run([sms_code, sms_message || '', 'used', card.id]);
  
  db.prepare("UPDATE usage_records SET sms_code=?, sms_message=?, status='completed' WHERE card_key_id=? AND status='pending'")
    .run([sms_code, sms_message || '', card.id]);

  const updated = db.prepare('SELECT * FROM card_keys WHERE id=?').get([card.id]);
  res.json({ success: true, card: updated });
});

// Test: reset card (clear phone and SMS)
router.post('/test/reset', requireAdmin, async (req, res) => {
  const db = getDb();
  const { card_code } = req.body;
  if (!card_code) return res.json({ success: false, error: '请填写卡密' });

  const card = db.prepare('SELECT * FROM card_keys WHERE code = ?').get([card_code.trim().toUpperCase()]);
  if (!card) return res.json({ success: false, error: '卡密不存在' });

  db.prepare("UPDATE card_keys SET phone_number='', sms_code='', sms_message='', status='unused', used_at=NULL WHERE id=? AND is_test=1")
    .run([card.id]);
  
  const updated = db.prepare('SELECT * FROM card_keys WHERE id=?').get([card.id]);
  res.json({ success: true, card: updated });
});


module.exports = router;module.exports = router;
