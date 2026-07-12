const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTarget,
  filterValidAssets,
  getPollingInitialDelay,
  getIssuerInfo,
  hasValidAssetAddress,
  hasRpcResultChanged,
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

test('rejects text-only false positives without contract addresses', () => {
  const target = createTarget('https://flap.sh/launch?vaultfactory=0xABC', 0);
  const candidates = [
    { symbol: 'AI', name: 'AI', description: '人工智能', address: '' },
    { symbol: 'HOME', name: 'HOME', description: '首页', address: '' },
    { symbol: 'NVDA', name: 'NVDAon', description: 'NVIDIA', address: '0xA9eE...6F75' },
  ];

  assert.equal(hasValidAssetAddress(''), false);
  assert.equal(hasValidAssetAddress('0xA9eE...6F75'), true);
  assert.deepEqual(filterValidAssets(candidates, target), [candidates[2]]);
});

test('identifies issuers using both token suffixes and target chain', () => {
  const robinhood = createTarget('https://flap.sh/launch?vaultfactory=0xABC&chain=robinhood', 0);

  assert.equal(getIssuerInfo('AAPLon').long, 'Ondo Finance');
  assert.equal(getIssuerInfo('NVDAB').long, 'Backed Finance');
  assert.equal(getIssuerInfo('AAPL', robinhood).long, 'Robinhood');
});

test('detects RPC changes without altering the configured polling interval', () => {
  const probe = { signature: JSON.stringify('0x1234') };

  assert.equal(hasRpcResultChanged(probe, { result: '0x1234' }), false);
  assert.equal(hasRpcResultChanged(probe, { result: '0x5678' }), true);
  assert.equal(getPollingInitialDelay(0, 2, 1200), 1200);
  assert.equal(getPollingInitialDelay(1, 2, 1200), 1800);
});
