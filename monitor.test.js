const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFunctionResult } = require('viem');

const {
  createTarget,
  createPollingStats,
  canUseBrowserFallback,
  decodeFactoryAssetsResult,
  decodeSymbolResult,
  ERC20_SYMBOL_ABI,
  FACTORY_ABI,
  filterValidAssets,
  getPollingInitialDelay,
  getIssuerInfo,
  getUnderlyingSymbol,
  hasValidAssetAddress,
  recordPollEnd,
  recordPollStart,
  summarizePollingStats,
  targetAssetKey,
  validateChainAssets,
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

test('keeps the configured polling interval while staggering targets', () => {
  assert.equal(getPollingInitialDelay(0, 2, 1200), 1200);
  assert.equal(getPollingInitialDelay(1, 2, 1200), 1800);
});

test('applies browser fallback cooldown without changing RPC polling', () => {
  const target = createTarget('https://flap.sh/launch?vaultfactory=0xABC', 0);
  target.lastBrowserFallbackAt = 10_000;

  assert.equal(canUseBrowserFallback(target, 69_999), false);
  assert.equal(canUseBrowserFallback(target, 70_000), true);
  assert.equal(canUseBrowserFallback(target, 10_001, true), true);
});

test('decodes complete assets from factory and ERC20 RPC results', () => {
  const address = '0xa9ee28c80f960b889dfbd1902055218cba016f75';
  const factoryResult = encodeFunctionResult({
    abi: FACTORY_ABI,
    functionName: 'getSupportedAssetsWithNames',
    result: [[address], ['NVIDIA (Ondo Tokenized)']],
  });
  const symbolResult = encodeFunctionResult({
    abi: ERC20_SYMBOL_ABI,
    functionName: 'symbol',
    result: 'NVDAon',
  });

  const decodedFactory = decodeFactoryAssetsResult(factoryResult);
  assert.equal(decodedFactory[0].address.toLowerCase(), address);
  assert.equal(decodedFactory[0].description, 'NVIDIA (Ondo Tokenized)');
  assert.equal(decodeSymbolResult(symbolResult), 'NVDAon');
  assert.equal(getUnderlyingSymbol('NVDAon'), 'NVDA');
  assert.equal(getUnderlyingSymbol('NVDAB'), 'NVDA');
  assert.equal(getUnderlyingSymbol('AAPL'), 'AAPL');
  assert.equal(validateChainAssets([{
    address: decodedFactory[0].address,
    name: 'NVDAon',
    symbol: 'NVDA',
    description: 'NVIDIA (Ondo Tokenized)',
  }]).length, 1);
});

test('summarizes polling cadence with constant-memory counters', () => {
  const stats = createPollingStats(1000);
  recordPollStart(stats, 2000);
  recordPollEnd(stats, 2000, 'chain', true, 2100);
  recordPollStart(stats, 3300);
  recordPollEnd(stats, 3300, 'browser', false, 3500);

  assert.deepEqual(summarizePollingStats(stats, 4000), {
    windowMs: 3000,
    completed: 2,
    failures: 1,
    chainPolls: 1,
    browserPolls: 1,
    averageStartIntervalMs: 1300,
    averageDurationMs: 150,
  });
});
