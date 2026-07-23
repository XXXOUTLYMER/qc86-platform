const { getDb, saveDb } = require('../database');
const providerService = require('../api/providerService');

const RELEASE_DELAY_MS = 10000;
const releaseTimers = new Map();

function findChannel(db, record) {
  if (record.channel_id) {
    const channel = db.prepare('SELECT * FROM channels WHERE id=?').get([record.channel_id]);
    if (channel) return channel;
  }
  return db.prepare('SELECT * FROM channels WHERE name=?').get([record.channel_name]);
}

async function releaseRejectedPhone(recordId) {
  const numericId = Number(recordId);
  const existingTimer = releaseTimers.get(numericId);
  if (existingTimer) clearTimeout(existingTimer);
  releaseTimers.delete(numericId);

  const db = getDb();
  const record = db.prepare('SELECT * FROM rejected_phones WHERE id=? AND released=0').get([recordId]);
  if (!record) return false;

  const channel = findChannel(db, record);
  if (!channel) throw new Error('找不到拒绝号码对应的项目');

  const provider = providerService.getProviderForChannel(channel);
  const token = await providerService.getToken(provider);

  try {
    await providerService.blacklistPhone(provider, channel, token, record.phone_number);
  } catch (e) {
    console.error('Failed to blacklist rejected phone ' + record.phone_number + ':', e.message);
  }

  const releaseResult = await providerService.releasePhone(provider, channel, token, record.phone_number);
  if (releaseResult && releaseResult.success === false) {
    throw new Error(releaseResult.msg || 'API释放号码失败');
  }

  db.prepare("UPDATE rejected_phones SET released=1, released_at=datetime('now','localtime') WHERE id=? AND released=0").run([recordId]);
  saveDb();
  return true;
}

function scheduleRejectedPhoneRelease(recordId, delayMs = RELEASE_DELAY_MS, retryAttempt = 0) {
  const id = Number(recordId);
  if (!id || releaseTimers.has(id)) return;

  const timer = setTimeout(() => {
    releaseRejectedPhone(id).catch(e => {
      console.error('Failed to release rejected phone record ' + id + ':', e.message);
      const retryDelay = Math.min(300000, RELEASE_DELAY_MS * Math.pow(2, Math.min(retryAttempt, 5)));
      scheduleRejectedPhoneRelease(id, retryDelay, retryAttempt + 1);
    });
  }, Math.max(0, delayMs));
  if (timer.unref) timer.unref();
  releaseTimers.set(id, timer);
}

function registerRejectedPhone({ cardId = null, channelId, phone, channelName = '', reason = '号段不匹配', deferSave = false, releaseDelayMs = RELEASE_DELAY_MS }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO rejected_phones (card_key_id, channel_id, phone_number, channel_name, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run([cardId, channelId || null, String(phone), channelName, String(reason || '号段不匹配')]);

  const inserted = db.prepare('SELECT last_insert_rowid() AS id').get();
  if (!inserted || !inserted.id) throw new Error('未能记录不匹配号码');

  // Prefix filtering may reject up to 20 numbers in one task. The caller can
  // batch those writes and persist once the task completes, keeping the user
  // page responsive while preserving the delayed release timer immediately.
  if (!deferSave) saveDb();
  if (releaseDelayMs !== null && releaseDelayMs !== false) {
    scheduleRejectedPhoneRelease(inserted.id, releaseDelayMs);
  }
  return inserted.id;
}

function resumePendingRejectedPhoneReleases() {
  const db = getDb();
  const pending = db.prepare('SELECT id FROM rejected_phones WHERE released=0 ORDER BY id ASC').all();
  pending.forEach((record, index) => scheduleRejectedPhoneRelease(record.id, index * 250));
  return pending.length;
}

module.exports = {
  RELEASE_DELAY_MS,
  registerRejectedPhone,
  releaseRejectedPhone,
  resumePendingRejectedPhoneReleases
};
