function normalizeKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

const BALANCE_KEYS = new Set([
  'balance',
  'balances',
  'amount',
  'money',
  'credit',
  'wallet',
  'leftamount',
  'leftmoney',
  'available',
  'availablebalance',
  'availableamount',
  'remaining',
  'remain',
  'residual',
  'residualbalance',
  'surplus',
  'funds',
  'cash',
  'quota',
  '余额',
  '可用余额',
  '剩余余额',
  '剩余金额'
]);

function isBalanceValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '';
}

function extractProviderBalance(result) {
  if (isBalanceValue(result)) return result;

  const queue = [result];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current === null || current === undefined || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);

    for (const [key, value] of Object.entries(current)) {
      if (BALANCE_KEYS.has(normalizeKey(key)) && isBalanceValue(value)) return value;
      if (normalizeKey(key) === 'data' && isBalanceValue(value)) return value;
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

module.exports = { extractProviderBalance };
