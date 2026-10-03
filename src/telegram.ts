import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

import { MAX_TELEGRAM_CODE_POINTS, type BridgeLogger, consoleLogger } from "./config.js";

const MAX_RETRIES = 3;

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  chat?: {
    id?: number | string;
    type?: string;
  };
  text?: string;
}

export interface TelegramJob {
  updateId: number;
  chatId: string;
  text: string;
}

export interface TelegramApiPayload {
  ok?: unknown;
  description?: unknown;
  parameters?: {
    retry_after?: unknown;
  };
  result?: unknown;
}

export interface TelegramTransportOptions {
  botToken: string;
  proxy?: string;
  fetchImpl?: typeof undiciFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: BridgeLogger;
  maxCodePoints?: number;
}

export class TelegramApiError extends Error {
  public readonly status: number | undefined;
  public readonly retryAfterSeconds: number | undefined;

  public constructor(status?: number, retryAfterSeconds?: number) {
    super(status === 429 ? "Telegram API rate limited" : "Telegram API request failed");
    this.name = "TelegramApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TelegramTransportClosedError extends Error {
  public constructor() {
    super("Telegram transport is closed");
    this.name = "TelegramTransportClosedError";
  }
}

function asRetryAfter(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const parameters = (payload as TelegramApiPayload).parameters;
  const retryAfter = parameters?.retry_after;
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) {
    return undefined;
  }
  return retryAfter;
}

function isSuccessfulPayload(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      (payload as TelegramApiPayload).ok === true,
  );
}

function isRetryable(error: TelegramApiError): boolean {
  return error.status === undefined || error.status === 429 || error.status >= 500;
}

/** Split by Unicode code point, preferring the last newline or whitespace. */
export function splitTelegramText(
  text: string,
  maxCodePoints = MAX_TELEGRAM_CODE_POINTS,
): string[] {
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 1) {
    throw new Error("maxCodePoints must be a positive integer");
  }

  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < codePoints.length) {
    let end = Math.min(start + maxCodePoints, codePoints.length);
    if (end < codePoints.length) {
      let boundary = -1;
      for (let index = end; index > start; index -= 1) {
        if (codePoints[index - 1] === "\n") {
          boundary = index;
          break;
        }
      }
      if (boundary < 0) {
        for (let index = end; index > start; index -= 1) {
          if (/\s/u.test(codePoints[index - 1] ?? "")) {
            boundary = index;
            break;
          }
        }
      }
      if (boundary > start) {
        end = boundary;
      }
    }

    chunks.push(codePoints.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

export class TelegramTransport {
  private readonly fetchImpl: typeof undiciFetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logger: BridgeLogger;
  private readonly maxCodePoints: number;
  private readonly apiBaseUrl: string;
  private readonly proxyAgent: ProxyAgent | undefined;
  private closed = false;

  public constructor(private readonly options: TelegramTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? undiciFetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.logger = options.logger ?? consoleLogger;
    this.maxCodePoints = options.maxCodePoints ?? MAX_TELEGRAM_CODE_POINTS;
    this.apiBaseUrl = `https://api.telegram.org/bot${options.botToken}`;
    if (options.proxy !== undefined) {
      this.proxyAgent = new ProxyAgent(options.proxy);
    }
  }

  public async sendMessage(chatId: string | number, text: string): Promise<void> {
    for (const chunk of splitTelegramText(text, this.maxCodePoints)) {
      await this.request("sendMessage", {
        chat_id: String(chatId),
        text: chunk,
      });
    }
  }

  public async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.request("setWebhook", {
      url,
      secret_token: secretToken,
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.proxyAgent?.close();
  }

  private async request(method: string, body: Record<string, string>): Promise<void> {
    let lastError: TelegramApiError | TelegramTransportClosedError | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (this.closed) {
        throw new TelegramTransportClosedError();
      }

      try {
        const init: Parameters<typeof undiciFetch>[1] = {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        };
        if (this.proxyAgent !== undefined) {
          (init as typeof init & { dispatcher?: Dispatcher }).dispatcher = this.proxyAgent;
        }

        const response = await this.fetchImpl(`${this.apiBaseUrl}/${method}`, init);
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }

        if (response.ok && isSuccessfulPayload(payload)) {
          return;
        }

        const retryAfter = response.status === 429 ? asRetryAfter(payload) : undefined;
        throw new TelegramApiError(response.status, retryAfter);
      } catch (error) {
        lastError = error instanceof TelegramTransportClosedError
          ? error
          : error instanceof TelegramApiError
            ? error
            : new TelegramApiError();

        if (
          attempt >= MAX_RETRIES ||
          lastError instanceof TelegramTransportClosedError ||
          !isRetryable(lastError)
        ) {
          throw lastError;
        }

        const waitSeconds = lastError instanceof TelegramApiError && lastError.retryAfterSeconds !== undefined
          ? lastError.retryAfterSeconds
          : 2 ** attempt;
        this.logger.warn(`[telegram] ${method} retrying after ${waitSeconds}s`);
        await this.sleep(waitSeconds * 1000);
      }
    }

    throw lastError ?? new TelegramApiError();
  }
}
