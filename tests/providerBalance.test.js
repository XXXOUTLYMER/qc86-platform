const assert = require('assert');
const { extractProviderBalance } = require('../api/providerBalance');

assert.equal(extractProviderBalance({ success: true, data: { balances: '19.80' } }), '19.80');
assert.equal(extractProviderBalance({ success: true, data: { leftAmount: 18.6 } }), 18.6);
assert.equal(extractProviderBalance({ data: { wallet: { availableBalance: '8.00' } } }), '8.00');
assert.equal(extractProviderBalance({ success: true, data: { projectId: 12, status: 'ok' } }), null);

console.log('provider balance extraction checks passed');
