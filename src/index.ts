import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

import {
  consoleLogger,
  loadConfig,
  type BridgeConfig,
  type BridgeLogger,
} from "./config.js";
import { UpdateDedupe } from "./dedupe.js";
import { createPiBridge, PiAgentBridge } from "./pi.js";
import { FifoQueue, QueueClosedError } from "./queue.js";
import { WebhookServer } from "./server.js";
import {
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
  let runtime: ActiveRuntime | undefined;

  pi.on("session_start", async (_event, context: ExtensionContext) => {
    if (runtime !== undefined) {
      await stopRuntime(runtime, piBridge, logger);
      runtime = undefined;
    }

    let config: BridgeConfig;
    try {
      config = loadConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid configuration";
      logger.error(`[telegram] configuration error: ${message}`);
      return;
    }

    piBridge.start(context);
    const nextRuntime = createRuntime(config, piBridge, logger);
    try {
      await nextRuntime.server.start();
      runtime = nextRuntime;
    } catch (error) {
      await stopRuntime(nextRuntime, piBridge, logger);
      logger.error(`[telegram] webhook server failed: ${safeErrorLabel(error)}`);
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
