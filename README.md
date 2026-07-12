# Flap Vault Monitor

并行监控多个 flap.sh Vault Factory 页面中的可分红代币化股票资产。程序定时抓取各页面的“支持的资产”列表，发现新的 Token 后记录到本地状态文件，并通过飞书机器人发送通知。

## 核心功能

- 同时打开 `FLAP_URLS` 中的多个页面，独立读取支持的可分红资产列表。
- 默认监控 BSC Vault Factory 和 Robinhood Vault Factory。
- 识别单发行方资产和折叠的多发行方资产，例如 `NVDAon` 与 `NVDAB`。
- 以“链 + Vault Factory + Token 名称”作为唯一键，避免不同页面的同名资产互相覆盖。
- 将已知资产保存到 `known_assets.json`，重启后不会重复告警。
- 单个页面连续抓取失败时发送带来源的飞书异常通知，并保存独立调试快照，不影响其他页面继续运行。

## 运行方式

```bash
npm install
cp .env.example .env
# 编辑 .env，填入飞书 Webhook
npm start
```

生产环境建议使用 PM2：

```bash
npm run pm2:start
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
```

也可以在 Linux 服务器上执行部署脚本：

```bash
chmod +x deploy.sh
sudo ./deploy.sh
```

## 服务器更新

服务器已有项目并正在用 PM2 运行时，按下面流程更新脚本：

```bash
cd /path/to/flap-Vault-monitoring
git pull origin main
npm install
pm2 restart flap-vault-monitor || pm2 start ecosystem.config.js
pm2 logs flap-vault-monitor --lines 100
```

如果服务器仓库还不是 SSH 远端，可以先执行一次：

```bash
git remote set-url origin git@github.com:mapalubnb/flap-Vault-monitoring.git
```

更新说明：

- `.env`、`known_assets.json` 和 `logs/` 不会被 Git 覆盖。
- `git pull origin main` 拉取最新监控脚本和 README。
- `npm install` 更新依赖。
- `pm2 restart flap-vault-monitor` 重启已有进程；如果进程不存在，则用 `ecosystem.config.js` 启动。

## 配置说明

`.env` 支持以下配置：

```env
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_WEBHOOK_KEY
FLAP_URLS=https://flap.sh/launch?vaultfactory=0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5&lang=zh,https://flap.sh/launch?vaultfactory=0xe6ca297D1d963b6F00d5b216986123CAeB883AF6&chain=robinhood&lang=zh
POLL_INTERVAL=1500
PAGE_WAIT=8000
FULL_REFRESH_INTERVAL=1800000
HEARTBEAT_INTERVAL=60000
```

字段说明：

- `FEISHU_WEBHOOK_URL`：飞书群机器人 Webhook，未配置时只打印日志。
- `FLAP_URLS`：监控目标页面列表，使用英文逗号或换行分隔。默认同时监控 BSC 和 Robinhood。
- `FLAP_URL`：旧版单页面配置，仍然兼容；配置 `FLAP_URLS` 时优先使用新配置。
- `POLL_INTERVAL`：轮询间隔，单位毫秒。
- `PAGE_WAIT`：页面渲染等待时间，单位毫秒。
- `FULL_REFRESH_INTERVAL`：完整页面校验间隔，默认 30 分钟。不会改变链上轮询频率。
- `HEARTBEAT_INTERVAL`：资产无变化时完整日志的输出间隔，默认 60 秒。

## 监控逻辑

程序会读取页面中的资产按钮，并提取统一字段：

- `symbol`：底层资产代码，例如 `NVDA`、`SPCX`。
- `name`：Token 名称，例如 `NVDAon`、`NVDAB`。
- `description`：页面显示的资产描述，例如 `NVIDIA (Ondo Tokenized)` 或 `NVIDIA Corp`。
- `address`：页面显示的合约地址。当前 flap.sh 页面通常只暴露截断地址，例如 `0x02Fc...7436`。

监控只接受带有完整或截断合约地址的资产。页面导航、标题等普通文本即使包含 `AI`、`HOME` 这类大写词，也不会进入基线或触发新增通知。

Chrome 实测两个目标页面都使用 `button[aria-pressed]` 资产按钮。当前页面结构包含以下资产：

- 单发行方资产：按钮内直接显示 `symbol / name / description / address`。
- 多发行方资产：父按钮显示 `选择发行方` 和 `资产选项`，展开后显示多个子资产。程序会逐个展开父按钮并合并子资产，避免漏掉 Backed Finance 或 Ondo Finance 的不同版本。
- Robinhood 资产：Token 名称通常没有 `on` 或 `B` 后缀，描述以 `Robinhood Token` 结尾；程序根据页面的 `chain=robinhood` 参数识别发行方。

资产唯一键使用 `chain:vaultfactory::name`，不是单独使用 `symbol`。因此 `NVDAon`、`NVDAB` 以及 Robinhood 页面中的 `NVDA` 都会被当作独立资产监控。

每个目标拥有独立页面、基线、错误计数和调试快照。程序会并行抓取目标页面；其中一个页面加载失败时，其他页面仍会继续轮询。

## 性能优化

首次页面抓取时，程序会自动捕获 Vault Factory 对应的只读链上 RPC 请求。后续仍严格按照 `POLL_INTERVAL` 检查资产配置，但资产未变化时只执行轻量 `eth_call`，不会重复加载完整 flap.sh 页面。

检测到链上结果变化后，程序会立即重新打开对应页面、解析完整资产数据并执行新增通知。RPC 请求异常时自动回退到页面抓取；此外会按照 `FULL_REFRESH_INTERVAL` 周期性执行完整页面校验，避免长期依赖过期的页面调用结构。

两个监控目标会错开启动时间，但每个目标自身的轮询间隔保持不变。无变化时仅按 `HEARTBEAT_INTERVAL` 输出一次完整资产日志，减少 PM2 日志格式化和磁盘写入。

同一时间窗口还会输出一条低开销轮询统计：

```text
[STATS:BSC] Window 60.4s | completed 46 | avg interval 1314ms | avg duration 114ms | RPC 46 | page 0 | failures 0
```

- `completed`：窗口内完成的轮询次数。
- `avg interval`：两次轮询开始时间的平均间隔，包含 RPC 执行时间和配置的等待间隔。
- `avg duration`：单次轮询平均执行时间。
- `RPC/page`：轻量链上检查和完整页面抓取次数。
- `failures`：未获得有效资产的轮询次数。

## 飞书推送规则

- 启动通知：每个页面发送一张绿色卡片，展示来源、Vault Factory、已知资产数量和摘要。
- 新增资产：按发行方选择卡片颜色。
- 异常通知：橙色卡片，连续多次抓取不到资产列表时触发。

发行方识别规则：

| Token 后缀 | 发行方 | 飞书卡片 |
| --- | --- | --- |
| `on` | Ondo Finance | 红色 |
| `B` | Backed Finance | 黄色 |
| Robinhood 页面 | Robinhood | 蓝色 |
| 其他 | 未知发行方 | 橙色 |

新增资产通知字段保持一致：监控页面、Vault Factory、资产代码、中文名称、Token 名称、发行方、合约地址、发现时间。卡片按钮会打开实际发现该资产的页面。

## 从单页面版本升级

首次启动多页面版本时，旧 `known_assets.json` 会自动迁移到原 BSC Vault Factory，已有资产不会重复告警。新加入的 Robinhood 页面会把首次成功抓取结果作为基线，不会把页面当前已有资产全部当作新增资产推送。

## 常用维护

清除本地基线并重新记录当前页面资产：

```bash
rm known_assets.json
npm start
```

查看 PM2 日志：

```bash
pm2 logs flap-vault-monitor --lines 100
```

如果抓取结果为空，先检查对应目标 URL 是否仍能打开 Vault Factory 页面，再查看 `debug-flap-empty-链-Factory前缀.html` 调试快照。日志前缀会标明目标，例如 `[POLL:BSC]` 或 `[POLL:Robinhood]`。

## 项目结构

```text
flap-Vault-monitoring/
├── monitor.js             # 核心监控脚本
├── monitor.test.js        # 配置与目标隔离测试
├── package.json           # npm 脚本和依赖
├── ecosystem.config.js    # PM2 配置
├── deploy.sh              # Linux 部署脚本
├── .env.example           # 配置模板
├── known_assets.json      # 运行时生成的已知资产记录
└── logs/                  # 运行时日志目录
```

## License

MIT
