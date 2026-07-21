const assert = require('assert');
const { generateCardCode, verifyCardCode } = require('../services/cardKeyCodes');

const testSecret = 'card-key-code-test-secret';
const sampleCode = generateCardCode(1, testSecret);

assert.match(sampleCode, /^K[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{5}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
assert.strictEqual(verifyCardCode(1, sampleCode, testSecret), true);
assert.strictEqual(verifyCardCode(2, sampleCode, testSecret), false);

const codes = new Set();
for (let id = 1; id <= 25000; id += 1) {
  codes.add(generateCardCode(id, testSecret));
}
assert.strictEqual(codes.size, 25000, '每一个数据库编号都必须生成不同卡密');

console.log('card key code checks passed');
