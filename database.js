const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');

const DB_PATH = path.join(__dirname, 'data', 'platform.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

// A logical data package is safer than copying the live SQLite file while the
// service is running. Admin login credentials and in-progress phone sessions
// intentionally stay on the current device.
const SYNC_TABLES = [
  'api_providers',
  'channels',
  'card_keys',
  'usage_records',
  'rejected_phones',
  'settings'
];
const SYNC_DELETE_ORDER = [
  'phone_request_jobs',
  'usage_records',
  'rejected_phones',
  'card_keys',
  'channels',
  'api_providers',
  'settings'
];

let db = null;
let SQL = null;

// Wrapper to make sql.js look like better-sqlite3 API
function wrapDb(raw) {
  function toArray(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    return [v];
  }

  const wrapped = {
    _raw: raw,
    _dirty: false,
    _autoSaveTimer: null,

    _save() {
      if (!this._dirty) return;
      const data = this._raw.export();
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DB_PATH, Buffer.from(data));
      this._dirty = false;
    },

    _startAutoSave(intervalMs) {
      this.stopAutoSave();
      this._autoSaveTimer = setInterval(() => this._save(), intervalMs || 15000);
      if (this._autoSaveTimer && this._autoSaveTimer.unref) this._autoSaveTimer.unref();
    },

    stopAutoSave() {
      if (this._autoSaveTimer) {
        clearInterval(this._autoSaveTimer);
        this._autoSaveTimer = null;
      }
    },

    prepare(sql) {
      const stmt = this._raw.prepare(sql);
      return {
        _stmt: stmt,
        run(params) {
          stmt.run(toArray(params));
          wrapped._dirty = true;
          return { changes: 1, lastInsertRowid: stmt._lastInsertedRowId };
        },
        get(params) {
          const arr = toArray(params);
          if (arr.length > 0) stmt.bind(arr);
          if (stmt.step()) {
            const result = stmt.getAsObject();
            stmt.free();
            return result;
          }
          stmt.free();
          return undefined;
        },
        all(params) {
          const arr = toArray(params);
          if (arr.length > 0) stmt.bind(arr);
          const results = [];
          while (stmt.step()) results.push(stmt.getAsObject());
          stmt.free();
          return results;
        }
      };
    },

    exec(sql) {
      this._raw.exec(sql);
      this._dirty = true;
    },

    run(sql) { this.exec(sql); },

    close() {
      this.stopAutoSave();
      this._save();
      this._raw.close();
    }
  };
  return wrapped;
}

async function initDb() {
  SQL = await require('sql.js')();

  // Remove 0-byte corrupt db files
  try {
    const stat = fs.statSync(DB_PATH);
    if (stat.size === 0) {
      fs.unlinkSync(DB_PATH);
    }
  } catch(e) {}

  let buffer;
  try { buffer = fs.readFileSync(DB_PATH); } catch (e) { buffer = null; }

  const raw = buffer ? new SQL.Database(buffer) : new SQL.Database();
  db = wrapDb(raw);

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      operator INTEGER DEFAULT 0,
      scope TEXT DEFAULT '',
      prefix TEXT DEFAULT '',
      prefix_enabled INTEGER DEFAULT 1,
      prefix_filter_mode TEXT DEFAULT 'include',
      prefix_max_requests INTEGER DEFAULT 20,
      prefix_concurrency INTEGER DEFAULT 1,
      prefix_request_interval_ms INTEGER DEFAULT 500,
      description TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS api_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      token TEXT DEFAULT '',
      description TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      is_system INTEGER DEFAULT 0,
      strip_sms_metadata INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS card_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      channel_id INTEGER NOT NULL,
      batch_id TEXT,
      remark TEXT DEFAULT '',
      status TEXT DEFAULT 'unused' CHECK(status IN ('unused','used','expired')),
      max_attempts INTEGER DEFAULT 3,
      attempts INTEGER DEFAULT 0,
      phone_number TEXT DEFAULT '',
      sms_code TEXT DEFAULT '',
      sms_message TEXT DEFAULT '',
      sms_task_id TEXT DEFAULT '',
      token TEXT DEFAULT '',
      used_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_key_id INTEGER NOT NULL,
      card_code TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      sms_code TEXT DEFAULT '',
      sms_message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (card_key_id) REFERENCES card_keys(id)
    );

    CREATE TABLE IF NOT EXISTS phone_request_jobs (
      card_key_id INTEGER PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'queued',
      message TEXT DEFAULT '',
      request_count INTEGER DEFAULT 0,
      max_requests INTEGER DEFAULT 1,
      attempt_counted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      completed_at TEXT,
      FOREIGN KEY (card_key_id) REFERENCES card_keys(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed admin
  const c = db.prepare('SELECT COUNT(*) as count FROM admins').get();
  if (!c || c.count === 0) {
    const initialAdmin = config.initialAdmin.getCredentials();
    const hash = bcrypt.hashSync(initialAdmin.password, 10);
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run([initialAdmin.username, hash]);
  }

  // Migrations
  try { db.exec("ALTER TABLE channels ADD COLUMN scope TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE card_keys ADD COLUMN max_attempts INTEGER DEFAULT 3"); } catch(e) {}
  try { db.exec("ALTER TABLE card_keys ADD COLUMN attempts INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('default_channel_id', '')"); } catch(e) {}
  try { db.exec("ALTER TABLE card_keys ADD COLUMN is_test INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN prefix TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN prefix_enabled INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN prefix_filter_mode TEXT DEFAULT 'include'"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN prefix_max_requests INTEGER DEFAULT 20"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN prefix_concurrency INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN prefix_request_interval_ms INTEGER DEFAULT 500"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN provider_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN api_keyword TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN api_phone TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN api_province TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE channels ADD COLUMN api_card_type TEXT DEFAULT '全部'"); } catch(e) {}
  try { db.exec("ALTER TABLE api_providers ADD COLUMN is_system INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE api_providers ADD COLUMN strip_sms_metadata INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("UPDATE api_providers SET strip_sms_metadata=1 WHERE strip_sms_metadata IS NULL"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('cooldown_seconds', '60')"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('site_name', '卡密接码')"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('usage_record_retention_days', '90')"); } catch(e) {}
  try { db.exec("UPDATE channels SET prefix_enabled=1 WHERE prefix_enabled IS NULL"); } catch(e) {}
  try { db.exec("UPDATE channels SET prefix_filter_mode='include' WHERE prefix_filter_mode IS NULL OR prefix_filter_mode NOT IN ('include', 'exclude', 'disabled')"); } catch(e) {}
  try { db.exec("UPDATE channels SET prefix_max_requests=20 WHERE prefix_max_requests IS NULL OR prefix_max_requests < 1 OR prefix_max_requests > 20"); } catch(e) {}
  try { db.exec("UPDATE channels SET prefix_concurrency=1 WHERE prefix_concurrency IS NULL OR prefix_concurrency < 1 OR prefix_concurrency > 10"); } catch(e) {}
  try { db.exec("UPDATE channels SET prefix_request_interval_ms=500 WHERE prefix_request_interval_ms IS NULL OR prefix_request_interval_ms < 500 OR prefix_request_interval_ms > 10000"); } catch(e) {}
  // A card whose allocation quota is exhausted is no longer available for a
  // new phone, even when it has not received an SMS yet. Repair old rows that
  // were created before this status rule existed.
  try {
    db.exec("UPDATE card_keys SET status='used' WHERE status='unused' AND attempts >= CASE WHEN max_attempts IS NULL OR max_attempts < 1 THEN 3 ELSE max_attempts END");
  } catch(e) {}

  // Preserve the original qc86 setup as the default provider and bind all
  // existing projects to it. This keeps upgrades backward compatible.
  let defaultQc86Provider = db.prepare("SELECT * FROM api_providers WHERE provider_type='qc86' AND is_system=1 ORDER BY id LIMIT 1").get();
  if (!defaultQc86Provider) {
    const oldUsername = (db.prepare("SELECT value FROM settings WHERE key='qc86_username'").get() || {}).value || '';
    const oldPassword = (db.prepare("SELECT value FROM settings WHERE key='qc86_password'").get() || {}).value || '';
    const oldToken = (db.prepare("SELECT value FROM settings WHERE key='qc86_token'").get() || {}).value || '';
    db.prepare(`
      INSERT INTO api_providers (name, provider_type, base_url, username, password, token, description, is_active, is_system)
      VALUES (?, 'qc86', ?, ?, ?, ?, ?, 1, 1)
    `).run(['qc86.shop（原有）', 'https://api.qc86.shop/api', oldUsername, oldPassword, oldToken, '系统自动迁移的原有 qc86 接口']);
    defaultQc86Provider = db.prepare("SELECT * FROM api_providers WHERE provider_type='qc86' AND is_system=1 ORDER BY id LIMIT 1").get();
  }
  if (defaultQc86Provider) {
    db.prepare('UPDATE channels SET provider_id=? WHERE provider_id IS NULL OR provider_id=0').run([defaultQc86Provider.id]);
  }

  // Create rejected_phones table
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rejected_phones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_key_id INTEGER,
        channel_id INTEGER,
        phone_number TEXT NOT NULL,
        channel_name TEXT DEFAULT '',
        reason TEXT DEFAULT '号段不匹配',
        rejected_at TEXT DEFAULT (datetime('now','localtime')),
        released INTEGER DEFAULT 0,
        released_at TEXT
      )
    `);
  } catch(e) {}
  try { db.exec("ALTER TABLE rejected_phones ADD COLUMN channel_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE phone_request_jobs ADD COLUMN attempt_counted INTEGER DEFAULT 0"); } catch(e) {}


  // Save initial schema to disk and start auto-save
  db._save();
  db._startAutoSave(15000);

  return db;
}

function getDb() { return db; }

function saveDb() { if (db) db._save(); }

function quoteIdentifier(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function tableExists(table) {
  if (!SYNC_TABLES.includes(table) && !SYNC_DELETE_ORDER.includes(table)) return false;
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get([table]));
}

function getTableColumns(table) {
  if (!SYNC_TABLES.includes(table) || !tableExists(table)) return [];
  return db.prepare('PRAGMA table_info(' + quoteIdentifier(table) + ')').all().map(column => column.name);
}

function getSyncStats(tables) {
  return SYNC_TABLES.reduce((stats, table) => {
    stats[table] = Array.isArray(tables[table]) ? tables[table].length : 0;
    return stats;
  }, {});
}

function sanitizeCardForSync(card) {
  const copy = { ...card };
  const hasSms = String(copy.sms_code || '').trim() !== '' || String(copy.sms_message || '').trim() !== '';
  if (!hasSms) {
    copy.phone_number = '';
    copy.token = '';
    copy.sms_task_id = '';
    copy.used_at = null;
  }
  return copy;
}

function createSyncPackage() {
  if (!db) throw new Error('数据库尚未准备好');
  const tables = {};
  SYNC_TABLES.forEach(table => {
    // A few early installations predate rejected_phones and other sync tables.
    // Treat a missing historical table as empty so export never turns into a
    // blank error page during an upgrade.
    const rows = tableExists(table) ? db.prepare('SELECT * FROM ' + quoteIdentifier(table)).all() : [];
    tables[table] = table === 'card_keys' ? rows.map(sanitizeCardForSync) : rows;
  });

  return {
    type: 'qc86-platform-data-sync',
    version: 1,
    exported_at: new Date().toISOString(),
    tables,
    stats: getSyncStats(tables),
    notes: [
      '管理员账户不会同步。',
      '正在等待验证码的临时号码不会同步。'
    ]
  };
}

function validateSyncPackage(syncPackage) {
  if (!syncPackage || typeof syncPackage !== 'object') throw new Error('同步文件格式不正确');
  if (syncPackage.type !== 'qc86-platform-data-sync' || syncPackage.version !== 1) {
    throw new Error('这不是可用的 QC86 数据同步文件');
  }
  if (!syncPackage.tables || typeof syncPackage.tables !== 'object') throw new Error('同步文件缺少数据内容');

  let totalRows = 0;
  SYNC_TABLES.forEach(table => {
    const rows = syncPackage.tables[table];
    if (rows !== undefined && !Array.isArray(rows)) throw new Error(table + ' 数据格式不正确');
    totalRows += Array.isArray(rows) ? rows.length : 0;
  });
  if (totalRows > 200000) throw new Error('同步文件数据量过大，请先清理历史记录后再导入');
}

function createSyncBackup() {
  if (!db) throw new Error('数据库尚未准备好');
  db._save();
  const backupDir = path.join(dir, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = 'before-sync-' + stamp + '.db';
  fs.copyFileSync(DB_PATH, path.join(backupDir, filename));
  return filename;
}

function importSyncPackage(syncPackage) {
  if (!db) throw new Error('数据库尚未准备好');
  validateSyncPackage(syncPackage);
  const backupFilename = createSyncBackup();

  try {
    db.exec('PRAGMA foreign_keys = OFF; BEGIN TRANSACTION;');
    SYNC_DELETE_ORDER.forEach(table => {
      if (tableExists(table)) db.exec('DELETE FROM ' + quoteIdentifier(table));
    });

    SYNC_TABLES.forEach(table => {
      const columns = getTableColumns(table);
      const rows = Array.isArray(syncPackage.tables[table]) ? syncPackage.tables[table] : [];
      if (columns.length === 0) return;
      rows.forEach(row => {
        if (!row || typeof row !== 'object') throw new Error(table + ' 包含无效数据');
        const insertColumns = columns.filter(column => Object.prototype.hasOwnProperty.call(row, column));
        if (insertColumns.length === 0) return;
        const sql = 'INSERT INTO ' + quoteIdentifier(table) + ' (' + insertColumns.map(quoteIdentifier).join(', ') + ') VALUES (' + insertColumns.map(() => '?').join(', ') + ')';
        db.prepare(sql).run(insertColumns.map(column => row[column]));
      });
    });

    db.exec('COMMIT; PRAGMA foreign_keys = ON;');
    db._save();
  } catch (error) {
    try { db.exec('ROLLBACK; PRAGMA foreign_keys = ON;'); } catch (rollbackError) {}
    throw error;
  }

  return {
    backupFilename,
    stats: getSyncStats(syncPackage.tables)
  };
}

function closeDb() { if (db) { db.close(); db = null; } }

module.exports = {
  initDb,
  getDb,
  saveDb,
  closeDb,
  createSyncPackage,
  importSyncPackage
};
