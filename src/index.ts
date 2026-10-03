import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

import {
  consoleLogger,
  DEFAULT_HOST,
  DEFAULT_PORT,
  loadConfig,
  type BridgeConfig,
  type BridgeLogger,
} from "./config.js";
import { UpdateDedupe } from "./dedupe.js";
import { createPiBridge, PiAgentBridge } from "./pi.js";
import { FifoQueue, QueueClosedError } from "./queue.js";
import { WebhookServer } from "./server.js";
import {
  generateWebhookSecret,
  loadEffectiveConfig,
  readSavedConfig,
  saveConfig,
  SystemCredentialStore,
  validateWebhookUrl,
} from "./settings.js";
import {
  TelegramApiError,
  TelegramTransport,
  TelegramTransportClosedError,
  type TelegramJob,
} from "./telegram.js";

export const PI_FAILURE_MESSAGE = "Pi 执行任务失败，请稍后重试。";

export interface PiRunner {
  run(prompt: string): Promise<{ text: string }>;
}

export interface TelegramSender {
  sendMessage(chatId: string | number, text: string): Promise<void>;
}

function safeErrorLabel(error: unknown): string {
  if (error instanceof TelegramTransportClosedError) {
    return "transport closed";
  }
  if (error instanceof TelegramApiError) {
    return error.status === undefined
      ? "Telegram API network request failed"
      : `Telegram API HTTP ${error.status}`;
  }
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]+$/u.test(code)) {
      return code;
    }
  }
  return "request failed";
}

export async function processTelegramJob(
  job: TelegramJob,
  piRunner: PiRunner,
  telegram: TelegramSender,
  logger: BridgeLogger = consoleLogger,
): Promise<void> {
  logger.info("[pi] processing telegram message");
  let reply: string;
  try {
    reply = (await piRunner.run(job.text)).text;
  } catch {
    reply = PI_FAILURE_MESSAGE;
  }

  try {
    await telegram.sendMessage(job.chatId, reply);
    logger.info("[telegram] final answer sent");
  } catch (error) {
    logger.error(`[telegram] sendMessage failed: ${safeErrorLabel(error)}`);
  }
}

interface ActiveRuntime {
  server: WebhookServer;
  queue: FifoQueue<void>;
  transport: TelegramTransport;
}

async function stopRuntime(
  runtime: ActiveRuntime,
  piBridge: PiAgentBridge,
  logger: BridgeLogger,
): Promise<void> {
  try {
    await runtime.server.stop();
  } catch {
    logger.error("[telegram] webhook server shutdown failed");
  }
  runtime.queue.close();
  piBridge.stop();
  try {
    await runtime.transport.close();
  } catch {
    logger.error("[telegram] transport shutdown failed");
  }
}

function createRuntime(
  config: BridgeConfig,
  piBridge: PiAgentBridge,
  logger: BridgeLogger,
): ActiveRuntime {
  const queue = new FifoQueue<void>();
  const transport = new TelegramTransport({
    botToken: config.botToken,
    logger,
    ...(config.telegramProxy === undefined ? {} : { proxy: config.telegramProxy }),
  });
  const dedupe = new UpdateDedupe(1000);
  const server = new WebhookServer({
    host: config.host,
    port: config.port,
    webhookSecret: config.webhookSecret,
    allowedChatId: config.allowedChatId,
    dedupe,
    logger,
    onMessage: (job) => {
      void queue
        .enqueue(() => processTelegramJob(job, piBridge, transport, logger))
        .catch((error: unknown) => {
          if (!(error instanceof QueueClosedError)) {
            logger.error("[telegram] queued task failed");
          }
        });
    },
  });
  return { server, queue, transport };
}

export default function telegramBridgeExtension(pi: ExtensionAPI): void {
  const logger = consoleLogger;
  const piBridge = createPiBridge(pi);
  const credentialStore = new SystemCredentialStore();
  let runtime: ActiveRuntime | undefined;

  const activate = async (config: BridgeConfig, context: ExtensionContext): Promise<boolean> => {
    if (runtime !== undefined) {
      await stopRuntime(runtime, piBridge, logger);
      runtime = undefined;
    }

    piBridge.start(context);
    const nextRuntime = createRuntime(config, piBridge, logger);
    try {
      await nextRuntime.server.start();
      runtime = nextRuntime;
      return true;
    } catch (error) {
      await stopRuntime(nextRuntime, piBridge, logger);
      logger.error(`[telegram] webhook server failed: ${safeErrorLabel(error)}`);
      return false;
    }
  };

  pi.registerCommand("pi-telegram-bridge-setup", {
    description: "交互配置并持久保存 Telegram Bridge",
    handler: async (_args: string, context: ExtensionCommandContext) => {
      if (!context.hasUI) {
        logger.error("[telegram] setup requires an interactive UI");
        return;
      }

      let saved;
      let existingSecrets;
      try {
        saved = await readSavedConfig();
        existingSecrets = await credentialStore.load();
      } catch {
        context.ui.notify("无法读取 Telegram Bridge 的现有配置或系统凭据", "error");
        return;
      }

      const currentBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || existingSecrets.botToken;
      const currentWebhookSecret =
        process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || existingSecrets.webhookSecret;
      const currentChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID?.trim() || saved?.allowedChatId;

      context.ui.notify("Bot Token 输入时会显示在终端中，请确认周围无人旁观", "warning");
      const tokenInput = await context.ui.input(
        "Telegram Bot Token",
        currentBotToken === undefined ? "必填" : "留空以保留现有 Token",
      );
      if (tokenInput === undefined) {
        return;
      }
      const botToken = tokenInput.trim() || currentBotToken;
      if (botToken === undefined) {
        context.ui.notify("Telegram Bot Token 不能为空", "error");
        return;
      }

      const chatIdInput = await context.ui.input(
        "允许访问的 Telegram Chat ID",
        currentChatId ?? "例如 123456789",
      );
      if (chatIdInput === undefined) {
        return;
      }
      const allowedChatId = chatIdInput.trim() || currentChatId;
      if (allowedChatId === undefined) {
        context.ui.notify("Telegram Chat ID 不能为空", "error");
        return;
      }

      const useProxy = await context.ui.confirm(
        "Telegram 代理",
        "是否通过 HTTP/HTTPS 代理访问 Telegram Bot API？",
      );
      let proxy: string | undefined;
      if (useProxy) {
        const proxyInput = await context.ui.input(
          "Telegram 代理地址",
          saved?.proxy ?? "http://127.0.0.1:7890",
        );
        if (proxyInput === undefined) {
          return;
        }
        proxy = proxyInput.trim() || saved?.proxy;
        if (proxy === undefined) {
          context.ui.notify("启用代理时必须填写代理地址", "error");
          return;
        }
      }

      const hostInput = await context.ui.input(
        "Webhook 监听地址",
        saved?.host ?? DEFAULT_HOST,
      );
      if (hostInput === undefined) {
        return;
      }
      const host = hostInput.trim() || saved?.host || DEFAULT_HOST;

      const portInput = await context.ui.input(
        "Webhook 监听端口",
        String(saved?.port ?? DEFAULT_PORT),
      );
      if (portInput === undefined) {
        return;
      }
      const portText = portInput.trim() || String(saved?.port ?? DEFAULT_PORT);

      const webhookUrlInput = await context.ui.input(
        "Telegram 公网 Webhook URL",
        saved?.webhookUrl ?? "例如 https://tg.example.com/telegram/webhook",
      );
      if (webhookUrlInput === undefined) {
        return;
      }

      let webhookUrl: string;
      try {
        webhookUrl = validateWebhookUrl(webhookUrlInput.trim() || saved?.webhookUrl || "");
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid Webhook URL";
        context.ui.notify(`Webhook URL 无效：${message}`, "error");
        return;
      }

      const webhookSecret = currentWebhookSecret ?? generateWebhookSecret();

      let config: BridgeConfig;
      try {
        config = loadConfig({
          TELEGRAM_BOT_TOKEN: botToken,
          TELEGRAM_ALLOWED_CHAT_ID: allowedChatId,
          TELEGRAM_WEBHOOK_SECRET: webhookSecret,
          TELEGRAM_HOST: host,
          TELEGRAM_PORT: portText,
          ...(proxy === undefined ? {} : { TELEGRAM_PROXY: proxy }),
        });
        await credentialStore.save({ botToken, webhookSecret });
        await saveConfig({
          allowedChatId: config.allowedChatId,
          host: config.host,
          port: config.port,
          webhookUrl,
          ...(config.telegramProxy === undefined ? {} : { proxy: config.telegramProxy }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        context.ui.notify(`配置保存失败：${message}`, "error");
        return;
      }

      const started = await activate(config, context);
      const activeRuntime = runtime;
      if (!started || activeRuntime === undefined) {
        context.ui.notify("配置已保存，但 Webhook 服务启动失败，请检查日志", "error");
        return;
      }

      try {
        await activeRuntime.transport.setWebhook(webhookUrl, webhookSecret);
      } catch (error) {
        logger.error(`[telegram] setWebhook failed: ${safeErrorLabel(error)}`);
        context.ui.notify(
          "配置已保存且 Bridge 已启动，但 Telegram Webhook 注册失败，请检查日志",
          "error",
        );
        return;
      }

      context.ui.notify(
        "配置已保存、Bridge 已启动并已注册 Telegram Webhook",
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, context: ExtensionContext) => {
    if (runtime !== undefined) {
      await stopRuntime(runtime, piBridge, logger);
      runtime = undefined;
    }

    let config: BridgeConfig;
    try {
      config = await loadEffectiveConfig({ credentialStore });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid configuration";
      logger.error(`[telegram] configuration error: ${message}`);
      if (context.hasUI) {
        context.ui.notify(
          "Telegram Bridge 尚未配置，请运行 /pi-telegram-bridge-setup",
          "warning",
        );
      }
      return;
    }

    await activate(config, context);
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent) => {
    const current = runtime;
    runtime = undefined;
    if (current !== undefined) {
      await stopRuntime(current, piBridge, logger);
    } else {
      piBridge.stop();
    }
  });
}
