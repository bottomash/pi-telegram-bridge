import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { type BridgeLogger, consoleLogger } from "./config.js";
import { UpdateDedupe } from "./dedupe.js";
import type { TelegramJob, TelegramUpdate } from "./telegram.js";

export const WEBHOOK_PATH = "/telegram/webhook";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface WebhookHandlerOptions {
  webhookSecret: string;
  allowedChatId: string;
  dedupe: UpdateDedupe;
  onMessage: (job: TelegramJob) => void | Promise<void>;
  logger?: BridgeLogger;
  maxBodyBytes?: number;
}

export interface WebhookServerOptions extends WebhookHandlerOptions {
  host: string;
  port: number;
}

function writeStatus(response: ServerResponse, status: number): void {
  if (!response.headersSent) {
    response.statusCode = status;
  }
  response.end();
}

function secretMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const length = Math.max(actualBytes.length, expectedBytes.length);
  const paddedActual = Buffer.alloc(length);
  const paddedExpected = Buffer.alloc(length);
  actualBytes.copy(paddedActual);
  expectedBytes.copy(paddedExpected);
  const sameBytes = timingSafeEqual(paddedActual, paddedExpected);
  return sameBytes && actualBytes.length === expectedBytes.length;
}

function readSecretHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["x-telegram-bot-api-secret-token"];
  return typeof value === "string" ? value : undefined;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class BodyTooLargeError extends Error {
  public constructor() {
    super("request body is too large");
  }
}

function parseUpdate(value: unknown): TelegramUpdate | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const update = value as Partial<TelegramUpdate>;
  if (typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id)) {
    return undefined;
  }
  return update as TelegramUpdate;
}

function toJob(update: TelegramUpdate, allowedChatId: string): TelegramJob | undefined {
  const message = update.message;
  if (!message || message.chat?.type !== "private") {
    return undefined;
  }
  const chatId = message.chat.id;
  if ((typeof chatId !== "number" && typeof chatId !== "string") || String(chatId) !== allowedChatId) {
    return undefined;
  }
  if (typeof message.text !== "string") {
    return undefined;
  }
  return {
    updateId: update.update_id,
    chatId: String(chatId),
    text: message.text,
  };
}

function enqueueSafely(
  job: TelegramJob,
  options: WebhookHandlerOptions,
  logger: BridgeLogger,
): void {
  try {
    void Promise.resolve(options.onMessage(job)).catch(() => {
      logger.error("[telegram] failed to enqueue message");
    });
  } catch {
    logger.error("[telegram] failed to enqueue message");
  }
}

/** Handle one request. It never waits for Pi execution or Telegram delivery. */
export async function handleWebhookRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebhookHandlerOptions,
): Promise<void> {
  const logger = options.logger ?? consoleLogger;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const dedupe = options.dedupe;

  if (request.method !== "POST" || request.url !== WEBHOOK_PATH) {
    writeStatus(response, request.method === "POST" ? 404 : 405);
    return;
  }

  const secret = readSecretHeader(request);
  if (secret === undefined || !secretMatches(secret, options.webhookSecret)) {
    writeStatus(response, 403);
    return;
  }

  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string") {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > maxBodyBytes) {
      writeStatus(response, 413);
      return;
    }
  }

  let body: string;
  try {
    body = await readBody(request, maxBodyBytes);
  } catch (error) {
    writeStatus(response, error instanceof BodyTooLargeError ? 413 : 400);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    writeStatus(response, 400);
    return;
  }

  const update = parseUpdate(parsed);
  if (update === undefined) {
    writeStatus(response, 400);
    return;
  }
  if (!dedupe.checkAndRemember(update.update_id)) {
    writeStatus(response, 200);
    return;
  }

  const job = toJob(update, options.allowedChatId);
  if (job !== undefined) {
    logger.info(`[telegram] message received update_id=${job.updateId}`);
    enqueueSafely(job, options, logger);
  }

  writeStatus(response, 200);
}

export class WebhookServer {
  private server: Server | undefined;

  public constructor(private readonly options: WebhookServerOptions) {}

  public async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }

    const server = createServer((request, response) => {
      void handleWebhookRequest(request, response, this.options).catch(() => {
        if (!response.writableEnded) {
          writeStatus(response, 500);
        }
      });
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.options.port, this.options.host);
      });
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }

    this.options.logger?.info(
      `[telegram] webhook server listening on ${this.options.host}:${this.options.port}`,
    );
  }

  public async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    this.server = undefined;

    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
