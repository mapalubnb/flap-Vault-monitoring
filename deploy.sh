#!/bin/bash
set -e

echo "=== Flap Vault Monitor - Deploy Script ==="

# 1. Install Node.js 20 if not present
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
  echo "[1/5] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[1/5] Node.js $(node -v) already installed"
fi

# 2. Install Chromium dependencies for Puppeteer
echo "[2/5] Installing Chromium dependencies..."
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation libappindicator3-1 libasound2t64 \
  libatk-bridge2.0-0t64 libatk1.0-0t64 libcups2t64 libdbus-1-3 \
  libdrm2 libgbm1 libgtk-3-0t64 libnspr4 libnss3 libxcomposite1 \
  libxdamage1 libxrandr2 xdg-utils wget 2>/dev/null || \
sudo apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation libasound2 \
  libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
  libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
  libxdamage1 libxrandr2 xdg-utils wget

# 3. Install PM2 globally
echo "[3/5] Installing PM2..."
sudo npm install -g pm2

# 4. Install project dependencies
echo "[4/5] Installing project dependencies..."
npm install

# 5. Create logs directory
mkdir -p logs

# 6. Setup .env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "========================================="
  echo "  .env file created from .env.example"
  echo "  Please edit .env and set your:"
  echo "    - FEISHU_WEBHOOK_URL"
  echo "========================================="
  echo ""
fi

echo "[5/5] Deploy complete!"
echo ""
echo "Usage:"
echo "  1. Edit .env with your Feishu webhook URL"
echo "  2. Test:   node monitor.js"
echo "  3. Start:  pm2 start ecosystem.config.js"
echo "  4. Logs:   pm2 logs flap-vault-monitor"
echo "  5. Auto-start on boot: pm2 save && pm2 startup"
echo ""
