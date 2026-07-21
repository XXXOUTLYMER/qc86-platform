const express = require('express');
const session = require('express-session');
const path = require('path');
const config = require('./config');
const { initDb, getDb, closeDb } = require('./database');
const providerService = require('./api/providerService');

const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
const { resumePendingRejectedPhoneReleases } = require('./routes/rejectedPhones');
const { resumePhoneRequestJobs } = require('./services/phoneRequests');

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
if (config.server.secureCookie) app.set('trust proxy', 1);
app.use(session({
  secret: config.server.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.server.secureCookie
  }
}));

// Routes
app.use('/', userRoutes);
app.use('/admin', adminRoutes);

// Balance API
app.get('/api/balance', (req, res) => {
  const axios = require('axios');
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key='qc86_token'").get();
  const token = row ? row.value : '';
  if (!token) return res.json({ success: false, error: '未获取到Token' });
  axios.get('https://api.qc86.shop/api/getWallet', { params: { token }, timeout: 10000 })
    .then(r => {
      if (r.data.success && r.data.data) res.json({ success: true, balance: r.data.data.balances });
      else res.json({ success: false, error: r.data.msg || '查询失败' });
    })
    .catch(e => res.json({ success: false, error: e.message }));
});

// Used by Docker to confirm that the application has started successfully.
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('Page not found');
});

function cleanupUsageRecords(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key='usage_record_retention_days'").get();
  const retentionDays = Math.min(3650, Math.max(0, parseInt((row || {}).value || '90', 10) || 0));
  if (retentionDays === 0) return 0;

  const count = db.prepare("SELECT COUNT(*) AS c FROM usage_records WHERE created_at < datetime('now', 'localtime', '-' || ? || ' days')")
    .get([retentionDays]).c;
  if (count > 0) {
    db.prepare("DELETE FROM usage_records WHERE created_at < datetime('now', 'localtime', '-' || ? || ' days')")
      .run([retentionDays]);
    // Shrink the on-disk SQLite file after removing a meaningful amount of old history.
    db.exec('VACUUM');
  }
  return count;
}

async function start() {
  await initDb();
  const pendingRejected = resumePendingRejectedPhoneReleases();
  const pendingPhoneRequests = resumePhoneRequestJobs();
  const oldRecordCount = cleanupUsageRecords(getDb());
  console.log(`QC86 Platform running on http://localhost:${config.server.port}`);
  console.log(`Admin login: http://localhost:${config.server.port}/admin/login`);
  console.log(`Default admin password: admin123`);
  if (pendingRejected > 0) console.log('Resumed ' + pendingRejected + ' pending rejected-phone releases');
  if (pendingPhoneRequests > 0) console.log('Resumed ' + pendingPhoneRequests + ' pending phone request jobs');
  if (oldRecordCount > 0) console.log('Cleanup: removed ' + oldRecordCount + ' old usage records');

  // Auto-cleanup: release stale phone numbers every 60 seconds
  setInterval(async () => {
    try {
      const db = getDb();
      const timeoutRow = db.prepare("SELECT value FROM settings WHERE key='release_timeout'").get();
      const timeoutMin = parseInt((timeoutRow || {}).value || '5');
      const cutoff = new Date(Date.now() - timeoutMin * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

      const stale = db.prepare("SELECT * FROM card_keys WHERE phone_number != '' AND (sms_code IS NULL OR sms_code = '') AND used_at IS NOT NULL AND used_at < ?").all([cutoff]);

      for (const card of stale) {
        try {
          const channel = db.prepare('SELECT * FROM channels WHERE id=?').get([card.channel_id]);
          if (channel) {
            const provider = providerService.getProviderForChannel(channel);
            const token = card.token || await providerService.getToken(provider);
            try { await providerService.blacklistPhone(provider, channel, token, card.phone_number); } catch (e) {}
            await providerService.releasePhone(provider, channel, token, card.phone_number);
          }
        } catch(e) {}
        db.prepare("UPDATE card_keys SET phone_number='', token='', sms_task_id='' WHERE id=? AND (sms_code IS NULL OR sms_code = '')").run([card.id]);
      }
      if (stale.length > 0) console.log('Cleanup: released ' + stale.length + ' stale phone numbers');
    } catch(e) { /* ignore */ }
  }, 60000);

  // Usage history is only operational data. Keep it bounded so long-running
  // installations do not become slower merely because old logs accumulate.
  const recordCleanupTimer = setInterval(() => {
    try {
      const removed = cleanupUsageRecords(getDb());
      if (removed > 0) console.log('Cleanup: removed ' + removed + ' old usage records');
    } catch (e) { /* ignore */ }
  }, 6 * 60 * 60 * 1000);
  if (recordCleanupTimer.unref) recordCleanupTimer.unref();
}

const server = app.listen(config.server.port, () => {
  start().catch(e => {
    console.error('Failed to initialize database:', e);
    process.exit(1);
  });
});

// Graceful shutdown: save database and close
function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  server.close(() => {
    closeDb();
    console.log('Database saved and closed.');
    process.exit(0);
  });
  // Force exit if shutdown takes too long
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
