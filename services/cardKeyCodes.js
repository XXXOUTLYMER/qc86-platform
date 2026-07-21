const crypto = require('crypto');
const config = require('../config');

// The database id is the source of uniqueness. The HMAC portion prevents a
// customer from deriving usable card keys by observing sequential ids.
const CARD_KEY_ID_WIDTH = 13;
const CARD_KEY_VERSION = 'K';

function normalizeCardId(cardId) {
  const text = String(cardId).trim();
  if (!/^\d+$/.test(text) || text === '0') {
    throw new Error('无法为卡密分配有效编号');
  }
  return BigInt(text);
}

function encodeCardId(cardId) {
  const encoded = normalizeCardId(cardId).toString(36).toUpperCase();
  if (encoded.length > CARD_KEY_ID_WIDTH) {
    throw new Error('卡密编号超过支持范围');
  }
  return encoded.padStart(CARD_KEY_ID_WIDTH, '0');
}

function createSignature(cardId, signingSecret) {
  return crypto
    .createHmac('sha256', signingSecret || config.server.sessionSecret)
    .update(`qc86-card-key-v2:${String(cardId)}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
}

function generateCardCode(cardId, signingSecret) {
  const encodedId = encodeCardId(cardId);
  const signature = createSignature(cardId, signingSecret);

  return [
    `${CARD_KEY_VERSION}${encodedId.slice(0, 4)}`,
    encodedId.slice(4, 8),
    encodedId.slice(8),
    signature.slice(0, 4),
    signature.slice(4, 8),
    signature.slice(8, 12)
  ].join('-');
}

function verifyCardCode(cardId, cardCode, signingSecret) {
  if (typeof cardCode !== 'string') return false;
  const expected = generateCardCode(cardId, signingSecret);
  const actualBuffer = Buffer.from(cardCode);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

module.exports = { generateCardCode, verifyCardCode };
