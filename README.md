# Pi Telegram Webhook Bridge

一个只做单用户、纯文字、Webhook、final-only 的轻量级 Telegram Bridge。支持命名 Bot 配置；每个 Pi Session 运行一个 Bot，多个 Pi Session 可分别运行不同 Bot。

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
- 单个 Pi Session 同时只运行一个 Bot；不同工作目录和 Pi Session 可以绑定不同 Bot。
- 不支持 Long Polling、群聊、媒体、Telegram 命令、数据库、多用户、Web UI 或 SOCKS5。

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
/pi-telegram-bridge-setup                  # 配置兼容旧版本的 default Bot
/pi-telegram-bridge-setup beancount       # 新建或编辑命名 Bot
```

配置名称只允许字母、数字、`-` 和 `_`。向导会一次完成 Bot Token、允许访问的私聊 Chat ID、代理、监听端口、完整公网 HTTPS Webhook URL、Pi 工作目录、Bridge 随 Pi 启动，以及 Windows 登录后启动 Pi 的全部设置。新配置的监听地址固定为安全的 `127.0.0.1`，不再要求普通用户填写；已有配置中的有效监听地址会保留。Webhook Secret 会自动生成，并通过 Telegram Bot API 自动调用 `setWebhook`。

Windows 登录自启动启用后，setup 会创建或更新名为 `Pi Telegram Bridge - <配置名称>` 的计划任务，并可选择正常或最小化显示 Pi。重复运行 setup 不会创建重复任务；关闭自动启动会移除对应目录绑定和计划任务。非 Windows 系统会跳过 Windows 计划任务步骤。

在 Windows 上，Bot Token 和 Webhook Secret 保存到当前用户的 Windows Credential Manager。`default` 继续使用旧版账户名 `bot-token` 和 `webhook-secret`；命名配置使用带配置名称的独立账户。非敏感配置保存在：

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

`TELEGRAM_PROXY` 可省略；省略时 Telegram Bot API 直连。代理只支持 `http://` 或 `https://`。默认监听 `127.0.0.1:8787`。环境变量只覆盖 `default`，不会意外覆盖命名 Bot。未绑定目录自动启动时，运行 `/pi-telegram-bridge up [配置名称]` 才会启动服务。

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
/pi-telegram-bridge up [配置名称]              # 启动 default 或指定 Bot
/pi-telegram-bridge down                       # 停止当前 Bot
/pi-telegram-bridge status                     # 查看当前 Bot 和监听地址
/pi-telegram-bridge list                       # 列出配置
/pi-telegram-bridge autostart <配置名称>        # 将当前工作目录绑定到 Bot
/pi-telegram-bridge autostart off               # 取消当前目录绑定
```

未绑定目录时，每次启动 Pi 或切换 session 后需要手动执行 `up`。绑定后，Pi 在该目录触发 `session_start` 时会自动读取并启动对应 Bot。一个 Pi Session 同时只能运行一个 Bot；要切换 Bot，先执行 `down`。服务运行时，合法文字 update 会立刻得到 HTTP 200，然后在后台排队。第一条任务完整结束并发送最终答复后，队列才会提交第二条 prompt。

### Windows 登录后自动启动 Pi 和 Bridge

运行一次 setup，并在向导中启用“Bridge 自动启动”和“Windows 登录自启动”：

```text
/pi-telegram-bridge-setup beancount
```

setup 会校验 Pi 工作目录、保存目录与 Bot 的绑定，并创建或更新 Windows 计划任务。用户登录后，计划任务先在指定目录启动 Pi；Pi 加载扩展并触发 `session_start` 后，Bridge 自动开始监听。每个同时运行的 Pi/Bot 必须使用不同本地端口，公网 Tunnel 也必须路由到相应端口。

`/pi-telegram-bridge autostart ...` 仍作为高级和兼容命令保留，但普通配置不再需要单独执行。

Pi session 退出、切换、reload 或 fork 时，扩展会先停止接收 Webhook，再关闭队列、Pi bridge 和 Telegram transport。内存去重缓存与未执行队列不会跨进程保存。

日志不会打印 Bot Token、Webhook secret 或完整用户消息。由于没有实际 Telegram 凭据和真实 Cloudflare Tunnel，自动化测试验证的是本地模块、模拟 Pi 生命周期和 mock Telegram API；真实网络连通性仍需按上述步骤在目标机器验证。

## 开发验证

```powershell
npm run typecheck
npm test
npm run build
```
