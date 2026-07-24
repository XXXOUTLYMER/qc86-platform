const assert = require('assert');
const { createBatchId, groupCardsByBatch, normalizeBatchId } = require('../services/cardBatches');

const groups = groupCardsByBatch([
  { id: 9, batch_id: 'BNEW', channel_name: '新项目', remark: '自动发货', created_at: '2026-07-24 10:00:00' },
  { id: 8, batch_id: 'BNEW', channel_name: '新项目', remark: '自动发货', created_at: '2026-07-24 10:00:00' },
  { id: 7, batch_id: 'BOLD', channel_name: '旧项目', remark: '', created_at: '2026-07-23 10:00:00' },
  { id: 6, batch_id: null, channel_name: '历史项目', remark: '', created_at: '2026-07-20 10:00:00' },
  { id: 5, batch_id: '', channel_name: '历史项目', remark: '', created_at: '2026-07-19 10:00:00' }
]);

assert.strictEqual(normalizeBatchId(' BNEW '), 'BNEW');
assert.match(createBatchId(1721786400000), /^B[0-9A-Z]+-[0-9A-F]{8}$/);
assert.notStrictEqual(createBatchId(1721786400000), createBatchId(1721786400000));
assert.strictEqual(groups.length, 3);
assert.deepStrictEqual(groups.map((group) => group.key), ['batch:BNEW', 'batch:BOLD', 'legacy']);
assert.strictEqual(groups[0].cards.length, 2);
assert.strictEqual(groups[0].batchId, 'BNEW');
assert.strictEqual(groups[0].isLegacy, false);
assert.strictEqual(groups[2].cards.length, 2);
assert.strictEqual(groups[2].isLegacy, true);

console.log('card batch grouping checks passed');
