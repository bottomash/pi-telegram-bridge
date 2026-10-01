# Pi Telegram Webhook Bridge

一个只做单用户、单 Pi Session、纯文字、Webhook、final-only 的轻量级 Telegram Bridge。

链路：Telegram Webhook → Cloudflare Tunnel → 本地 HTTP 服务 → Pi → 等待 `agent_settled` → Telegram `sendMessage`。

## 特性与边界

- 只接受 `POST /telegram/webhook`。
- 校验 Telegram Webhook secret，并只允许一个私聊 `chat_id`。
- 收到合法 update 后先去重、入队并立即返回 HTTP 200；Pi 任务不占用 Webhook 请求。
- 一个 FIFO worker 串行执行 Telegram prompt，不并发污染当前 Pi Session。
- 只在 Pi `agent_settled` 后提取最后一条 assistant 消息的 `text` block；不会发送 thinking、tool call、tool result、流式预览或工作日志。
- Telegram 回复为纯文本，不设置 `parse_mode`；超过 3900 个 Unicode code point 时优先按换行或空白分段。
- `TELEGRAM_PROXY` 仅交给 Telegram transport 的 Undici `ProxyAgent`，不会设置进程级 `HTTP_PROXY`/`HTTPS_PROXY`。
- Telegram 临时失败按 1、2、4 秒最多重试 3 次；HTTP 429 优先遵循 `retry_after`。
- 第一版不支持 Long Polling、群聊、媒体、命令、数据库、多用户、多 Session、Web UI 或 SOCKS5。

## 要求

- Node.js 22.19 或更高版本。
- 当前 Pi：`@earendil-works/pi-coding-agent`。项目按 Pi package 规范把它声明为 host-provided peer dependency。
- Cloudflare Tunnel/cloudflared 由用户自行配置。

## 安装

本地开发安装：

```powershell
npm install
npm run typecheck
npm test
pi install ./
```

临时加载而不写入 Pi 配置：

```powershell
pi -e ./
```

从 GitHub 安装：

```powershell
pi install git:github.com/bottomash/pi-telegram-bridge
```

发布到 npm 后可使用：

```powershell
pi install npm:pi-telegram-bridge
```

## 配置

必须在启动 Pi 的同一 PowerShell 7 会话中设置环境变量：

```powershell
$env:TELEGRAM_BOT_TOKEN = "xxx"
$env:TELEGRAM_ALLOWED_CHAT_ID = "123456789"
$env:TELEGRAM_WEBHOOK_SECRET = "random-secret"
$env:TELEGRAM_PROXY = "http://127.0.0.1:7890"
$env:TELEGRAM_HOST = "127.0.0.1"
$env:TELEGRAM_PORT = "8787"
pi
```

`TELEGRAM_PROXY` 可省略；省略时 Telegram Bot API 直连。代理只支持 `http://` 或 `https://`。默认监听 `127.0.0.1:8787`。

## Cloudflare Tunnel

例如将 `tg.example.com` 指向：

```text
http://127.0.0.1:8787
```

Webhook URL 为：

```text
https://tg.example.com/telegram/webhook
```

插件不启动或管理 cloudflared。

## 设置 Telegram Webhook

PowerShell 7 示例：

```powershell
$uri = "https://api.telegram.org/bot$($env:TELEGRAM_BOT_TOKEN)/setWebhook"
curl.exe -X POST $uri `
  -d "url=https://tg.example.com/telegram/webhook" `
  -d "secret_token=$($env:TELEGRAM_WEBHOOK_SECRET)"
```

在中国大陆网络环境下，这次 `setWebhook` 请求本身也可能需要代理。例如：

```powershell
curl.exe --proxy http://127.0.0.1:7890 -X POST $uri `
  -d "url=https://tg.example.com/telegram/webhook" `
  -d "secret_token=$($env:TELEGRAM_WEBHOOK_SECRET)"
```

## 运行行为

启动 Pi session 后扩展才会创建本地 HTTP 服务。合法文字 update 会立刻得到 HTTP 200，然后在后台排队。第一条任务完整结束并发送最终答复后，队列才会提交第二条 prompt。

Pi session 退出、切换、reload 或 fork 时，扩展会先停止接收 Webhook，再关闭队列、Pi bridge 和 Telegram transport。内存去重缓存与未执行队列不会跨进程保存。

日志不会打印 Bot Token、Webhook secret 或完整用户消息。由于没有实际 Telegram 凭据和真实 Cloudflare Tunnel，自动化测试验证的是本地模块、模拟 Pi 生命周期和 mock Telegram API；真实网络连通性仍需按上述步骤在目标机器验证。

## 开发验证

```powershell
npm run typecheck
npm test
npm run build
```
