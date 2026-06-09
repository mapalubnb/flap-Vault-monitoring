require('dotenv').config();
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- Config ---
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL;
const FLAP_URL = process.env.FLAP_URL || 'https://flap.sh/launch?vaultfactory=0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 5000;
const PAGE_WAIT = parseInt(process.env.PAGE_WAIT, 10) || 8000;
const SCRAPE_TIMEOUT = Math.max(PAGE_WAIT, 5000);
const STATE_FILE = path.join(__dirname, 'known_assets.json');

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
};

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
let page = null;
let knownAssets = new Map(); // symbol -> { name, address }
let baselineEstablished = false; // true after first successful scrape has been processed
let isPolling = false;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 10;

// --- State persistence ---
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      knownAssets = new Map(Object.entries(data));
      console.log(`[STATE] Loaded ${knownAssets.size} known assets: ${[...knownAssets.keys()].join(', ')}`);
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
async function sendFeishu(title, content, template = 'red') {
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
                url: FLAP_URL,
                type: 'primary',
              },
            ],
          },
          {
            tag: 'note',
            elements: [
              { tag: 'plain_text', content: `Flap Monitor · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` },
            ],
          },
        ],
      },
    };
    const res = await axios.post(FEISHU_WEBHOOK_URL, card, { timeout: 10000 });
    if (res.data && res.data.code === 0) {
      console.log('[FEISHU] Notification sent successfully');
    } else {
      console.error('[FEISHU] Send failed:', JSON.stringify(res.data));
    }
  } catch (err) {
    console.error('[FEISHU] Request error:', err.message);
  }
}

async function notifyNewStock(stock) {
  const title = '🚨 新增可分红股票！';
  const cnName = await getChineseNameWithFallback(stock.symbol, stock.description);
  const content = [
    `**股票符号：** ${stock.symbol}`,
    `**中文名称：** ${cnName}`,
    `**Token名称：** ${stock.name}`,
    `**合约地址：** ${stock.address}`,
    `**发现时间：** ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  ].join('\n');
  await sendFeishu(title, content, 'red');
}

async function notifyStartup(assets) {
  const title = '✅ Flap 监控已启动';
  const lines = [];
  for (const a of assets) {
    const cnName = await getChineseNameWithFallback(a.symbol, a.description);
    lines.push(`• ${a.symbol}（${cnName}）— ${a.name}`);
  }
  const list = lines.join('\n');
  const content = [
    `**轮询间隔：** ${POLL_INTERVAL / 1000}s`,
    `**当前已知股票（${assets.length}只）：**`,
    list,
  ].join('\n');
  await sendFeishu(title, content, 'green');
}

async function notifyError(msg) {
  const title = '⚠️ Flap 监控异常';
  await sendFeishu(title, `**错误信息：** ${msg}`, 'orange');
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
      '--single-process',
    ],
  });
  page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );
  // Block images/fonts/media to speed up loading
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });
  console.log('[BROWSER] Ready');
}

async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
}

async function extractAssetsFromPage() {
  return page.evaluate(() => {
    const isSymbol = (value) => /^[A-Z0-9]{1,10}$/.test(value);
    const isStableTokenName = (value) => /^[A-Z0-9]{2,10}on$/.test(value);

    const cards = [...document.querySelectorAll('button')]
      .map((card) => {
        const symbol = card.querySelector('div.grid.font-mono')?.textContent.trim() || '';
        const name = card.querySelector('p.truncate.text-sm.font-semibold')?.textContent.trim() || '';
        const description = card.querySelector('p.mt-0\\.5.truncate')?.textContent.trim() || '';
        const address = [...card.querySelectorAll('p.font-mono')]
          .map((el) => el.textContent.trim())
          .find((text) => text.startsWith('0x')) || '';

        return { symbol, name, description, address };
      })
      .filter((asset) =>
        isSymbol(asset.symbol) &&
        isStableTokenName(asset.name) &&
        asset.description.includes('Ondo Tokenized') &&
        asset.address.startsWith('0x')
      );

    const seen = new Set();
    return cards.filter((asset) => {
      if (seen.has(asset.symbol)) return false;
      seen.add(asset.symbol);
      return true;
    });
  });
}

async function waitForStableAssets(timeoutMs = SCRAPE_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastSignature = '';
  let stableReads = 0;
  let lastAssets = [];

  while (Date.now() < deadline) {
    const assets = await extractAssetsFromPage();
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
async function scrapeAssets() {
  if (!page) {
    console.warn('[SCRAPE] No browser page available, reinitializing...');
    await closeBrowser();
    await initBrowser();
  }
  try {
    await page.goto(FLAP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const assets = await waitForStableAssets();

    if (!assets || assets.length === 0) {
      const diagnostics = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        symbolEls: document.querySelectorAll('div.grid.font-mono').length,
        addrEls: document.querySelectorAll('p.font-mono').length,
        nameEls: document.querySelectorAll('p.truncate.text-sm.font-semibold').length,
        descEls: document.querySelectorAll('p.mt-0\\.5.truncate').length,
        body: document.body?.innerText?.slice(0, 240) || '',
      }));
      console.warn('[SCRAPE] Empty stable result:', JSON.stringify(diagnostics));
    }

    return assets;
  } catch (err) {
    console.error('[SCRAPE] Error:', err.message);
    // If page crashed, reinit browser
    if (err.message.includes('Target closed') || err.message.includes('Protocol error') || err.message.includes('Session closed')) {
      console.log('[SCRAPE] Browser seems crashed, reinitializing...');
      await closeBrowser();
      await initBrowser();
    }
    return null;
  }
}

// --- Core poll loop ---
async function poll() {
  if (isPolling) return;
  isPolling = true;

  try {
    const assets = await scrapeAssets();

    if (!assets || assets.length === 0) {
      consecutiveErrors++;
      console.warn(`[POLL] No assets found (error #${consecutiveErrors})`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await notifyError(`连续 ${MAX_CONSECUTIVE_ERRORS} 次未能获取资产列表，请检查监控脚本`);
        consecutiveErrors = 0; // Reset to avoid spamming
      }
      return;
    }

    consecutiveErrors = 0;
    console.log(`[POLL] Found ${assets.length} assets: ${assets.map((a) => a.symbol).join(', ')}`);

    // If baseline was not established during startup (initial scrape failed),
    // treat the first successful scrape as baseline — not as new assets.
    if (!baselineEstablished) {
      console.log('[POLL] Establishing baseline from first successful scrape...');
      for (const asset of assets) {
        if (!knownAssets.has(asset.symbol)) {
          knownAssets.set(asset.symbol, {
            name: asset.name,
            description: asset.description,
            address: asset.address,
            discoveredAt: new Date().toISOString(),
          });
        }
      }
      saveState();
      baselineEstablished = true;
      // Send startup notification now that we have real data
      await notifyStartup(assets);
      return;
    }

    // Check for new assets
    const newAssets = [];
    for (const asset of assets) {
      if (!knownAssets.has(asset.symbol)) {
        newAssets.push(asset);
        knownAssets.set(asset.symbol, {
          name: asset.name,
          description: asset.description,
          address: asset.address,
          discoveredAt: new Date().toISOString(),
        });
      }
    }

    if (newAssets.length > 0) {
      console.log(`[POLL] 🚨 NEW ASSETS DETECTED: ${newAssets.map((a) => a.symbol).join(', ')}`);
      saveState();

      // Send notifications for each new asset
      for (const stock of newAssets) {
        await notifyNewStock(stock);
      }
    }
  } catch (err) {
    console.error('[POLL] Unexpected error:', err.message);
    consecutiveErrors++;
  } finally {
    isPolling = false;
  }
}

function startPolling() {
  console.log(`[POLL] Starting with interval ${POLL_INTERVAL}ms`);
  const loop = async () => {
    await poll();
    setTimeout(loop, POLL_INTERVAL);
  };
  setTimeout(loop, POLL_INTERVAL);
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
  console.log(`URL: ${FLAP_URL}`);
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

  // First scrape to establish baseline (retry up to 3 times)
  console.log('[MAIN] Performing initial scrape...');
  let initialAssets = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    initialAssets = await scrapeAssets();
    if (initialAssets && initialAssets.length > 0) break;
    console.warn(`[MAIN] Initial scrape attempt ${attempt}/3 returned no assets, retrying...`);
    await new Promise((r) => setTimeout(r, PAGE_WAIT));
  }

  if (!initialAssets || initialAssets.length === 0) {
    console.error('[MAIN] All initial scrape attempts failed. Will establish baseline on first successful poll.');
    // Send startup notification with previously known assets from state file
    const knownList = [...knownAssets.entries()].map(([symbol, info]) => ({
      symbol,
      name: info.name,
    }));
    await notifyStartup(knownList);
    // baselineEstablished stays false — poll() will handle it
  } else {
    const isFirstRun = knownAssets.size === 0;
    const newOnes = [];

    for (const asset of initialAssets) {
      if (!knownAssets.has(asset.symbol)) {
        newOnes.push(asset);
        knownAssets.set(asset.symbol, {
          name: asset.name,
          description: asset.description,
          address: asset.address,
          discoveredAt: new Date().toISOString(),
        });
      }
    }
    saveState();
    baselineEstablished = true;

    console.log(`[MAIN] Baseline: ${knownAssets.size} assets known`);

    // Always send startup notification on every restart
    await notifyStartup(initialAssets);

    // If new assets were found since last run, also send individual alerts
    if (!isFirstRun && newOnes.length > 0) {
      console.log(`[MAIN] 🚨 New assets since last run: ${newOnes.map((a) => a.symbol).join(', ')}`);
      for (const stock of newOnes) {
        await notifyNewStock(stock);
      }
    }
  }

  // Start poll loop
  startPolling();
  console.log('[MAIN] Monitor running. Press Ctrl+C to stop.');
}

main();
