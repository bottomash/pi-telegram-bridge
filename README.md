# Pi Telegram Bridge

一个只做单用户、纯文字、final-only 的轻量级 Telegram Bridge。国内网络可手动选择 Webhook，国外网络可手动选择 Long Polling；每个命名 Bot 配置独立保存接收方式。

链路：Telegram Webhook / Long Polling → Pi → 等待 `agent_settled` → Telegram `sendMessage`。

## 核心特性

- 配置时手动选择“国内网络：Webhook”或“国外网络：Long Polling”。
- 两种模式收到消息后都由 FIFO 队列依次提交给 Pi。
- 只把 Pi 最终回复发送到 Telegram，不发送思考过程、工具调用或工作日志。
- 保留常用 Markdown 格式，自动处理长消息、表格和 Telegram 格式限制。
- 两种模式都限制到一个 Telegram 私聊 Chat ID；Webhook 额外校验 Secret。
- 支持多个命名 Bot 配置，以及按 Pi 工作目录自动启动对应 Bot。
- Windows 上可通过计划任务在用户登录后启动 Pi 和 Bridge。

## 要求

- Node.js 22.19 或更高版本。
- 当前 Pi：`@earendil-works/pi-coding-agent`。项目按 Pi package 规范把它声明为 host-provided peer dependency。
- Webhook 模式需要公网 HTTPS 入口；Cloudflare Tunnel/cloudflared 由用户自行配置。Long Polling 不需要公网入口。

## 5 分钟快速开始

开始前请准备好 Telegram Bot Token 和允许访问的私聊 Chat ID。只有国内 Webhook 模式还需要公网 HTTPS 域名和 Tunnel；国外 Long Polling 模式不需要。

1. 从 GitHub 安装扩展：

   ```powershell
   pi install git:github.com/bottomash/pi-telegram-bridge
   ```

2. 启动 Pi，运行交互配置向导：

   ```text
   /pi-telegram-bridge-setup
   ```

   命名 Bot 可使用 `/pi-telegram-bridge-setup beancount`。在向导中手动选择：

   - 国内网络：Webhook。需要把公网地址（如 `https://tg.example.com/telegram/webhook`）路由到本地 Bridge，通常还需要代理访问 Telegram Bot API。
   - 国外网络：Long Polling。不需要域名、Tunnel、Webhook Secret、监听地址或端口。

3. 如果没有在向导中启用 Bridge 自动启动，手动启动：

   ```text
   /pi-telegram-bridge up
   ```

4. 运行 `/pi-telegram-bridge status`，确认显示所选接收方式后，从允许的 Telegram 私聊发送一条纯文字消息。完整验证方法见[验证安装](#验证安装)。

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

当前尚未发布到 npm，请使用上面的本地安装或 GitHub 安装方式。发布后将可以使用：

```powershell
pi install npm:pi-telegram-bridge
```

## 配置

### 推荐：一次性交互配置

安装后启动 Pi，运行：

```text
/pi-telegram-bridge-setup                  # 配置兼容旧版本的 default Bot
/pi-telegram-bridge-setup beancount       # 新建或编辑命名 Bot
```

配置名称只允许字母、数字、`-` 和 `_`。向导会要求手动选择接收方式，并只询问该方式需要的配置。Webhook 模式会生成 Secret、询问监听端口和公网 HTTPS URL，并调用 `setWebhook`；Long Polling 不询问这些内容，并会停用该 Bot 原有的 Webhook。两种模式都可配置代理、Pi 工作目录、Bridge 随 Pi 启动及 Windows 登录后启动 Pi。

Windows 登录自启动启用后，setup 会创建或更新名为 `Pi Telegram Bridge - <配置名称>` 的计划任务，并可选择正常或最小化显示 Pi。重复运行 setup 不会创建重复任务；关闭自动启动会移除对应目录绑定和计划任务。非 Windows 系统会跳过 Windows 计划任务步骤。

在 Windows 上，Bot Token 和 Webhook 模式使用的 Secret 保存到当前用户的 Windows Credential Manager。`default` 继续使用旧版账户名 `bot-token` 和 `webhook-secret`；命名配置使用带配置名称的独立账户。非敏感配置保存在：

```text
~/.pi/agent/telegram-bridge/config.json
```

Windows 上通常对应：

```text
C:/Users/<用户名>/.pi/agent/telegram-bridge/config.json
C:/Users/<用户名>/.pi/agent/telegram-bridge/profiles/<配置名称>.json
```

现有单 Bot 配置会继续作为 `default` 使用，无需迁移。

### 可选：环境变量

环境变量会覆盖交互向导保存的对应值，适合自动化运行。必须在启动 Pi 的同一 PowerShell 7 会话中设置。

Long Polling 只需要公共变量：

```powershell
$env:TELEGRAM_MODE = "polling"
$env:TELEGRAM_BOT_TOKEN = "xxx"
$env:TELEGRAM_ALLOWED_CHAT_ID = "123456789"
pi
```

Webhook 使用以下变量：

```powershell
$env:TELEGRAM_MODE = "webhook"
$env:TELEGRAM_BOT_TOKEN = "xxx"
$env:TELEGRAM_ALLOWED_CHAT_ID = "123456789"
$env:TELEGRAM_WEBHOOK_SECRET = "random-secret"
$env:TELEGRAM_PROXY = "http://127.0.0.1:7890"
$env:TELEGRAM_HOST = "127.0.0.1"
$env:TELEGRAM_PORT = "8787"
pi
```

`TELEGRAM_PROXY` 在两种模式下都可省略；省略时 Telegram Bot API 直连。代理只支持 `http://` 或 `https://`。为兼容旧配置，省略 `TELEGRAM_MODE` 时默认为 `webhook`。环境变量只覆盖 `default`，不会意外覆盖命名 Bot。

## Webhook 模式：Cloudflare Tunnel

例如将 `tg.example.com` 指向：

```text
http://127.0.0.1:8787
```

Webhook URL 为：

```text
https://tg.example.com/telegram/webhook
```

插件不启动或管理 cloudflared。

## Webhook 模式：设置 Telegram Webhook

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

扩展会随 Pi 加载以注册命令，但默认不会启动消息接收。使用以下命令控制 Bridge：

```text
/pi-telegram-bridge up [配置名称]              # 启动 default 或指定 Bot
/pi-telegram-bridge down                       # 停止当前 Bot
/pi-telegram-bridge status                     # 查看当前 Bot 和接收方式
/pi-telegram-bridge list                       # 列出配置
/pi-telegram-bridge autostart <配置名称>        # 将当前工作目录绑定到 Bot
/pi-telegram-bridge autostart off               # 取消当前目录绑定
```

未绑定目录时，每次启动 Pi 或切换 session 后需要手动执行 `up`。绑定后，Pi 在该目录触发 `session_start` 时会自动读取并启动对应 Bot。一个 Pi Session 同时只能运行一个 Bot；要切换 Bot，先执行 `down`。两种接收方式都在后台排队，第一条任务完整结束并发送最终答复后，队列才会提交第二条 prompt。Webhook 会立即向 Telegram 返回 HTTP 200；Long Polling 会持续拉取更新。

### Windows 登录后自动启动 Pi 和 Bridge

运行一次 setup，并在向导中启用“Bridge 自动启动”和“Windows 登录自启动”：

```text
/pi-telegram-bridge-setup beancount
```

setup 会校验 Pi 工作目录、保存目录与 Bot 的绑定，并创建或更新 Windows 计划任务。用户登录后，计划任务先在指定目录启动 Pi；Pi 加载扩展并触发 `session_start` 后，Bridge 自动使用配置的接收方式。只有同时运行的 Webhook Bot 需要不同本地端口及对应的公网路由。

`/pi-telegram-bridge autostart ...` 仍作为高级和兼容命令保留，但普通配置不再需要单独执行。

Pi session 退出、切换、reload 或 fork 时，扩展会先停止 Webhook 或 Long Polling，再关闭队列、Pi bridge 和 Telegram transport。内存状态与未执行队列不会跨进程保存。

日志不会打印 Bot Token、Webhook secret 或完整用户消息。由于没有实际 Telegram 凭据和真实 Cloudflare Tunnel，自动化测试验证的是本地模块、模拟 Pi 生命周期和 mock Telegram API；真实网络连通性仍需按上述步骤在目标机器验证。

## 验证安装

先在 Pi 中确认 Bridge 状态：

```text
/pi-telegram-bridge status
```

Webhook 模式预期显示当前 Bot 和 `Webhook http://127.0.0.1:<端口>`；Long Polling 模式预期显示 `Long Polling`。状态正常只证明接收器已启动，最终仍需通过实际收发消息验证。

Webhook 模式可使用 Telegram Bot API 检查已注册地址；Long Polling 模式应看到空的 `url`。下面的写法不会把 Token 直接保存在 PowerShell 命令历史中，但输入时仍会显示在终端：

```powershell
$botToken = Read-Host "Telegram Bot Token"
try {
  $uri = "https://api.telegram.org/bot$botToken/getWebhookInfo"
  $info = Invoke-RestMethod -Method Get -Uri $uri
  $info.result | Format-List url,pending_update_count,last_error_date,last_error_message
} finally {
  Remove-Variable botToken,uri -ErrorAction SilentlyContinue
}
```

Webhook 模式的 `url` 应为配置的完整 HTTPS URL；Long Polling 模式的 `url` 应为空。最后，从配置允许的私聊发送一条纯文字消息，并确认能够收到 Pi 的最终回复；这是整条链路的实际验证。

## 故障排查

| 现象 | 优先检查 |
| --- | --- |
| setup 提示 Webhook 注册失败 | 确认 Bot Token、网络和 `TELEGRAM_PROXY`；修复后重新运行 setup。已填写的配置仍会保留。 |
| `/pi-telegram-bridge up` 启动失败 | Webhook 检查配置和端口占用；Long Polling 检查 Telegram API 网络连通性，并确认没有其他进程在拉取同一个 Bot。 |
| Webhook 已运行，但 Bot 收不到消息 | 用 `getWebhookInfo` 检查 URL 和 `last_error_message`，确认 Tunnel 指向 Bridge 的实际端口。 |
| Long Polling 已运行，但 Bot 收不到消息 | 确认 `getWebhookInfo` 的 `url` 为空，并停止其他使用同一 Bot Token 的轮询进程。 |
| Telegram 请求到达，但没有触发 Pi | 确认消息来自配置的私聊 Chat ID，并且内容是纯文字；群聊和媒体消息会被忽略。 |
| Pi 已完成，但 Telegram 没有回复 | 检查 Telegram API 错误、代理连通性及日志中的重试或格式降级记录。 |
| Windows 登录后没有自动启动 | 重新运行 setup，确认同时启用了“Bridge 自动启动”和“Windows 登录自启动”，并检查任务计划程序中的 `Pi Telegram Bridge - <配置名称>`。 |
| 命名 Bot 启动了错误配置 | 环境变量只覆盖 `default`；使用 `/pi-telegram-bridge list` 和 `/pi-telegram-bridge status` 确认配置名称。 |

## 设计与限制

- 接收方式由用户配置时手动选择，不自动判断网络位置。
- Webhook HTTP 服务只接受 `POST /telegram/webhook`；Long Polling 启动时会先停用该 Bot 的 Webhook。
- 收到合法 update 后先去重、入队并立即返回 HTTP 200；Pi 任务不会占用 Webhook 请求。
- 一个 FIFO worker 串行执行 Telegram prompt，避免并发污染当前 Pi Session。
- Bridge 等待 Pi 的 `agent_settled`，只提取最后一条 assistant 消息的 `text` block；不会发送 thinking、tool call、tool result、流式预览或工作日志。
- Pi 的标准 Markdown 回复会转换为 Telegram 显式格式实体，不依赖服务端解析 `MarkdownV2`。Markdown 表格会用等宽预格式化文本显示，并在保留格式实体的前提下安全分段；若 Telegram 拒绝实体，则记录具体原因并自动降级为纯文本。
- 每段消息不超过 3900 个 Unicode code point 和 100 个格式实体。
- `TELEGRAM_PROXY` 仅交给 Telegram transport 的 Undici `ProxyAgent`，不会设置进程级 `HTTP_PROXY` 或 `HTTPS_PROXY`。
- Telegram 临时失败按 1、2、4 秒最多重试 3 次；HTTP 429 优先遵循 `retry_after`。
- 单个 Pi Session 同时只运行一个 Bot；不同工作目录和 Pi Session 可以分别运行不同 Bot。
- 不支持群聊、媒体、Telegram 命令、数据库、多用户、Web UI 或 SOCKS5。

## 开发验证

```powershell
npm run typecheck
npm test
npm run build
```
