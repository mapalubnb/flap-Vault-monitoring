require('dotenv').config();
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- Config ---
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL;
const DEFAULT_FLAP_URLS = [
  'https://flap.sh/launch?vaultfactory=0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5&lang=zh',
  'https://flap.sh/launch?vaultfactory=0xe6ca297D1d963b6F00d5b216986123CAeB883AF6&chain=robinhood&lang=zh',
];
const FLAP_URLS = (process.env.FLAP_URLS || process.env.FLAP_URL || DEFAULT_FLAP_URLS.join(','))
  .split(/[\r\n,]+/)
  .map((url) => url.trim())
  .filter(Boolean);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 1500;
const PAGE_WAIT = parseInt(process.env.PAGE_WAIT, 10) || 8000;
const SCRAPE_TIMEOUT = Math.max(PAGE_WAIT, 5000);
const FULL_REFRESH_INTERVAL = parseInt(process.env.FULL_REFRESH_INTERVAL, 10) || 30 * 60 * 1000;
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL, 10) || 60 * 1000;
const STATE_FILE = path.join(__dirname, 'known_assets.json');
const MAX_CONSECUTIVE_ERRORS = 10;

function createTarget(url, index) {
  const parsed = new URL(url);
  const factory = parsed.searchParams.get('vaultfactory') || `target-${index + 1}`;
  const chain = (parsed.searchParams.get('chain') || 'bsc').toLowerCase();
  return {
    id: `${chain}:${factory.toLowerCase()}`,
    label: chain === 'robinhood' ? 'Robinhood' : chain.toUpperCase(),
    chain,
    factory,
    url,
    context: null,
    page: null,
    baselineEstablished: false,
    isPolling: false,
    consecutiveErrors: 0,
    lastDebugSnapshotAt: 0,
    lastFullScrapeAt: 0,
    lastHeartbeatAt: 0,
    lastLoggedSignature: '',
    lastAssets: [],
    rpcProbes: [],
    pendingRpcProbes: new Map(),
    capturingRpcProbes: false,
    debugSnapshotFile: path.join(__dirname, `debug-flap-empty-${chain}-${factory.slice(2, 10)}.html`),
  };
}

const targets = FLAP_URLS.map(createTarget);

// --- Chinese name mapping ---
// Built-in cache for common US stocks (translation APIs can't reliably translate proper nouns)
const CHINESE_NAMES = {
  'NVDA': '英伟达', 'NVIDIA': '英伟达',
  'AAPL': '苹果', 'Apple': '苹果',
  'TSLA': '特斯拉', 'Tesla': '特斯拉',
  'MSFT': '微软', 'Microsoft': '微软',
  'GOOG': '谷歌', 'GOOGL': '谷歌', 'Alphabet': '谷歌',
  'AMZN': '亚马逊', 'Amazon': '亚马逊',
  'META': 'Meta(脸书)', 'Meta': 'Meta(脸书)',
  'NFLX': '奈飞', 'Netflix': '奈飞',
  'AMD': 'AMD超威半导体', 'INTC': '英特尔', 'Intel': '英特尔',
  'BABA': '阿里巴巴', 'PDD': '拼多多', 'JD': '京东',
  'COIN': 'Coinbase', 'PLTR': 'Palantir',
  'CRM': '赛富时', 'ORCL': '甲骨文', 'Oracle': '甲骨文',
  'DIS': '迪士尼', 'Disney': '迪士尼',
  'BA': '波音', 'Boeing': '波音',
  'JPM': '摩根大通', 'V': 'Visa维萨', 'MA': '万事达',
  'WMT': '沃尔玛', 'KO': '可口可乐', 'PEP': '百事可乐',
  'NKE': '耐克', 'SBUX': '星巴克',
  'SPY': '标普500ETF', 'QQQ': '纳指100ETF',
  'BRK': '伯克希尔', 'Berkshire': '伯克希尔',
  'UNH': '联合健康', 'XOM': '埃克森美孚', 'CVX': '雪佛龙',
  'AVGO': '博通', 'QCOM': '高通', 'Qualcomm': '高通',
  'ADBE': 'Adobe', 'PYPL': 'PayPal贝宝',
  'IBM': 'IBM', 'CSCO': '思科', 'Cisco': '思科',
  'TSM': '台积电', 'SONY': '索尼', 'TM': '丰田',
  'SPCX': 'SpaceX', 'SpaceX': 'SpaceX',
};

// Map flap.sh token-name suffix to issuer information.
//   "AAPLon" -> Ondo Finance
//   "NVDAB"  -> Backed Finance (bStocks)
function getIssuerInfo(tokenName = '', target = null) {
  if (target?.chain === 'robinhood') {
    return { short: 'Robinhood', long: 'Robinhood', chinese: 'Robinhood Token', cardTemplate: 'blue' };
  }
  if (/on$/.test(tokenName)) {
    return { short: 'Ondo', long: 'Ondo Finance', chinese: 'Ondo 代币化', cardTemplate: 'red' };
  }
  if (/B$/.test(tokenName) && tokenName.length > 3) {
    return { short: 'Backed', long: 'Backed Finance', chinese: 'bStocks 代币化', cardTemplate: 'yellow' };
  }
  return { short: '未知', long: '未知发行方', chinese: '未知发行方', cardTemplate: 'orange' };
}

function formatChineseTime() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function formatAddressForDisplay(address) {
  return address || '页面未显示';
}

function hasValidAssetAddress(address = '') {
  return /^0x[a-fA-F0-9]{40}$/.test(address) ||
    /^0x[a-fA-F0-9]{3,10}\.{2,4}[a-fA-F0-9]{3,10}$/.test(address);
}

function filterValidAssets(assets, target = null) {
  const valid = [];
  for (const asset of assets || []) {
    if (asset?.symbol && asset?.name && hasValidAssetAddress(asset.address)) {
      valid.push(asset);
    } else {
      console.warn(
        `[SCRAPE${target ? `:${target.label}` : ''}] Ignored invalid asset candidate: ` +
        JSON.stringify(asset)
      );
    }
  }
  return valid;
}

function formatAssetSummary(asset, target = null) {
  const issuer = getIssuerInfo(asset.name, target);
  return `${asset.name} | ${asset.symbol} | ${issuer.long} | ${formatAddressForDisplay(asset.address)}`;
}

// Try to get Chinese name: first check cache by symbol, then by company name from description
function getChineseName(symbol, description) {
  // Direct symbol match
  if (CHINESE_NAMES[symbol]) return CHINESE_NAMES[symbol];

  // Extract company name from description (e.g. "NVIDIA (Ondo Tokenized)" -> "NVIDIA")
  const companyMatch = description?.match(/^(.+?)\s*\(/);
  if (companyMatch) {
    const company = companyMatch[1].trim();
    if (CHINESE_NAMES[company]) return CHINESE_NAMES[company];
    // Try first word (e.g. "Alphabet Class A" -> "Alphabet")
    const firstWord = company.split(/\s+/)[0];
    if (CHINESE_NAMES[firstWord]) return CHINESE_NAMES[firstWord];
  }

  return null; // No match found
}

// Translate via free Google Translate API (fallback for unknown stocks)
async function translateToChineseAPI(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const res = await axios.get(url, { timeout: 5000 });
    if (res.data && res.data[0] && res.data[0][0]) {
      return res.data[0][0][0];
    }
  } catch (err) {
    console.warn('[TRANSLATE] API error:', err.message);
  }
  return null;
}

// Get Chinese name with fallback: cache -> API -> original
async function getChineseNameWithFallback(symbol, description) {
  const cached = getChineseName(symbol, description);
  if (cached) return cached;

  // Extract company name for translation
  const companyMatch = description?.match(/^(.+?)\s*\(/);
  const companyName = companyMatch ? companyMatch[1].trim() : symbol;
  const translated = await translateToChineseAPI(companyName);
  if (translated && translated !== companyName) {
    // Cache the result for future use
    CHINESE_NAMES[symbol] = translated;
    return translated;
  }

  return companyName; // Return English name as last resort
}

// --- Placeholder stubs, filled in sections below ---
let browser = null;
let knownAssets = new Map(); // target id + token name -> persisted asset

function targetAssetKey(target, tokenName) {
  return `${target.id}::${tokenName}`;
}

// --- State persistence ---
// Keys include the target id and token name, so both multi-issuer variants and
// same-name assets on different Vault Factory pages remain independent.
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      // Backward-compat: migrate legacy symbol/name keys to the first target.
      const migrated = {};
      let migratedCount = 0;
      for (const [key, value] of Object.entries(data)) {
        if (!value || typeof value !== 'object') continue;
        const tokenName = value.name || key;
        const effectiveKey = key.includes('::') ? key : targetAssetKey(targets[0], tokenName);
        if (effectiveKey !== key) migratedCount++;
        migrated[effectiveKey] = {
          ...value,
          targetId: value.targetId || targets[0].id,
        };
      }
      knownAssets = new Map(Object.entries(migrated));
      console.log(`[STATE] Loaded ${knownAssets.size} known assets: ${[...knownAssets.keys()].join(', ')}`);
      if (migratedCount > 0) {
        console.log(`[STATE] Migrated ${migratedCount} legacy entries to target-scoped keys`);
        saveState();
      }
    }
  } catch (err) {
    console.error('[STATE] Failed to load state:', err.message);
  }
}

function saveState() {
  try {
    const obj = Object.fromEntries(knownAssets);
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('[STATE] Failed to save state:', err.message);
  }
}

// --- Feishu notification ---
async function sendFeishu(title, content, template = 'red', target = null) {
  if (!FEISHU_WEBHOOK_URL) {
    console.warn('[FEISHU] No webhook URL configured, skipping notification');
    return;
  }
  try {
    const card = {
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: title },
          template: template,
        },
        elements: [
          {
            tag: 'markdown',
            content: content,
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '打开监控页面' },
                url: target?.url || targets[0].url,
                type: 'primary',
              },
            ],
          },
          {
            tag: 'note',
            elements: [
              { tag: 'plain_text', content: `Flap 监控 · ${formatChineseTime()}` },
            ],
          },
        ],
      },
    };
    const res = await axios.post(FEISHU_WEBHOOK_URL, card, { timeout: 10000 });
    if (res.data && res.data.code === 0) {
      console.log(`[FEISHU] Sent notification: ${title}`);
    } else {
      console.error('[FEISHU] Send failed:', JSON.stringify(res.data));
    }
  } catch (err) {
    console.error('[FEISHU] Request error:', err.message);
  }
}

async function notifyNewStock(stock, target) {
  const title = '🚨 新增可分红股票！';
  const cnName = await getChineseNameWithFallback(stock.symbol, stock.description);
  const issuer = getIssuerInfo(stock.name, target);
  const content = [
    `**监控页面：** ${target.label}`,
    `**Vault Factory：** ${target.factory}`,
    `**资产代码：** ${stock.symbol}`,
    `**中文名称：** ${cnName}`,
    `**Token 名称：** ${stock.name}`,
    `**发行方：** ${issuer.long}（${issuer.chinese}）`,
    `**合约地址：** ${formatAddressForDisplay(stock.address)}`,
    `**发现时间：** ${formatChineseTime()}`,
  ].join('\n');
  await sendFeishu(title, content, issuer.cardTemplate, target);
}

async function notifyStartup(assets, target) {
  const title = `✅ Flap ${target.label} 监控已启动`;
  const lines = [];
  for (const a of assets) {
    const cnName = await getChineseNameWithFallback(a.symbol, a.description);
    const issuer = getIssuerInfo(a.name, target);
    lines.push(`• ${a.name} · ${a.symbol} · ${cnName} · ${issuer.long}`);
  }
  const list = lines.join('\n');
  const content = [
    `**轮询间隔：** ${POLL_INTERVAL / 1000} 秒`,
    `**Vault Factory：** ${target.factory}`,
    `**当前已知资产（共 ${assets.length} 个）：**`,
    list || '暂无已知资产',
  ].join('\n');
  await sendFeishu(title, content, 'green', target);
}

async function notifyError(msg, target) {
  const title = `⚠️ Flap ${target.label} 监控异常`;
  const content = `**Vault Factory：** ${target.factory}\n**错误信息：** ${msg}`;
  await sendFeishu(title, content, 'orange', target);
}

// --- Browser management ---
async function initBrowser() {
  console.log('[BROWSER] Launching...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
    ],
  });
  await Promise.all(targets.map(initTargetPage));
  console.log('[BROWSER] Ready');
}

async function initTargetPage(target) {
  target.context = await browser.createBrowserContext();
  target.page = await target.context.newPage();
  await target.page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );
  await target.page.setRequestInterception(true);
  target.page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });
  target.page.on('response', (response) => captureRpcProbe(target, response));
}

async function captureRpcProbe(target, response) {
  if (!target.capturingRpcProbes) return;
  const request = response.request();
  if (request.method() !== 'POST' || !['fetch', 'xhr'].includes(request.resourceType())) return;

  try {
    const payload = JSON.parse(request.postData() || '');
    const factoryNeedle = target.factory.toLowerCase().replace(/^0x/, '');
    if (payload.method !== 'eth_call' || !JSON.stringify(payload.params).toLowerCase().includes(factoryNeedle)) return;

    const data = await response.json();
    if (!data || data.error || data.result == null) return;
    const key = `${request.url()}::${JSON.stringify(payload.params)}`;
    target.pendingRpcProbes.set(key, {
      key,
      url: request.url(),
      payload,
      signature: JSON.stringify(data.result),
    });
  } catch (_) {
    // Non-JSON and interrupted responses are not suitable as lightweight probes.
  }
}

async function closeTargetPage(target) {
  await target.context?.close().catch(() => {});
  target.context = null;
  target.page = null;
}

async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    for (const target of targets) {
      target.context = null;
      target.page = null;
    }
  }
}

async function extractAssetsFromPage(page) {
  return page.evaluate(() => {
    // Full 40-hex address OR the truncated UI form `0x390a...18c4` (flap.sh v2 layout
    // only renders truncated addresses in the DOM; full addresses are loaded into
    // client-side state and never reach the rendered HTML).
    const FULL_ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
    const TRUNC_ADDRESS_RE = /0x[a-fA-F0-9]{3,10}\.{2,4}[a-fA-F0-9]{3,10}/;
    const ANY_ADDRESS_RE = new RegExp(
      `(${FULL_ADDRESS_RE.source})|(${TRUNC_ADDRESS_RE.source})`
    );
    // Token-name conventions observed on flap.sh:
    //   "AAPLon" -> Ondo Finance tokenized stock
    //   "NVDAB"  -> Backed Finance ("bStocks") tokenized stock
    //   "MUB"    -> plain token name without an issuer suffix
    const TOKEN_RE = /\b[A-Z0-9]{3,12}(?:on|B)\b/;

    const clean = (value = '') =>
      value
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
    const linesFrom = (value = '') =>
      clean(value)
        .split(/\n+/)
        .map((line) => clean(line))
        .filter(Boolean);
    const textOf = (el) => clean(el?.innerText || el?.textContent || '');
    const isSymbol = (value) => /^[A-Z0-9.]{1,12}$/.test(value);
    const isTokenName = (value) => /^[A-Z0-9]{2,12}(?:on|B)?$/.test(value);
    const stripStableSuffix = (value = '') => {
      if (/on$/.test(value)) return value.slice(0, -2);
      if (/B$/.test(value) && value.length > 3) return value.slice(0, -1);
      return value;
    };
    const matchAddress = (value = '') => value.match(ANY_ADDRESS_RE)?.[0] || '';
    const parseTokenDescriptionLine = (line = '') => {
      const text = clean(line);
      const suffixed = text.match(/\b[A-Z0-9]{3,12}(?:on|B)\b/);
      if (suffixed) {
        return {
          name: suffixed[0],
          description: clean(text.slice(suffixed.index + suffixed[0].length).replace(/^[\s·•路-]+/, '').replace(ANY_ADDRESS_RE, '')),
        };
      }

      const plain = text.match(/^([A-Z0-9]{2,12})\b/);
      if (!plain) return null;
      return {
        name: plain[1],
        description: clean(text.slice(plain[1].length).replace(/^[\s·•路-]+/, '').replace(ANY_ADDRESS_RE, '')),
      };
    };

    function normalizeAsset(asset) {
      const name = clean(asset.name);
      const address = matchAddress(clean(asset.address));
      let symbol = clean(asset.symbol).replace(/[^A-Z0-9.]/g, '');
      const symbolFromToken = isTokenName(name) ? stripStableSuffix(name) : '';
      // The visible symbol pill (e.g. "GOOG") sometimes differs from the token-name
      // root (e.g. "GOOGLon" -> "GOOGL"); the token-name root is the authoritative
      // identifier used in known_assets.json.
      if (symbolFromToken) symbol = symbolFromToken;

      const description = clean(asset.description) || `${symbol || name} Tokenized`;

      // Every real supported-asset button currently exposes a full or truncated
      // contract address. Requiring it prevents page text such as AI/HOME from
      // being accepted by the broad legacy fallbacks during transient renders.
      if (!isSymbol(symbol) || !isTokenName(name) || !address) return null;
      return { symbol, name, description, address };
    }

    function parseAssetFromText(text) {
      const lines = linesFrom(text);
      const joined = lines.join('\n');
      const address = matchAddress(joined);
      const tokenDescriptionLine = lines.map(parseTokenDescriptionLine).find(Boolean);
      const name =
        tokenDescriptionLine?.name ||
        lines.find((line) => /^[A-Z0-9]{3,12}(?:on|B)$/.test(line)) ||
        joined.match(TOKEN_RE)?.[0] ||
        '';
      const symbolFromToken = isTokenName(name) ? stripStableSuffix(name) : '';
      const symbol =
        lines.find((line) => isSymbol(line) && line !== name && line !== symbolFromToken + 'on') ||
        symbolFromToken;
      const description =
        tokenDescriptionLine?.description ||
        lines.find((line) => /\bTokenized\b/i.test(line)) ||
        lines.find((line) => /\bOndo\b/i.test(line)) ||
        lines.find((line) => /\bbStocks?\b/i.test(line)) ||
        lines.find((line) =>
          line !== name &&
          line !== symbol &&
          !ANY_ADDRESS_RE.test(line) &&
          !/asset choices|choose provider|资产选项|資產選項|选择发行方|選擇發行方/i.test(line) &&
          !/^\d+\s*(个|個)?\s*(asset\s+choices|资产选项|資產選項)$/i.test(line)
        ) ||
        '';

      return normalizeAsset({ symbol, name, description, address });
    }

    const candidates = [];

    // ---- Strategy 1: target the current v2 supported-assets buttons directly. ----
    // Each single-issuer asset is a <button aria-pressed="true|false"> containing:
    //   <div ... font-mono ...>SYMBOL</div>
    //   <span class="block truncate text-sm font-semibold text-white">SYMBOLon</span>
    //   <span class="mt-0.5 block truncate text-xs ...">Description (Ondo Tokenized)</span>
    //   <span class="font-mono text-xs ...">0xXXXX...YYYY</span>
    //
    // Multi-issuer assets (NVDA / SPCX / TSLA / ...) instead show a "Choose
    // provider" parent and only render the actual issuer rows once expanded.
    // Each expanded issuer row is a child <button class="... rounded-[8px] bg-[#384152] ...">:
    //   <span class="shrink-0 text-sm font-semibold text-white">SYMBOLon|SYMBOLB</span>
    //   <span class="min-w-0 truncate font-mono text-xs ...">0xXXXX...YYYY</span>
    //   <span class="mt-2 block truncate text-sm ...">Description</span>
    const pressedButtons = [...document.querySelectorAll('button[aria-pressed]')];
    const v2Buttons = pressedButtons.length > 0
      ? pressedButtons
      : [...document.querySelectorAll('button[role="tab"], button')];
    for (const btn of v2Buttons) {
      const nameNode = btn.querySelector(
        'span.text-sm.font-semibold, span.truncate.text-sm.font-semibold, p.truncate.text-sm.font-semibold'
      );
      const name = clean(nameNode?.textContent || '');
      const tokenDescriptionNodes = [
        ...btn.querySelectorAll(
          'span.mt-0\\.5, span.mt-2, span.truncate.text-xs, span.truncate.text-sm, p.mt-0\\.5.truncate'
        ),
      ];
      const tokenDescriptionLine =
        tokenDescriptionNodes
          .map((el) => parseTokenDescriptionLine(el.textContent || ''))
          .find(Boolean) ||
        linesFrom(textOf(btn)).map(parseTokenDescriptionLine).find(Boolean);
      if (!tokenDescriptionLine) continue;

      const symbolNode = btn.querySelector('div.font-mono, div.grid.font-mono');
      // Description selectors cover both single-issuer (mt-0.5 / text-xs) AND
      // child issuer rows (mt-2 / text-sm). We pick the first matching span
      // whose text is NOT the token name and NOT an address.
      const descCandidates = tokenDescriptionNodes
        .map((el) => clean(el.textContent || ''))
        .filter((t) => t && t !== name && !ANY_ADDRESS_RE.test(t));
      const description = tokenDescriptionLine?.description || descCandidates[0] || '';

      const addressNode = [...btn.querySelectorAll('span.font-mono, p.font-mono, [class*="font-mono"], code')]
        .map((el) => clean(el.textContent || ''))
        .find((t) => ANY_ADDRESS_RE.test(t));
      const address = addressNode || matchAddress(textOf(btn));
      if (!address) continue;
      const tokenName = tokenDescriptionLine.name;

      const asset = normalizeAsset({
        symbol: clean(symbolNode?.textContent || '') || stripStableSuffix(tokenName),
        name: tokenName,
        description,
        address,
      });
      if (asset) candidates.push(asset);
    }

    // The current flap.sh supported-assets list is fully represented by asset
    // buttons. If we already have button-level candidates, avoid broader
    // full-page fallbacks that can accidentally join neighboring asset rows.
    if (candidates.length > 0) {
      const byName = new Map();
      for (const asset of candidates) {
        const key = asset.name;
        const prev = byName.get(key);
        if (!prev || (!prev.address && asset.address)) byName.set(key, asset);
      }
      return [...byName.values()];
    }

    // ---- Strategy 2: legacy layouts (cards/anchors/articles). ----
    const cardSelectors = [
      '[role="button"]',
      'a',
      'article',
      'li',
      '[data-testid*="asset" i]',
      '[data-testid*="vault" i]',
      '[class*="card" i]',
    ].join(',');
    for (const card of document.querySelectorAll(cardSelectors)) {
      const asset = parseAssetFromText(textOf(card));
      if (asset) candidates.push(asset);
    }

    // ---- Strategy 3: walk up from any element holding a token name. ----
    const tokenNameEls = [...document.querySelectorAll('body *')].filter((el) => {
      const t = textOf(el);
      return isTokenName(t) && t.length < 30;
    });
    for (const el of tokenNameEls) {
      let node = el;
      for (let depth = 0; node && node !== document.body && depth < 8; depth++) {
        const text = textOf(node);
        if (TOKEN_RE.test(text) && text.length < 3000) {
          const asset = parseAssetFromText(text);
          if (asset) {
            candidates.push(asset);
            break;
          }
        }
        node = node.parentElement;
      }
    }

    // ---- Strategy 4: full-page text sliding window (last resort). ----
    const bodyLines = linesFrom(document.body?.innerText || '');
    bodyLines.forEach((line, index) => {
      if (!TOKEN_RE.test(line) && !ANY_ADDRESS_RE.test(line)) return;
      const windowText = bodyLines.slice(Math.max(0, index - 8), index + 9).join('\n');
      const asset = parseAssetFromText(windowText);
      if (asset) candidates.push(asset);
    });

    // De-dup by token name (e.g. "AAPLon"). When the same asset is seen
    // multiple times prefer the variant that has an address.
    const byName = new Map();
    for (const asset of candidates) {
      const key = asset.name;
      const prev = byName.get(key);
      if (!prev || (!prev.address && asset.address)) byName.set(key, asset);
    }
    return [...byName.values()];
  });
}

async function waitForStableAssets(page, timeoutMs = SCRAPE_TIMEOUT) {
  // Wait on the asset button itself. Reading the entire body text in a
  // waitForFunction loop is expensive and never matched plain Robinhood tokens.
  try {
    await page.waitForSelector('button[aria-pressed]', { timeout: Math.min(timeoutMs, 8000) });
  } catch (_) {
    /* fall through to polling */
  }

  const deadline = Date.now() + timeoutMs;
  let lastSignature = '';
  let stableReads = 0;
  let lastAssets = [];

  while (Date.now() < deadline) {
    let assets;
    try {
      assets = await extractAssetsFromPage(page);
    } catch (err) {
      if (/Execution context was destroyed|detached Frame|Cannot find context/i.test(err.message)) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw err;
    }
    const signature = assets.map((a) => `${a.symbol}:${a.name}:${a.address}`).join('|');

    if (assets.length > 0 && signature === lastSignature) {
      stableReads++;
      if (stableReads >= 2) return assets;
    } else {
      stableReads = 1;
      lastSignature = signature;
      lastAssets = assets;
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return lastAssets;
}

// --- Page scraping ---
// Find collapsed "Choose provider" cards and return their visible symbols
// (e.g. ["NVDA", "SPCX", "TSLA"]).
async function findCollapsedMultiIssuerSymbols(page) {
  return page.evaluate(() => {
    const clean = (value = '') =>
      value
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
    const linesFrom = (value = '') =>
      clean(value)
        .split(/\n+/)
        .map((line) => clean(line))
        .filter(Boolean);
    const TOKEN_RE = /\b[A-Z0-9]{3,12}(?:on|B)\b/;
    const ADDRESS_RE = /0x[a-fA-F0-9]{3,40}\.{0,4}[a-fA-F0-9]{0,40}/;
    const MULTI_ISSUER_HINT_RE =
      /(Choose\s+provider|asset choices?|选择发行方|選擇發行方|资产选项|資產選項)/i;
    const isSymbol = (value) => /^[A-Z0-9.]{1,12}$/.test(value);
    const getCollapsedSymbol = (btn) => {
      const text = clean(btn.innerText || btn.textContent || '');
      if (!text || TOKEN_RE.test(text) || ADDRESS_RE.test(text)) return '';

      const lines = linesFrom(text);
      const hasMultiIssuerHint =
        MULTI_ISSUER_HINT_RE.test(text) ||
        lines.some((line) =>
          /^\d+\s*(个|個)?\s*(asset\s+choices?|资产选项|資產選項)$/i.test(line)
        );
      if (!hasMultiIssuerHint) return '';

      const symEl = btn.querySelector('div.font-mono, div.grid.font-mono, [class*="font-mono"]');
      const symbol = clean(symEl?.textContent || '') || lines.find(isSymbol) || '';
      return isSymbol(symbol) ? symbol : '';
    };

    const out = [];
    for (const btn of document.querySelectorAll('button')) {
      const sym = getCollapsedSymbol(btn);
      if (sym) out.push(sym);
    }
    return [...new Set(out)];
  });
}

// Click the "Choose provider" parent whose pill matches `symbol`. Returns true
// on success. The page is an accordion: clicking one collapses any other
// currently-expanded multi-issuer card, so we must scrape children before
// clicking the next.
async function clickMultiIssuerParent(page, symbol) {
  return page.evaluate((sym) => {
    const clean = (value = '') =>
      value
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
    const linesFrom = (value = '') =>
      clean(value)
        .split(/\n+/)
        .map((line) => clean(line))
        .filter(Boolean);
    const TOKEN_RE = /\b[A-Z0-9]{3,12}(?:on|B)\b/;
    const ADDRESS_RE = /0x[a-fA-F0-9]{3,40}\.{0,4}[a-fA-F0-9]{0,40}/;
    const MULTI_ISSUER_HINT_RE =
      /(Choose\s+provider|asset choices?|选择发行方|選擇發行方|资产选项|資產選項)/i;
    const isSymbol = (value) => /^[A-Z0-9.]{1,12}$/.test(value);
    const getCollapsedSymbol = (btn) => {
      const text = clean(btn.innerText || btn.textContent || '');
      if (!text || TOKEN_RE.test(text) || ADDRESS_RE.test(text)) return '';

      const lines = linesFrom(text);
      const hasMultiIssuerHint =
        MULTI_ISSUER_HINT_RE.test(text) ||
        lines.some((line) =>
          /^\d+\s*(个|個)?\s*(asset\s+choices?|资产选项|資產選項)$/i.test(line)
        );
      if (!hasMultiIssuerHint) return '';

      const symEl = btn.querySelector('div.font-mono, div.grid.font-mono, [class*="font-mono"]');
      const symbol = clean(symEl?.textContent || '') || lines.find(isSymbol) || '';
      return isSymbol(symbol) ? symbol : '';
    };

    for (const btn of document.querySelectorAll('button')) {
      if (getCollapsedSymbol(btn) !== sym) continue;
      btn.click();
      return true;
    }
    return false;
  }, symbol);
}

async function scrapeAssets(target) {
  if (!target.page) {
    console.warn(`[SCRAPE:${target.label}] No browser page available, reinitializing...`);
    await initTargetPage(target);
  }
  const page = target.page;
  try {
    target.pendingRpcProbes = new Map();
    target.capturingRpcProbes = true;
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let assets = await waitForStableAssets(page);

    // For each collapsed multi-issuer parent (e.g. NVDA / SPCX / TSLA), expand
    // it and merge in any newly-revealed child issuer rows. Expansion is
    // accordion-style — only one parent can be open at a time — so we click,
    // scrape, then move on.
    let multiSymbols = [];
    try {
      multiSymbols = await findCollapsedMultiIssuerSymbols(page);
    } catch (_) {
      multiSymbols = [];
    }

    if (multiSymbols.length > 0) {
      console.log(`[SCRAPE:${target.label}] Found ${multiSymbols.length} multi-issuer parents: ${multiSymbols.join(', ')}`);
      const merged = new Map((assets || []).map((a) => [a.name, a]));
      for (const sym of multiSymbols) {
        const clicked = await clickMultiIssuerParent(page, sym);
        if (!clicked) continue;
        // Give the accordion a moment to render its child rows.
        await new Promise((r) => setTimeout(r, 1200));
        const expanded = await extractAssetsFromPage(page);
        for (const a of expanded) {
          // Prefer entries with an address (later wins only if better).
          const prev = merged.get(a.name);
          if (!prev || (!prev.address && a.address)) merged.set(a.name, a);
        }
      }
      assets = [...merged.values()];
    }

    assets = filterValidAssets(assets, target);
    target.capturingRpcProbes = false;
    if (target.pendingRpcProbes.size > 0) {
      target.rpcProbes = [...target.pendingRpcProbes.values()];
      console.log(`[SCRAPE:${target.label}] Captured ${target.rpcProbes.length} lightweight RPC probes`);
    }

    if (!assets || assets.length === 0) {
      const diagnostics = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        const html = document.documentElement?.outerHTML || '';
        const hasSupportedHeading = /(Supported Assets|支持的资产|支持的資產)/i.test(body);
        const hasCreateTokenForm =
          /(Create Token|創建稅收代幣|创建税收代币|創建代幣|创建代币)/i.test(body) &&
          /(Token Name|代幣名稱|代币名称)/i.test(body) &&
          /(Token Symbol|代幣符號|代币符号)/i.test(body);
        return {
          url: location.href,
          title: document.title,
          // Real failure only if the Create Token form rendered AND the
          // Supported Assets section is missing entirely.
          isStandaloneCreateTokenPage: hasCreateTokenForm && !hasSupportedHeading,
          hasSupportedHeading,
          v2ButtonEls: document.querySelectorAll('button[aria-pressed]').length,
          symbolPillEls: document.querySelectorAll('div.font-mono').length,
          addrEls: document.querySelectorAll('span.font-mono, p.font-mono').length,
          fullAddrMatches: (body.match(/0x[a-fA-F0-9]{40}/g) || []).length,
          truncAddrMatches: (body.match(/0x[a-fA-F0-9]{3,10}\.{2,4}[a-fA-F0-9]{3,10}/g) || []).length,
          tokenMatches: (body.match(/\b[A-Z0-9]{3,12}(?:on|B)\b/g) || []).length,
          htmlTokenMatches: (html.match(/\b[A-Z0-9]{3,12}(?:on|B)\b/g) || []).length,
          buttonLikeEls: document.querySelectorAll('button, [role="button"], a, article, li').length,
          body: body.slice(0, 240),
        };
      });
      console.warn(`[SCRAPE:${target.label}] Empty stable result:`, JSON.stringify(diagnostics));
      if (diagnostics.isStandaloneCreateTokenPage) {
        console.warn(`[SCRAPE:${target.label}] Target URL rendered a Create Token form WITHOUT a Supported Assets section. The configured URL may be stale or the vault factory was deprecated by the current flap.sh frontend.`);
      }
      await saveDebugSnapshot(target);
    } else {
      target.lastAssets = assets;
      target.lastFullScrapeAt = Date.now();
    }

    await closeTargetPage(target);
    return assets;
  } catch (err) {
    target.capturingRpcProbes = false;
    console.error(`[SCRAPE:${target.label}] Error:`, err.message);
    // If page crashed, reinit browser
    if (/Target closed|Protocol error|Session closed|Execution context was destroyed|detached Frame|Cannot find context/i.test(err.message)) {
      console.log(`[SCRAPE:${target.label}] Page seems crashed, reinitializing...`);
    }
    await closeTargetPage(target);
    return null;
  }
}

async function saveDebugSnapshot(target) {
  const now = Date.now();
  if (now - target.lastDebugSnapshotAt < 10 * 60 * 1000) return;
  target.lastDebugSnapshotAt = now;

  try {
    const html = await target.page.content();
    fs.writeFileSync(target.debugSnapshotFile, html);
    console.warn(`[SCRAPE:${target.label}] Saved debug snapshot to ${target.debugSnapshotFile}`);
  } catch (err) {
    console.warn('[SCRAPE] Failed to save debug snapshot:', err.message);
  }
}

// --- Core poll loop ---
function getKnownAssetsForTarget(target) {
  return [...knownAssets.entries()]
    .filter(([key, info]) => info.targetId === target.id || key.startsWith(`${target.id}::`))
    .map(([, info]) => info);
}

function rememberAsset(target, asset) {
  knownAssets.set(targetAssetKey(target, asset.name), {
    symbol: asset.symbol,
    name: asset.name,
    description: asset.description,
    address: asset.address,
    discoveredAt: new Date().toISOString(),
    targetId: target.id,
    chain: target.chain,
    vaultFactory: target.factory,
  });
}

async function haveRpcProbesChanged(target) {
  if (target.rpcProbes.length === 0) return true;

  const results = await Promise.all(target.rpcProbes.map(async (probe) => {
    const response = await axios.post(probe.url, probe.payload, {
      timeout: 5000,
      headers: { 'content-type': 'application/json' },
    });
    if (response.data?.error || response.data?.result == null) {
      throw new Error(response.data?.error?.message || 'RPC returned no result');
    }
    return hasRpcResultChanged(probe, response.data);
  }));

  return results.some(Boolean);
}

function hasRpcResultChanged(probe, responseData) {
  return JSON.stringify(responseData?.result) !== probe.signature;
}

function getPollingInitialDelay(index, count, interval = POLL_INTERVAL) {
  return interval + Math.floor((interval * index) / Math.max(count, 1));
}

async function getAssetsForPoll(target) {
  const fullRefreshDue = Date.now() - target.lastFullScrapeAt >= FULL_REFRESH_INTERVAL;
  if (!target.lastAssets.length || !target.rpcProbes.length || fullRefreshDue) {
    if (fullRefreshDue && target.lastFullScrapeAt > 0) {
      console.log(`[POLL:${target.label}] Running periodic full-page verification`);
    }
    return scrapeAssets(target);
  }

  try {
    const changed = await haveRpcProbesChanged(target);
    if (!changed) return target.lastAssets;
    console.log(`[POLL:${target.label}] On-chain asset configuration changed, refreshing page`);
  } catch (err) {
    console.warn(`[POLL:${target.label}] Lightweight RPC probe failed, falling back to page scrape: ${err.message}`);
  }

  return scrapeAssets(target);
}

function logPollResult(target, assets) {
  const signature = assets.map((a) => `${a.name}:${a.address}`).join('|');
  const now = Date.now();
  if (signature === target.lastLoggedSignature && now - target.lastHeartbeatAt < HEARTBEAT_INTERVAL) return;

  target.lastLoggedSignature = signature;
  target.lastHeartbeatAt = now;
  console.log(`[POLL:${target.label}] Found ${assets.length} assets: ${assets.map((a) => formatAssetSummary(a, target)).join('; ')}`);
}

async function poll(target) {
  if (target.isPolling) return;
  target.isPolling = true;

  try {
    const assets = await getAssetsForPoll(target);

    if (!assets || assets.length === 0) {
      target.consecutiveErrors++;
      console.warn(`[POLL:${target.label}] No assets found (error #${target.consecutiveErrors})`);
      if (target.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await notifyError(`连续 ${MAX_CONSECUTIVE_ERRORS} 次未能获取资产列表，请检查监控脚本`, target);
        target.consecutiveErrors = 0;
      }
      return;
    }

    target.consecutiveErrors = 0;
    logPollResult(target, assets);

    // If baseline was not established during startup (initial scrape failed),
    // treat the first successful scrape as baseline — not as new assets.
    if (!target.baselineEstablished) {
      console.log(`[POLL:${target.label}] Establishing baseline from first successful scrape...`);
      for (const asset of assets) {
        if (!knownAssets.has(targetAssetKey(target, asset.name))) {
          rememberAsset(target, asset);
        }
      }
      saveState();
      target.baselineEstablished = true;
      await notifyStartup(assets, target);
      return;
    }

    // Check for new assets
    const newAssets = [];
    for (const asset of assets) {
      if (!knownAssets.has(targetAssetKey(target, asset.name))) {
        newAssets.push(asset);
        rememberAsset(target, asset);
      }
    }

    if (newAssets.length > 0) {
      console.log(`[POLL:${target.label}] NEW ASSETS DETECTED: ${newAssets.map((a) => formatAssetSummary(a, target)).join('; ')}`);
      saveState();

      // Send notifications for each new asset
      for (const stock of newAssets) {
        await notifyNewStock(stock, target);
      }
    }
  } catch (err) {
    console.error(`[POLL:${target.label}] Unexpected error:`, err.message);
    target.consecutiveErrors++;
  } finally {
    target.isPolling = false;
  }
}

function startPolling(target, initialDelay = POLL_INTERVAL) {
  console.log(`[POLL:${target.label}] Starting with interval ${POLL_INTERVAL}ms, initial delay ${initialDelay}ms`);
  const loop = async () => {
    await poll(target);
    setTimeout(loop, POLL_INTERVAL);
  };
  setTimeout(loop, initialDelay);
}

// --- Global error handlers ---
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
});

// --- Main entry ---
async function main() {
  console.log('=== Flap Stock Monitor ===');
  console.log(`Targets: ${targets.length}`);
  for (const target of targets) console.log(`- ${target.label}: ${target.url}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);
  console.log(`Feishu webhook: ${FEISHU_WEBHOOK_URL ? 'configured' : '⚠️ NOT configured'}`);

  // Graceful shutdown
  const shutdown = async (sig) => {
    console.log(`\n[MAIN] Received ${sig}, shutting down...`);
    await closeBrowser();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Load persisted state
  loadState();

  // Init browser
  await initBrowser();

  await Promise.all(targets.map(initializeTarget));

  targets.forEach((target, index) => {
    startPolling(target, getPollingInitialDelay(index, targets.length));
  });
  console.log('[MAIN] All monitors running. Press Ctrl+C to stop.');
}

async function initializeTarget(target) {
  console.log(`[MAIN:${target.label}] Performing initial scrape...`);
  let initialAssets = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    initialAssets = await scrapeAssets(target);
    if (initialAssets && initialAssets.length > 0) break;
    console.warn(`[MAIN:${target.label}] Initial scrape attempt ${attempt}/3 returned no assets, retrying...`);
    await new Promise((r) => setTimeout(r, PAGE_WAIT));
  }

  if (!initialAssets || initialAssets.length === 0) {
    console.error(`[MAIN:${target.label}] All initial scrape attempts failed. Will establish baseline on first successful poll.`);
    const knownList = getKnownAssetsForTarget(target).map((info) => ({
      symbol: info.symbol || info.name.replace(/(on|B)$/, ''),
      name: info.name,
      description: info.description || '',
    }));
    await notifyStartup(knownList, target);
  } else {
    const isFirstRun = getKnownAssetsForTarget(target).length === 0;
    const newOnes = [];

    for (const asset of initialAssets) {
      if (!knownAssets.has(targetAssetKey(target, asset.name))) {
        newOnes.push(asset);
        rememberAsset(target, asset);
      }
    }
    saveState();
    target.baselineEstablished = true;

    console.log(`[MAIN:${target.label}] Baseline: ${getKnownAssetsForTarget(target).length} assets known`);

    await notifyStartup(initialAssets, target);

    if (!isFirstRun && newOnes.length > 0) {
      console.log(`[MAIN:${target.label}] New assets since last run: ${newOnes.map((a) => formatAssetSummary(a, target)).join('; ')}`);
      for (const stock of newOnes) {
        await notifyNewStock(stock, target);
      }
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getIssuerInfo,
  formatAddressForDisplay,
  formatAssetSummary,
  hasValidAssetAddress,
  filterValidAssets,
  getPollingInitialDelay,
  hasRpcResultChanged,
  createTarget,
  targetAssetKey,
};
