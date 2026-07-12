# 📈 Flap Vault Monitor

监控 flap.sh Vault Factory 支持的股票资产。发现新资产后保存本地记录，并通过飞书机器人发送通知。

当前默认同时监控：

- 🟡 BSC Vault Factory
- 🔵 Robinhood Vault Factory

程序直接从链上读取资产地址、英文名称和 Token 代码。浏览器作为冷备用，正常情况下不会启动。

## ✨ 主要功能

- 多页面同步监控，互不影响。
- 区分不同链、Vault Factory 和 Token。
- 自动记录已知资产，重启后不重复通知。
- 过滤没有合约地址的错误结果，避免 `AI`、`HOME` 等误报。
- RPC 或 ABI 解码异常时自动启动浏览器兜底，完成后立即关闭。
- 输出低开销轮询统计，方便确认监控状态。

## 🚀 首次安装

```bash
cd /root
git clone https://github.com/mapalubnb/flap-Vault-monitoring.git
cd /root/flap-Vault-monitoring

npm ci
cp .env.example .env
nano .env

pm2 start ecosystem.config.js
pm2 save
pm2 logs flap-vault-monitor --lines 100
```

在 `.env` 中填写飞书 Webhook 后再启动。

## 🔄 服务器更新

直接执行：

```bash
cd /root/flap-Vault-monitoring
git pull --ff-only https://github.com/mapalubnb/flap-Vault-monitoring.git main
npm ci
pm2 startOrRestart ecosystem.config.js --update-env
pm2 save
pm2 logs flap-vault-monitor --lines 100
```

如果希望把仓库远端统一改成 HTTPS：

```bash
cd /root/flap-Vault-monitoring
git remote set-url origin https://github.com/mapalubnb/flap-Vault-monitoring.git
git remote -v
```

更新不会覆盖 `.env`、`known_assets.json` 和 `logs/`。

## ⚙️ 配置

`.env` 示例：

```env
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_WEBHOOK_KEY

FLAP_URLS=https://flap.sh/launch?vaultfactory=0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5&lang=zh,https://flap.sh/launch?vaultfactory=0xe6ca297D1d963b6F00d5b216986123CAeB883AF6&chain=robinhood&lang=zh

POLL_INTERVAL=1500
PAGE_WAIT=8000
HEARTBEAT_INTERVAL=60000
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org/
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com/
BROWSER_FALLBACK_ENABLED=true
BROWSER_FALLBACK_COOLDOWN=60000
BROWSER_VALIDATION_INTERVAL=21600000
```

- `POLL_INTERVAL`：每次轮询后的等待时间，单位毫秒。
- `PAGE_WAIT`：网页加载等待时间，单位毫秒。
- `HEARTBEAT_INTERVAL`：资产和统计日志输出间隔，默认 60 秒。
- `BSC_RPC_URL`、`ROBINHOOD_RPC_URL`：两条链的只读 RPC。
- `BROWSER_FALLBACK_ENABLED`：是否允许 RPC 异常时自动使用浏览器。
- `BROWSER_FALLBACK_COOLDOWN`：浏览器兜底冷却时间，默认 60 秒。
- `BROWSER_VALIDATION_INTERVAL`：链上与页面交叉验证间隔，默认 6 小时；设为 `0` 可关闭。

## 📊 查看运行状态

```bash
pm2 status
pm2 logs flap-vault-monitor --lines 100
```

正常启动时应看到：

```text
[MAIN:BSC] Performing initial chain read...
[MAIN:Robinhood] Performing initial chain read...
[POLL:BSC] Starting with interval 1500ms
[POLL:Robinhood] Starting with interval 1500ms
```

轮询统计示例：

```text
[STATS:BSC] Window 60.4s | completed 46 | avg interval 1580ms | avg duration 80ms | chain 46 | browser 0 | failures 0
```

- `completed`：完成的轮询次数。
- `avg interval`：实际平均轮询启动间隔。
- `avg duration`：单轮平均执行时间。
- `chain/browser`：链上读取和浏览器兜底次数。
- `failures`：失败次数，正常情况下应为 `0`。

## 🛠️ 常用维护

重新安装依赖：

```bash
cd /root/flap-Vault-monitoring
npm ci
pm2 restart flap-vault-monitor --update-env
```

重新建立资产基线：

```bash
pm2 stop flap-vault-monitor
cd /root/flap-Vault-monitoring
mv known_assets.json known_assets.json.backup
pm2 start ecosystem.config.js --update-env
```

重新建立基线后，当前已有资产只会被记录，不会全部作为新增资产通知。

## 🧪 本地检查

```bash
npm run check
```

## 📄 License

MIT
