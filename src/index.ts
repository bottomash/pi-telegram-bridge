import { stat } from "node:fs/promises";
import { resolve } from "node:path";

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
  quietConsoleLogger,
  type BridgeConfig,
  type BridgeLogger,
} from "./config.js";
import { UpdateDedupe } from "./dedupe.js";
import { createPiBridge, PiAgentBridge } from "./pi.js";
import { LongPollingReceiver } from "./polling.js";
import { FifoQueue, QueueClosedError } from "./queue.js";
import { WebhookServer } from "./server.js";
import {
  DEFAULT_PROFILE_NAME,
  generateWebhookSecret,
  getAutostartProfile,
  getProfileAutostartDirectories,
  listProfiles,
  loadEffectiveConfig,
  profileConfigPath,
  readSavedConfig,
  saveConfig,
  setAutostartProfile,
  setProfileAutostartDirectory,
  SystemCredentialStore,
  validateProfileName,
  validateWebhookUrl,
} from "./settings.js";
import {
  TelegramApiError,
  TelegramTransport,
  TelegramTransportClosedError,
  type TelegramJob,
} from "./telegram.js";
import { installWindowsAutostart, removeWindowsAutostart } from "./windows-autostart.js";

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

interface UpdateReceiver {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ActiveRuntime {
  profileName: string;
  config: BridgeConfig;
  receiver: UpdateReceiver;
  queue: FifoQueue<void>;
  transport: TelegramTransport;
}

function runtimeDescription(runtime: ActiveRuntime): string {
  return runtime.config.mode === "webhook"
    ? `Webhook http://${runtime.config.host}:${runtime.config.port}`
    : "Long Polling";
}

async function stopRuntime(
  runtime: ActiveRuntime,
  piBridge: PiAgentBridge,
  logger: BridgeLogger,
): Promise<void> {
  try {
    await runtime.receiver.stop();
  } catch {
    logger.error("[telegram] update receiver shutdown failed");
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
  profileName: string,
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
  const onMessage = (job: TelegramJob): void => {
    void queue
      .enqueue(() => processTelegramJob(job, piBridge, transport, logger))
      .catch((error: unknown) => {
        if (!(error instanceof QueueClosedError)) {
          logger.error("[telegram] queued task failed");
        }
      });
  };
  const receiver: UpdateReceiver = config.mode === "webhook"
    ? new WebhookServer({
        host: config.host,
        port: config.port,
        webhookSecret: config.webhookSecret,
        allowedChatId: config.allowedChatId,
        dedupe: new UpdateDedupe(1000),
        logger,
        onMessage,
      })
    : new LongPollingReceiver({
        transport,
        allowedChatId: config.allowedChatId,
        logger,
        onMessage,
      });
  return { profileName, config, receiver, queue, transport };
}

export default function telegramBridgeExtension(pi: ExtensionAPI): void {
  const logger = quietConsoleLogger;
  const piBridge = createPiBridge(pi);
  const credentialStore = new SystemCredentialStore();
  let runtime: ActiveRuntime | undefined;

  const activate = async (
    profileName: string,
    config: BridgeConfig,
    context: ExtensionContext,
  ): Promise<boolean> => {
    if (runtime !== undefined) {
      return false;
    }

    piBridge.start(context);
    const nextRuntime = createRuntime(profileName, config, piBridge, logger);
    try {
      await nextRuntime.receiver.start();
      runtime = nextRuntime;
      return true;
    } catch (error) {
      await stopRuntime(nextRuntime, piBridge, logger);
      logger.error(`[telegram] update receiver failed: ${safeErrorLabel(error)}`);
      return false;
    }
  };

  pi.registerCommand("pi-telegram-bridge", {
    description: "启动、停止或查看 Telegram Bridge 状态",
    handler: async (args: string, context: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/u).filter(Boolean);
      const command = parts[0]?.toLowerCase() ?? "";

      if (command === "up") {
        let profileName: string;
        try {
          profileName = validateProfileName(parts[1] ?? DEFAULT_PROFILE_NAME);
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : "Bot 配置名称无效", "error");
          return;
        }
        if (parts.length > 2) {
          context.ui.notify("用法：/pi-telegram-bridge up [配置名称]", "warning");
          return;
        }
        if (runtime !== undefined) {
          context.ui.notify(
            runtime.profileName === profileName
              ? `Bot ${profileName} 已通过 ${runtimeDescription(runtime)} 运行`
              : `Bot ${runtime.profileName} 正在运行，请先执行 /pi-telegram-bridge down`,
            "info",
          );
          return;
        }

        let config: BridgeConfig;
        try {
          config = await loadEffectiveConfig({ credentialStore, profileName });
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid configuration";
          logger.error(`[telegram] configuration error: ${message}`);
          context.ui.notify(
            `Bot ${profileName} 尚未配置，请先运行 /pi-telegram-bridge-setup ${profileName}`,
            "error",
          );
          return;
        }

        if (await activate(profileName, config, context)) {
          context.ui.notify(
            `Bot ${profileName} 已启动：${runtimeDescription(runtime!)}`,
            "info",
          );
        } else {
          context.ui.notify("Telegram Bridge 启动失败，请检查日志", "error");
        }
        return;
      }

      if (command === "down") {
        const current = runtime;
        runtime = undefined;
        if (current === undefined) {
          piBridge.stop();
          context.ui.notify("Telegram Bridge 当前未运行", "info");
          return;
        }
        await stopRuntime(current, piBridge, logger);
        context.ui.notify("Telegram Bridge 已停止", "info");
        return;
      }

      if (command === "status") {
        context.ui.notify(
          runtime === undefined
            ? "Telegram Bridge 当前未运行"
            : `Bot ${runtime.profileName} 正通过 ${runtimeDescription(runtime)} 运行`,
          "info",
        );
        return;
      }

      if (command === "list") {
        try {
          const profiles = await listProfiles();
          context.ui.notify(
            profiles.length === 0 ? "尚未配置 Bot" : `Bot 配置：${profiles.join("、")}`,
            "info",
          );
        } catch {
          context.ui.notify("无法读取 Bot 配置列表", "error");
        }
        return;
      }

      if (command === "autostart") {
        const argument = parts[1];
        if (parts.length !== 2 || argument === undefined) {
          context.ui.notify("用法：/pi-telegram-bridge autostart <配置名称|off>", "warning");
          return;
        }
        try {
          if (argument.toLowerCase() === "off") {
            await setAutostartProfile(context.cwd, undefined);
            context.ui.notify(`已关闭目录 ${context.cwd} 的 Bridge 自动启动`, "info");
            return;
          }
          const profileName = validateProfileName(argument);
          const profiles = await listProfiles();
          if (!profiles.includes(profileName)) {
            context.ui.notify(`Bot ${profileName} 尚未配置`, "error");
            return;
          }
          await setAutostartProfile(context.cwd, profileName);
          context.ui.notify(`Pi 在 ${context.cwd} 启动时将自动启动 Bot ${profileName}`, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : "保存失败";
          context.ui.notify(`自动启动配置失败：${message}`, "error");
        }
        return;
      }

      context.ui.notify(
        "用法：/pi-telegram-bridge up [配置名称]|down|status|list|autostart <配置名称|off>",
        "warning",
      );
    },
  });

  pi.registerCommand("pi-telegram-bridge-setup", {
    description: "配置 Bot、接收方式、目录绑定和系统自动启动",
    handler: async (args: string, context: ExtensionCommandContext) => {
      if (!context.hasUI) {
        logger.error("[telegram] setup requires an interactive UI");
        return;
      }

      let profileName: string;
      try {
        profileName = validateProfileName(args.trim() || DEFAULT_PROFILE_NAME);
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : "Bot 配置名称无效", "error");
        return;
      }
      const configPath = profileConfigPath(profileName);

      let saved;
      let existingSecrets;
      try {
        saved = await readSavedConfig(configPath);
        existingSecrets = await credentialStore.load(profileName);
      } catch {
        context.ui.notify("无法读取 Telegram Bridge 的现有配置或系统凭据", "error");
        return;
      }

      const environment = profileName === DEFAULT_PROFILE_NAME ? process.env : {};
      const currentBotToken = environment.TELEGRAM_BOT_TOKEN?.trim() || existingSecrets.botToken;
      const currentWebhookSecret =
        environment.TELEGRAM_WEBHOOK_SECRET?.trim() || existingSecrets.webhookSecret;
      const currentChatId = environment.TELEGRAM_ALLOWED_CHAT_ID?.trim() || saved?.allowedChatId;

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

      const webhookChoice = "国内网络：Webhook";
      const pollingChoice = "国外网络：Long Polling";
      const currentMode = environment.TELEGRAM_MODE?.trim().toLowerCase() || saved?.mode;
      const choices = currentMode === "polling"
        ? [pollingChoice, webhookChoice]
        : [webhookChoice, pollingChoice];
      const modeChoice = await context.ui.select("Telegram 接收方式", choices);
      if (modeChoice === undefined) {
        return;
      }
      const mode = modeChoice === pollingChoice ? "polling" : "webhook";

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

      let webhookUrl: string | undefined;
      let webhookSecret: string | undefined;
      let host: string | undefined;
      let portText: string | undefined;
      if (mode === "webhook") {
        // Tunnel 与 Bridge 默认在同一台机器，普通配置无需暴露监听地址。
        host = saved?.host ?? DEFAULT_HOST;
        const portInput = await context.ui.input(
          "Webhook 监听端口",
          String(saved?.port ?? DEFAULT_PORT),
        );
        if (portInput === undefined) {
          return;
        }
        portText = portInput.trim() || String(saved?.port ?? DEFAULT_PORT);

        const webhookUrlInput = await context.ui.input(
          "Telegram 公网 Webhook URL",
          saved?.webhookUrl ?? "例如 https://tg.example.com/telegram/webhook",
        );
        if (webhookUrlInput === undefined) {
          return;
        }
        try {
          webhookUrl = validateWebhookUrl(webhookUrlInput.trim() || saved?.webhookUrl || "");
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid Webhook URL";
          context.ui.notify(`Webhook URL 无效：${message}`, "error");
          return;
        }
        webhookSecret = currentWebhookSecret ?? generateWebhookSecret();
      }

      let config: BridgeConfig;
      try {
        config = loadConfig({
          TELEGRAM_MODE: mode,
          TELEGRAM_BOT_TOKEN: botToken,
          TELEGRAM_ALLOWED_CHAT_ID: allowedChatId,
          ...(webhookSecret === undefined ? {} : { TELEGRAM_WEBHOOK_SECRET: webhookSecret }),
          ...(host === undefined ? {} : { TELEGRAM_HOST: host }),
          ...(portText === undefined ? {} : { TELEGRAM_PORT: portText }),
          ...(proxy === undefined ? {} : { TELEGRAM_PROXY: proxy }),
        });
        await credentialStore.save({
          botToken,
          ...(config.mode === "webhook" ? { webhookSecret: config.webhookSecret } : {}),
        }, profileName);
        await saveConfig(config.mode === "webhook"
          ? {
              mode: "webhook",
              allowedChatId: config.allowedChatId,
              host: config.host,
              port: config.port,
              ...(webhookUrl === undefined ? {} : { webhookUrl }),
              ...(config.telegramProxy === undefined ? {} : { proxy: config.telegramProxy }),
            }
          : {
              mode: "polling",
              allowedChatId: config.allowedChatId,
              ...(config.telegramProxy === undefined ? {} : { proxy: config.telegramProxy }),
            }, configPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        context.ui.notify(`配置保存失败：${message}`, "error");
        return;
      }

      const current = runtime;
      runtime = undefined;
      if (current !== undefined) {
        await stopRuntime(current, piBridge, logger);
      }

      const registrationTransport = new TelegramTransport({
        botToken: config.botToken,
        logger,
        ...(config.telegramProxy === undefined ? {} : { proxy: config.telegramProxy }),
      });
      try {
        if (config.mode === "webhook") {
          if (webhookUrl === undefined) {
            throw new Error("missing Webhook URL");
          }
          await registrationTransport.setWebhook(webhookUrl, config.webhookSecret);
        } else {
          await registrationTransport.deleteWebhook();
        }
      } catch (error) {
        logger.error(`[telegram] receiver registration failed: ${safeErrorLabel(error)}`);
        context.ui.notify(
          config.mode === "webhook"
            ? "配置已保存，但 Telegram Webhook 注册失败，请检查日志"
            : "配置已保存，但无法停用旧 Webhook，请检查日志",
          "error",
        );
        return;
      } finally {
        try {
          await registrationTransport.close();
        } catch {
          logger.error("[telegram] setup transport shutdown failed");
        }
      }

      let existingDirectories: string[];
      try {
        existingDirectories = await getProfileAutostartDirectories(profileName);
      } catch {
        existingDirectories = [];
      }
      const enableBridgeAutostart = await context.ui.confirm(
        "Bridge 自动启动",
        "是否在指定目录启动 Pi 时自动启动这个 Bot？",
      );
      let workingDirectory: string | undefined;
      let windowsAutostart = false;
      let minimized = false;

      try {
        if (enableBridgeAutostart) {
          const directoryInput = await context.ui.input(
            "Pi 工作目录",
            existingDirectories[0] ?? context.cwd,
          );
          if (directoryInput === undefined) {
            context.ui.notify("Bot 已配置，但自动启动设置未更改", "warning");
            return;
          }
          workingDirectory = resolve(directoryInput.trim() || existingDirectories[0] || context.cwd);
          const directoryStat = await stat(workingDirectory);
          if (!directoryStat.isDirectory()) {
            throw new Error("Pi 工作目录不是文件夹");
          }
          await setProfileAutostartDirectory(profileName, workingDirectory);

          if (process.platform === "win32") {
            windowsAutostart = await context.ui.confirm(
              "Windows 登录自启动",
              "是否在当前用户登录 Windows 后自动启动这个目录中的 Pi？",
            );
            if (windowsAutostart) {
              minimized = await context.ui.confirm(
                "Pi 窗口",
                "是否最小化启动 Pi？（推荐选择“是”）",
              );
              await installWindowsAutostart({
                profileName,
                workingDirectory,
                minimized,
              });
            } else {
              await removeWindowsAutostart(profileName);
            }
          }
        } else {
          await setProfileAutostartDirectory(profileName, undefined);
          await removeWindowsAutostart(profileName);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        context.ui.notify(`Bot 已配置，但自动启动设置失败：${message}`, "error");
        return;
      }

      const summary = [
        config.mode === "webhook"
          ? `Bot ${profileName} 已保存并注册 Webhook`
          : `Bot ${profileName} 已保存并启用 Long Polling`,
        `Bridge 随 Pi 启动：${enableBridgeAutostart ? "是" : "否"}`,
        ...(workingDirectory === undefined ? [] : [`Pi 工作目录：${workingDirectory}`]),
        ...(process.platform !== "win32" || !enableBridgeAutostart
          ? []
          : [`Windows 登录自启动：${windowsAutostart ? "是" : "否"}`]),
        ...(windowsAutostart ? [`Pi 窗口：${minimized ? "最小化" : "正常显示"}`] : []),
      ].join("\n");
      context.ui.notify(summary, "info");
    },
  });

  pi.on("session_start", async (_event, context) => {
    const current = runtime;
    runtime = undefined;
    if (current !== undefined) {
      await stopRuntime(current, piBridge, logger);
    } else {
      piBridge.stop();
    }

    let profileName: string | undefined;
    try {
      profileName = await getAutostartProfile(context.cwd);
      if (profileName === undefined) {
        return;
      }
      const config = await loadEffectiveConfig({ credentialStore, profileName });
      if (!(await activate(profileName, config, context))) {
        logger.error(`[telegram] Bot ${profileName} autostart failed`);
        return;
      }
      logger.info(`[telegram] Bot ${profileName} started automatically`);
      if (context.hasUI) {
        context.ui.notify(`Bot ${profileName} 已自动启动`, "info");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid configuration";
      logger.error(`[telegram] Bot ${profileName ?? "unknown"} autostart failed: ${message}`);
      if (context.hasUI) {
        context.ui.notify("Telegram Bridge 自动启动失败，请检查配置和日志", "error");
      }
    }
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
