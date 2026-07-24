const assert = require('assert');

const databasePath = require.resolve('../database');
const phoneRequestsPath = require.resolve('../services/phoneRequests');
const userRoutePath = require.resolve('../routes/user');

const originalDatabase = require.cache[databasePath];
const originalPhoneRequests = require.cache[phoneRequestsPath];
const originalUserRoute = require.cache[userRoutePath];

const oldCard = {
  id: 1,
  code: 'OLD-CARD',
  channel_id: 9,
  phone_number: '17000000001',
  sms_code: '123456',
  sms_message: '验证码 123456',
  attempts: 1,
  max_attempts: 3,
  used_at: null,
  is_test: 0
};
const newCard = {
  id: 2,
  code: 'NEW-CARD',
  channel_id: 9,
  phone_number: '',
  sms_code: '',
  sms_message: '',
  attempts: 0,
  max_attempts: 3,
  used_at: null,
  is_test: 0
};
const cardsById = new Map([[oldCard.id, oldCard], [newCard.id, newCard]]);
const cardsByCode = new Map([[oldCard.code, oldCard], [newCard.code, newCard]]);

const fakeDb = {
  prepare(sql) {
    return {
      all() {
        if (sql.includes('SELECT id, name FROM channels WHERE is_active=1')) {
          return [{ id: 9, name: '测试项目' }];
        }
        throw new Error('Unexpected all query: ' + sql);
      },
      get(params = []) {
        const value = Array.isArray(params) ? params[0] : params;
        if (sql.includes('SELECT * FROM card_keys WHERE code = ?')) return cardsByCode.get(value);
        if (sql.includes('SELECT * FROM card_keys WHERE id = ?')) return cardsById.get(Number(value));
        if (sql.includes('FROM usage_records')) return undefined;
        if (sql.includes('SELECT name FROM channels WHERE id = ?')) return { name: '测试项目' };
        if (sql.includes('SELECT ap.strip_sms_metadata')) return { strip_sms_metadata: 1 };
        if (sql.includes("SELECT value FROM settings WHERE key='cooldown_seconds'")) return { value: '60' };
        throw new Error('Unexpected get query: ' + sql);
      }
    };
  }
};

require.cache[databasePath] = { exports: { getDb: () => fakeDb } };
require.cache[phoneRequestsPath] = { exports: { getPhoneRequestJob: () => null } };
delete require.cache[userRoutePath];

const router = require('../routes/user');
const homeHandler = router.stack.find((layer) => layer.route && layer.route.path === '/' && layer.route.methods.get).route.stack[0].handle;

function renderHome(query, session) {
  const response = {
    rendered: null,
    render(view, locals) {
      this.rendered = { view, locals };
      return this.rendered;
    }
  };
  homeHandler({ query, session }, response);
  return response.rendered;
}

try {
  const newCardSession = { lastCardId: oldCard.id };
  const newCardPage = renderHome({ card: newCard.code }, newCardSession);
  assert.equal(newCardSession.lastCardId, newCard.id, '新链接必须替换旧会话卡密');
  assert.equal(newCardPage.locals.step, 'enter_card');
  assert.equal(newCardPage.locals.cardCode, newCard.code);
  assert.equal(newCardPage.locals.phoneNumber, '', '新卡不得显示旧卡手机号');
  assert.equal(newCardPage.locals.smsCode, '', '新卡不得显示旧卡验证码');

  const oldCardSession = { lastCardId: newCard.id };
  const oldCardPage = renderHome({ card: oldCard.code }, oldCardSession);
  assert.equal(oldCardSession.lastCardId, oldCard.id);
  assert.equal(oldCardPage.locals.step, 'waiting');
  assert.equal(oldCardPage.locals.cardCode, oldCard.code);
  assert.equal(oldCardPage.locals.phoneNumber, oldCard.phone_number);

  const fallbackSession = { lastCardId: oldCard.id };
  const fallbackPage = renderHome({}, fallbackSession);
  assert.equal(fallbackPage.locals.step, 'waiting', '无链接参数时仍应恢复当前会话卡密');
  assert.equal(fallbackPage.locals.cardCode, oldCard.code);

  console.log('user card session priority checks passed');
} finally {
  if (originalDatabase) require.cache[databasePath] = originalDatabase;
  else delete require.cache[databasePath];
  if (originalPhoneRequests) require.cache[phoneRequestsPath] = originalPhoneRequests;
  else delete require.cache[phoneRequestsPath];
  if (originalUserRoute) require.cache[userRoutePath] = originalUserRoute;
  else delete require.cache[userRoutePath];
}
