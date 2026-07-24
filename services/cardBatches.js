const crypto = require('crypto');

function normalizeBatchId(value) {
  return String(value || '').trim();
}

function createBatchId(now = Date.now()) {
  const timestamp = Number(now).toString(36).toUpperCase();
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `B${timestamp}-${randomPart}`;
}

function groupCardsByBatch(cards) {
  const groups = [];
  const groupsByKey = new Map();

  (cards || []).forEach((card) => {
    const batchId = normalizeBatchId(card.batch_id);
    const key = batchId ? `batch:${batchId}` : 'legacy';
    let group = groupsByKey.get(key);

    if (!group) {
      group = {
        key,
        batchId,
        isLegacy: !batchId,
        cards: [],
        channelName: card.channel_name || '',
        remark: card.remark || '',
        createdAt: card.created_at || ''
      };
      groupsByKey.set(key, group);
      groups.push(group);
    }

    group.cards.push(card);
  });

  return groups;
}

module.exports = { createBatchId, groupCardsByBatch, normalizeBatchId };
