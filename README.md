# Flap Vault Monitor

监控 flap.sh Vault Factory 页面中的可分红代币化股票资产。程序定时抓取“支持的资产”列表，发现新的 Token 后记录到本地状态文件，并通过飞书机器人发送通知。

## 核心功能

- 定时打开 `FLAP_URL`，读取支持的可分红资产列表。
- 识别单发行方资产和折叠的多发行方资产，例如 `NVDAon` 与 `NVDAB`。
- 以 Token 名称作为唯一键，避免同一股票不同发行方互相覆盖。
- 将已知资产保存到 `known_assets.json`，重启后不会重复告警。
- 连续抓取失败时发送飞书异常通知，并保存 `debug-flap-empty.html` 便于排查。

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

## 配置说明

`.env` 支持以下配置：

```env
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_WEBHOOK_KEY
FLAP_URL=https://flap.sh/launch?vaultfactory=0x40a9a2fda017e0923ea0b403f2f063f9e51168fb
POLL_INTERVAL=1500
PAGE_WAIT=8000
```

字段说明：

- `FEISHU_WEBHOOK_URL`：飞书群机器人 Webhook，未配置时只打印日志。
- `FLAP_URL`：监控目标页面，默认指向当前 Vault Factory。
- `POLL_INTERVAL`：轮询间隔，单位毫秒。
- `PAGE_WAIT`：页面渲染等待时间，单位毫秒。

## 监控逻辑

程序会读取页面中的资产按钮，并提取统一字段：

- `symbol`：底层资产代码，例如 `NVDA`、`SPCX`。
- `name`：Token 名称，例如 `NVDAon`、`NVDAB`。
- `description`：页面显示的资产描述，例如 `NVIDIA (Ondo Tokenized)` 或 `NVIDIA Corp`。
- `address`：页面显示的合约地址。当前 flap.sh 页面通常只暴露截断地址，例如 `0x02Fc...7436`。

当前页面结构包含两类资产：

- 单发行方资产：按钮内直接显示 `symbol / name / description / address`。
- 多发行方资产：父按钮显示 `选择发行方` 和 `资产选项`，展开后显示多个子资产。程序会逐个展开父按钮并合并子资产，避免漏掉 Backed Finance 或 Ondo Finance 的不同版本。

资产唯一键使用 `name`，不是 `symbol`。因此 `NVDAon` 和 `NVDAB` 会被当作两个独立资产监控。

## 飞书推送规则

- 启动通知：绿色卡片，展示本次抓取到的已知资产数量和摘要。
- 新增资产：按发行方选择卡片颜色。
- 异常通知：橙色卡片，连续多次抓取不到资产列表时触发。

发行方识别规则：

| Token 后缀 | 发行方 | 飞书卡片 |
| --- | --- | --- |
| `on` | Ondo Finance | 红色 |
| `B` | Backed Finance | 黄色 |
| 其他 | 未知发行方 | 橙色 |

新增资产通知字段保持一致：资产代码、中文名称、Token 名称、发行方、合约地址、发现时间。

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

如果抓取结果为空，先检查 `FLAP_URL` 是否仍能打开目标 Vault Factory 页面，再查看 `debug-flap-empty.html` 中的页面快照。

## 项目结构

```text
flap-Vault-monitoring/
├── monitor.js             # 核心监控脚本
├── package.json           # npm 脚本和依赖
├── ecosystem.config.js    # PM2 配置
├── deploy.sh              # Linux 部署脚本
├── .env.example           # 配置模板
├── known_assets.json      # 运行时生成的已知资产记录
└── logs/                  # 运行时日志目录
```

## License

MIT
