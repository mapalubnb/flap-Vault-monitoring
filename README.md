# Flap Vault Monitor

监控 [flap.sh](https://flap.sh) 平台 Vault Factory 中新上线的可分红代币化股票（Ondo Tokenized RWA），发现新资产时通过**飞书机器人 Webhook** 实时推送通知。

## 功能特性

- **自动监控** — 使用 Puppeteer 无头浏览器定时轮询 flap.sh 页面
- **新股告警** — 发现新上线资产后立即发送飞书卡片消息（含符号、名称、合约地址）
- **状态持久化** — 已知资产列表保存到 `known_assets.json`，重启后不会重复告警
- **双重抓取策略** — DOM 选择器 + 正则匹配双保险，提高抓取成功率
- **自动容错** — 浏览器崩溃自动重启，连续失败时发送异常告警
- **资源优化** — 拦截图片/字体/样式请求，降低带宽和内存消耗
- **进程守护** — PM2 管理，支持自动重启、日志管理、开机自启

## 系统要求

- Linux 服务器（Ubuntu 20.04+ / Debian 11+ 推荐）
- Node.js >= 20.x
- 至少 512MB 可用内存
- 飞书群机器人 Webhook URL

---

## 安装

### 方式一：一键部署（推荐）

```bash
# 克隆仓库
git clone https://github.com/mapalubnb/flap-Vault-monitoring.git
cd flap-Vault-monitoring

# 运行部署脚本（自动安装 Node.js、Chromium 依赖、PM2）
chmod +x deploy.sh
sudo ./deploy.sh
```

部署脚本会自动完成以下操作：
1. 检测并安装 Node.js 20（如未安装或版本过低）
2. 安装 Puppeteer 所需的 Chromium 系统依赖
3. 全局安装 PM2 进程管理器
4. 执行 `npm install` 安装项目依赖
5. 创建 `logs/` 目录和 `.env` 配置文件

### 方式二：手动安装

```bash
# 1. 克隆仓库
git clone https://github.com/mapalubnb/flap-Vault-monitoring.git
cd flap-Vault-monitoring

# 2. 安装 Node.js 20（如已有可跳过）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. 安装 Chromium 系统依赖
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation libasound2 \
  libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
  libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
  libxcomposite1 libxdamage1 libxrandr2 xdg-utils wget

# 4. 全局安装 PM2
sudo npm install -g pm2

# 5. 安装项目依赖
npm install

# 6. 创建日志目录
mkdir -p logs

# 7. 创建配置文件
cp .env.example .env
```

### 配置

编辑 `.env` 文件，填入你的飞书 Webhook 地址：

```bash
nano .env
```

```env
# 飞书 Webhook 地址（必填）
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_WEBHOOK_KEY

# 监控目标页面（可选，默认已设置）
FLAP_URL=https://flap.sh/launch?vaultfactory=0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a

# 轮询间隔，单位毫秒（可选，默认 5000）
POLL_INTERVAL=5000

# 页面等待渲染时间，单位毫秒（可选，默认 8000）
PAGE_WAIT=8000
```

---

## 使用

### 前台运行（测试用）

```bash
node monitor.js
```

### PM2 后台运行（生产环境）

```bash
# 启动
pm2 start ecosystem.config.js

# 查看状态
pm2 status

# 查看实时日志
pm2 logs flap-vault-monitor

# 查看最近 100 行日志
pm2 logs flap-vault-monitor --lines 100

# 停止
pm2 stop flap-vault-monitor

# 重启
pm2 restart flap-vault-monitor
```

### 开机自启

```bash
pm2 save
pm2 startup
# 按照终端输出的提示执行 sudo 命令
```

### npm 脚本

```bash
npm start              # 前台启动
npm run pm2:start      # PM2 启动
npm run pm2:stop       # PM2 停止
npm run pm2:restart    # PM2 重启
npm run pm2:logs       # 查看日志
```

---

## 更新

```bash
# 进入项目目录
cd flap-Vault-monitoring

# 停止当前运行的监控
pm2 stop flap-vault-monitor

# 拉取最新代码
git pull origin main

# 更新依赖（如 package.json 有变化）
npm install

# 重新启动
pm2 start ecosystem.config.js

# 确认运行状态
pm2 status
pm2 logs flap-vault-monitor --lines 20
```

如果更新涉及系统依赖变更，重新运行部署脚本：

```bash
sudo ./deploy.sh
pm2 restart flap-vault-monitor
```

---

## 卸载

### 完整卸载

```bash
# 1. 停止并删除 PM2 进程
pm2 stop flap-vault-monitor
pm2 delete flap-vault-monitor
pm2 save

# 2. 移除开机自启（如已配置）
pm2 unstartup systemd

# 3. 删除项目文件
cd ..
rm -rf flap-Vault-monitoring

# 4.（可选）卸载全局 PM2
sudo npm uninstall -g pm2

# 5.（可选）卸载 Node.js
sudo apt-get remove --purge -y nodejs
sudo rm -rf /etc/apt/sources.list.d/nodesource.list
```

### 仅停止监控（保留代码）

```bash
pm2 stop flap-vault-monitor
pm2 delete flap-vault-monitor
pm2 save
```

### 清除已知资产记录（重新建立基线）

```bash
rm known_assets.json
pm2 restart flap-vault-monitor
```

---

## 项目结构

```
flap-Vault-monitoring/
├── monitor.js             # 核心监控脚本
├── package.json           # 项目依赖配置
├── ecosystem.config.js    # PM2 进程管理配置
├── deploy.sh              # 一键部署脚本
├── .env.example           # 环境变量模板
├── .env                   # 环境变量（需手动创建，不纳入版本控制）
├── .gitignore             # Git 忽略规则
├── known_assets.json      # 已知资产记录（运行时生成）
└── logs/                  # 日志目录（运行时生成）
    ├── out.log
    └── error.log
```

## 飞书通知示例

| 通知类型 | 触发条件 |
|---|---|
| ✅ 监控已启动 | 程序启动或重启时，展示当前已知资产列表 |
| 🚨 新增可分红股票 | 发现页面上出现新的代币化资产 |
| ⚠️ 监控异常 | 连续 10 次抓取失败 |

## 常见问题

**Q: 启动后提示找不到 Chromium？**
运行 `sudo ./deploy.sh` 安装 Chromium 系统依赖，或手动执行部署脚本中第 2 步的 `apt-get install` 命令。

**Q: 抓取一直返回空结果？**
尝试增大 `.env` 中的 `PAGE_WAIT` 值（如改为 15000），给 SPA 页面更多渲染时间。也可能是页面结构发生了变化，需要更新 `monitor.js` 中的选择器。

**Q: 如何修改监控的 Vault 地址？**
编辑 `.env` 文件中的 `FLAP_URL`，替换为目标 Vault Factory 的 URL，然后重启监控。

**Q: 内存占用过高？**
`ecosystem.config.js` 中已设置 `max_memory_restart: '300M'`，超出后 PM2 会自动重启进程。如需调整，修改该配置值。

## License

MIT
