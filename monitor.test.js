const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTarget,
  getIssuerInfo,
  targetAssetKey,
} = require('./monitor');

test('creates stable and distinct target identities from Vault URLs', () => {
  const bsc = createTarget('https://flap.sh/launch?vaultfactory=0xABC&lang=zh', 0);
  const robinhood = createTarget('https://flap.sh/launch?vaultfactory=0xABC&chain=robinhood&lang=zh', 1);

  assert.equal(bsc.id, 'bsc:0xabc');
  assert.equal(bsc.label, 'BSC');
  assert.equal(robinhood.id, 'robinhood:0xabc');
  assert.equal(robinhood.label, 'Robinhood');
  assert.notEqual(targetAssetKey(bsc, 'AAPL'), targetAssetKey(robinhood, 'AAPL'));
});

test('identifies issuers using both token suffixes and target chain', () => {
  const robinhood = createTarget('https://flap.sh/launch?vaultfactory=0xABC&chain=robinhood', 0);

  assert.equal(getIssuerInfo('AAPLon').long, 'Ondo Finance');
  assert.equal(getIssuerInfo('NVDAB').long, 'Backed Finance');
  assert.equal(getIssuerInfo('AAPL', robinhood).long, 'Robinhood');
});
