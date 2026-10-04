# Pi Telegram Webhook Bridge

一个只做单用户、单 Pi Session、纯文字、Webhook、final-only 的轻量级 Telegram Bridge。

链路：Telegram Webhook → Cloudflare Tunnel → 本地 HTTP 服务 → Pi → 等待 `agent_settled` → Telegram `sendMessage`。

## 特性与边界

- 只接受 `POST /telegram/webhook`。
- 校验 Telegram Webhook secret，并只允许一个私聊 `chat_id`。
- 收到合法 update 后先去重、入队并立即返回 HTTP 200；Pi 任务不占用 Webhook 请求。
- 一个 FIFO worker 串行执行 Telegram prompt，不并发污染当前 Pi Session。
- 只在 Pi `agent_settled` 后提取最后一条 assistant 消息的 `text` block；不会发送 thinking、tool call、tool result、流式预览或工作日志。
- Pi 的标准 Markdown 回复会转换为 Telegram `MarkdownV2`；若 Telegram 拒绝解析则自动降级为纯文本。超过 3900 个 Unicode code point 时优先按换行或空白分段。
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

### 推荐：一次性交互配置

安装后启动 Pi，运行：

```text
/pi-telegram-bridge-setup
```

向导会要求填写 Bot Token、允许访问的私聊 Chat ID、可选代理、监听地址和端口，以及完整的公网 HTTPS Webhook URL（必须以 `/telegram/webhook` 结尾）。Webhook Secret 会自动生成。向导保存配置后会通过 Telegram Bot API 自动调用 `setWebhook`，代理设置同样用于这次注册请求，但不会启动本地服务。配置完成后运行 `/pi-telegram-bridge up` 启动 Bridge。

在 Windows 上，Bot Token 和 Webhook Secret 保存到当前用户的 Windows Credential Manager，凭据服务名为 `pi-telegram-bridge`，账户名分别为 `bot-token` 和 `webhook-secret`。非敏感配置保存在：

```text
~/.pi/agent/telegram-bridge/config.json
```

Windows 上通常对应：

```text
C:/Users/<用户名>/.pi/agent/telegram-bridge/config.json
```

### 可选：环境变量

环境变量会覆盖交互向导保存的对应值，适合自动化运行。必须在启动 Pi 的同一 PowerShell 7 会话中设置：

```powershell
$env:TELEGRAM_BOT_TOKEN = "xxx"
$env:TELEGRAM_ALLOWED_CHAT_ID = "123456789"
$env:TELEGRAM_WEBHOOK_SECRET = "random-secret"
$env:TELEGRAM_PROXY = "http://127.0.0.1:7890"
$env:TELEGRAM_HOST = "127.0.0.1"
$env:TELEGRAM_PORT = "8787"
pi
```

`TELEGRAM_PROXY` 可省略；省略时 Telegram Bot API 直连。代理只支持 `http://` 或 `https://`。默认监听 `127.0.0.1:8787`。插件不会随 Pi 自动启动 Webhook 服务；运行 `/pi-telegram-bridge up` 时才会读取环境变量和已保存配置。如果配置不完整，命令会提示先运行 `/pi-telegram-bridge-setup`。

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

运行 `/pi-telegram-bridge-setup` 时填写完整的公网 URL，例如：

```text
https://tg.example.com/telegram/webhook
```

向导保存配置后会使用生成的 Webhook Secret 向 Telegram 注册该 URL，但 Bridge 会保持停止。若注册失败，配置仍会保留并显示错误提示；检查网络、代理和公网 Tunnel 后，可重新运行配置向导再次注册。

仅使用环境变量、不运行交互向导时，仍需手动注册：

```powershell
$uri = "https://api.telegram.org/bot$($env:TELEGRAM_BOT_TOKEN)/setWebhook"
curl.exe -X POST $uri `
  -d "url=https://tg.example.com/telegram/webhook" `
  -d "secret_token=$($env:TELEGRAM_WEBHOOK_SECRET)"
```

需要代理时为 `curl.exe` 增加 `--proxy http://127.0.0.1:7890`。

## 运行行为

扩展会随 Pi 加载以注册命令，但默认不会创建本地 HTTP 服务。使用以下命令控制 Bridge：

```text
/pi-telegram-bridge up      # 读取配置并启动
/pi-telegram-bridge down    # 停止
/pi-telegram-bridge status  # 查看状态
```

`up` 状态不会持久化；每次启动 Pi 或切换 session 后都需要重新执行 `/pi-telegram-bridge up`。服务运行时，合法文字 update 会立刻得到 HTTP 200，然后在后台排队。第一条任务完整结束并发送最终答复后，队列才会提交第二条 prompt。

Pi session 退出、切换、reload 或 fork 时，扩展会先停止接收 Webhook，再关闭队列、Pi bridge 和 Telegram transport。内存去重缓存与未执行队列不会跨进程保存。

日志不会打印 Bot Token、Webhook secret 或完整用户消息。由于没有实际 Telegram 凭据和真实 Cloudflare Tunnel，自动化测试验证的是本地模块、模拟 Pi 生命周期和 mock Telegram API；真实网络连通性仍需按上述步骤在目标机器验证。

## 开发验证

```powershell
npm run typecheck
npm test
npm run build
```
