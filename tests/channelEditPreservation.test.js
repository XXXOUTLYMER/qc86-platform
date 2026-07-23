const assert = require('assert');
const path = require('path');

const databasePath = require.resolve('../database');
const authPath = require.resolve('../middleware/auth');
const originalDatabase = require.cache[databasePath];
const originalAuth = require.cache[authPath];

const currentChannel = {
  id: 42,
  name: '原项目',
  channel_id: 'channel-original',
  provider_id: 1,
  api_keyword: '原关键词',
  api_phone: '17000000000',
  api_province: '广东',
  api_card_type: '实卡',
  operator: 5,
  scope: '旧地区范围',
  direct_scope: '170',
  prefix: '170,171',
  prefix_enabled: 1,
  prefix_filter_mode: 'include',
  prefix_max_requests: 12,
  prefix_concurrency: 3,
  prefix_request_interval_ms: 1000,
  description: '原备注',
  is_active: 1
};

const provider = { id: 1, provider_type: 'qc86' };
let lastUpdate = null;
let saveCount = 0;

const fakeDb = {
  prepare(sql) {
    return {
      get(params) {
        if (sql.includes('SELECT * FROM channels WHERE id=?')) return { ...currentChannel, id: Number(params[0]) };
        if (sql.includes('SELECT * FROM api_providers WHERE id=?')) return String(params[0]) === '1' ? provider : undefined;
        if (sql.includes('SELECT id, direct_scope FROM channels WHERE id=?')) {
          return { id: Number(params[0]), direct_scope: currentChannel.direct_scope };
        }
        if (sql.includes('FROM channels') && sql.includes('LEFT JOIN api_providers')) {
          return { id: Number(params[0]), provider_id: currentChannel.provider_id, provider_type: provider.provider_type };
        }
        throw new Error('Unexpected query: ' + sql);
      },
      run(params) {
        if (!sql.includes('UPDATE channels')) throw new Error('Unexpected write: ' + sql);
        lastUpdate = params;
        currentChannel.direct_scope = sql.includes('SET direct_scope=?') ? params[0] : params[9];
        return { changes: 1 };
      }
    };
  }
};

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { getDb: () => fakeDb, saveDb: () => { saveCount += 1; } }
};
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: { requireAdmin: (req, res, next) => next() }
};

const adminRouter = require('../routes/admin');
const editLayer = adminRouter.stack.find(layer => layer.route && layer.route.path === '/channels/edit/:id');
const editHandler = editLayer.route.stack[editLayer.route.stack.length - 1].handle;
const directScopeLayer = adminRouter.stack.find(layer => layer.route && layer.route.path === '/channels/:id/direct-scope');
const directScopeHandler = directScopeLayer.route.stack[directScopeLayer.route.stack.length - 1].handle;

function edit(body) {
  let redirectTarget = '';
  editHandler(
    { body, params: { id: '42' }, session: { admin: { id: 1 } }, query: {} },
    {
      redirect(target) { redirectTarget = target; },
      render() { throw new Error('The edit request should not render an error page'); }
    }
  );
  assert.ok(redirectTarget.startsWith('/admin/channels?success='));
  assert.strictEqual(saveCount > 0, true);
}

// A partial form submission must not wipe settings that the browser did not send.
edit({ direct_scope: '171' });
assert.strictEqual(lastUpdate[0], '原项目');
assert.strictEqual(lastUpdate[1], 'channel-original');
assert.strictEqual(lastUpdate[3], '原关键词');
assert.strictEqual(lastUpdate[4], '17000000000');
assert.strictEqual(lastUpdate[8], '旧地区范围');
assert.strictEqual(lastUpdate[9], '171');
assert.strictEqual(lastUpdate[10], '170,171');
assert.strictEqual(lastUpdate[11], 1);
assert.strictEqual(lastUpdate[12], 'include');
assert.strictEqual(lastUpdate[13], 12);
assert.strictEqual(lastUpdate[14], 3);
assert.strictEqual(lastUpdate[15], 1000);
assert.strictEqual(lastUpdate[16], '原备注');

// An explicit blank value is still respected, so an administrator can remove it.
edit({ direct_scope: '' });
assert.strictEqual(lastUpdate[9], '');

// The dedicated endpoint must only touch direct_scope and then read it back.
let directScopePayload = null;
directScopeHandler(
  { body: { direct_scope: '172' }, params: { id: '42' }, session: { admin: { id: 1 } } },
  {
    status() { return this; },
    json(payload) { directScopePayload = payload; }
  }
);
assert.deepStrictEqual(directScopePayload, {
  success: true,
  direct_scope: '172',
  message: 'API 指定号段已保存：172'
});
assert.strictEqual(currentChannel.direct_scope, '172');

if (originalDatabase) require.cache[databasePath] = originalDatabase;
else delete require.cache[databasePath];
if (originalAuth) require.cache[authPath] = originalAuth;
else delete require.cache[authPath];

console.log('channel edit preservation checks passed');
