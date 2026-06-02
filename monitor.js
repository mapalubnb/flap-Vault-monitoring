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
const STATE_FILE = path.join(__dirname, 'known_assets.json');

// --- Placeholder stubs, filled in sections below ---
let browser = null;
let page = null;
let knownAssets = new Map(); // symbol -> { name, address }
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
  const content = [
    `**股票符号：** ${stock.symbol}`,
    `**Token名称：** ${stock.name}`,
    `**合约地址：** ${stock.address}`,
    `**发现时间：** ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  ].join('\n');
  await sendFeishu(title, content, 'red');
}

async function notifyStartup(assets) {
  const title = '✅ Flap 监控已启动';
  const list = assets.map((a) => `• ${a.symbol} — ${a.name}`).join('\n');
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

// --- Page scraping ---
async function scrapeAssets() {
  if (!page) {
    console.warn('[SCRAPE] No browser page available, reinitializing...');
    await closeBrowser();
    await initBrowser();
  }
  try {
    await page.goto(FLAP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, PAGE_WAIT));

    // Extract asset data from the page
    // Page structure: each asset card contains 4 lines in order:
    //   NVDA                       <- symbol (all uppercase, 2-6 chars)
    //   NVDAon                     <- token name (symbol + "on")
    //   NVIDIA (Ondo Tokenized)    <- description
    //   0xA9eE...6F75              <- contract address
    // We use a single regex on the full page text to reliably extract all 4 fields.
    const assets = await page.evaluate(() => {
      const allText = document.body.innerText;

      // Match the 4-line pattern: SYMBOL \n SYMBOLon \n Description (Provider) \n 0xAddr
      // Uses backreference \1 to ensure name = symbol + "on", preventing false matches.
      // Description pattern is flexible to support any provider (Ondo, BlackRock, etc.)
      const regex = /\b([A-Z]{2,6})\n+(\1on)\n+(.+?\(.+?Tokenized\))\n+(0x[a-fA-F0-9]{4}[.\u2026]+[a-fA-F0-9]{4})/g;
      const results = [];
      let match;
      while ((match = regex.exec(allText)) !== null) {
        results.push({
          symbol: match[1],
          name: match[2],
          description: match[3].trim(),
          address: match[4],
        });
      }

      // Deduplicate by symbol
      const seen = new Set();
      return results.filter((r) => {
        if (seen.has(r.symbol)) return false;
        seen.add(r.symbol);
        return true;
      });
    });

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

  // First scrape to establish baseline
  console.log('[MAIN] Performing initial scrape...');
  const initialAssets = await scrapeAssets();

  if (!initialAssets || initialAssets.length === 0) {
    console.error('[MAIN] Initial scrape returned no assets. Check the URL and page structure.');
    console.log('[MAIN] Will keep retrying...');
    // Send startup notification with previously known assets from state file
    const knownList = [...knownAssets.entries()].map(([symbol, info]) => ({
      symbol,
      name: info.name,
    }));
    await notifyStartup(knownList);
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
