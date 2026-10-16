import telegramifyMarkdown from "telegramify-markdown";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

import { MAX_TELEGRAM_CODE_POINTS, type BridgeLogger, consoleLogger } from "./config.js";

const MAX_RETRIES = 3;
const MAX_TELEGRAM_ENTITIES = 100;

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

export interface TelegramMessageEntity {
  type: "bold" | "italic" | "strikethrough" | "code" | "pre" | "text_link" | "blockquote";
  offset: number;
  length: number;
  url?: string;
}

export interface TelegramFormattedText {
  text: string;
  entities: TelegramMessageEntity[];
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
  public readonly description: string | undefined;

  public constructor(status?: number, retryAfterSeconds?: number, description?: string) {
    super(status === 429 ? "Telegram API rate limited" : "Telegram API request failed");
    this.name = "TelegramApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.description = description;
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

function asDescription(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const description = (payload as TelegramApiPayload).description;
  return typeof description === "string" ? description : undefined;
}

function isFormattingEntityError(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError &&
    error.status === 400 &&
    error.description !== undefined &&
    /(?:parse entities|entity|unsupported start tag)/iu.test(error.description);
}

function describeTelegramError(error: TelegramApiError): string {
  const description = error.description?.replace(/\s+/gu, " ").trim();
  return description === undefined || description === ""
    ? "Telegram HTTP 400"
    : description.slice(0, 300);
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

export function toTelegramMarkdown(text: string): string {
  const converted = telegramifyMarkdown(text, "escape");
  return !text.endsWith("\n") && converted.endsWith("\n")
    ? converted.slice(0, -1)
    : converted;
}

interface ParsedMarkdownSegment extends TelegramFormattedText {
  nextIndex: number;
  closed: boolean;
}

function appendParsedSegment(
  target: TelegramFormattedText,
  segment: TelegramFormattedText,
): void {
  const offset = target.text.length;
  target.text += segment.text;
  target.entities.push(...segment.entities.map((entity) => ({
    ...entity,
    offset: entity.offset + offset,
  })));
}

function decodeMarkdownEscapes(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length;) {
    if (value[index] === "\\" && index + 1 < value.length) {
      const codePoint = value.codePointAt(index + 1);
      if (codePoint !== undefined) {
        const character = String.fromCodePoint(codePoint);
        decoded += character;
        index += 1 + character.length;
        continue;
      }
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    decoded += character;
    index += character.length;
  }
  return decoded;
}

function findUnescaped(value: string, token: string, start: number): number {
  for (let index = start; index <= value.length - token.length; index += 1) {
    if (!value.startsWith(token, index)) {
      continue;
    }
    let slashes = 0;
    for (let before = index - 1; before >= 0 && value[before] === "\\"; before -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) {
      return index;
    }
  }
  return -1;
}

function parseMarkdownSegment(
  markdown: string,
  start = 0,
  stopToken?: string,
): ParsedMarkdownSegment {
  const result: TelegramFormattedText = { text: "", entities: [] };
  let index = start;
  let atLineStart = start === 0 || markdown[start - 1] === "\n";

  while (index < markdown.length) {
    if (stopToken !== undefined && markdown.startsWith(stopToken, index)) {
      return { ...result, nextIndex: index + stopToken.length, closed: true };
    }

    if (markdown[index] === "\\" && index + 1 < markdown.length) {
      const codePoint = markdown.codePointAt(index + 1);
      if (codePoint !== undefined) {
        const character = String.fromCodePoint(codePoint);
        result.text += character;
        atLineStart = character === "\n";
        index += 1 + character.length;
        continue;
      }
    }

    if (markdown.startsWith("```", index)) {
      const end = findUnescaped(markdown, "```", index + 3);
      if (end >= 0) {
        let content = decodeMarkdownEscapes(markdown.slice(index + 3, end));
        if (content.startsWith("\n")) {
          content = content.slice(1);
        }
        if (content.endsWith("\n")) {
          content = content.slice(0, -1);
        }
        const offset = result.text.length;
        result.text += content;
        if (content.length > 0) {
          result.entities.push({ type: "pre", offset, length: content.length });
        }
        atLineStart = content.endsWith("\n");
        index = end + 3;
        continue;
      }
    }

    if (markdown[index] === "`") {
      const end = findUnescaped(markdown, "`", index + 1);
      if (end >= 0) {
        const content = decodeMarkdownEscapes(markdown.slice(index + 1, end));
        const offset = result.text.length;
        result.text += content;
        if (content.length > 0) {
          result.entities.push({ type: "code", offset, length: content.length });
        }
        atLineStart = content.endsWith("\n");
        index = end + 1;
        continue;
      }
    }

    if (atLineStart && markdown[index] === ">") {
      const quote = parseMarkdownSegment(
        markdown,
        index + (markdown[index + 1] === " " ? 2 : 1),
        "\n",
      );
      const offset = result.text.length;
      appendParsedSegment(result, quote);
      if (quote.text.length > 0) {
        result.entities.push({ type: "blockquote", offset, length: quote.text.length });
      }
      if (quote.closed) {
        result.text += "\n";
      }
      index = quote.nextIndex;
      atLineStart = true;
      continue;
    }

    const markerTypes: Readonly<Record<string, TelegramMessageEntity["type"]>> = {
      "*": "bold",
      "_": "italic",
      "~": "strikethrough",
    };
    const marker = markdown[index];
    const markerType = marker === undefined ? undefined : markerTypes[marker];
    if (marker !== undefined && markerType !== undefined) {
      const nested = parseMarkdownSegment(markdown, index + 1, marker);
      if (nested.closed) {
        const offset = result.text.length;
        appendParsedSegment(result, nested);
        if (nested.text.length > 0) {
          result.entities.push({ type: markerType, offset, length: nested.text.length });
        }
        index = nested.nextIndex;
        atLineStart = nested.text.endsWith("\n");
        continue;
      }
      result.text += marker;
      appendParsedSegment(result, nested);
      index = nested.nextIndex;
      atLineStart = nested.text.endsWith("\n");
      continue;
    }

    if (markdown[index] === "[") {
      const label = parseMarkdownSegment(markdown, index + 1, "]");
      if (label.closed && markdown[label.nextIndex] === "(") {
        const urlEnd = findUnescaped(markdown, ")", label.nextIndex + 1);
        if (urlEnd >= 0) {
          const offset = result.text.length;
          appendParsedSegment(result, label);
          if (label.text.length > 0) {
            result.entities.push({
              type: "text_link",
              offset,
              length: label.text.length,
              url: decodeMarkdownEscapes(markdown.slice(label.nextIndex + 1, urlEnd)),
            });
          }
          index = urlEnd + 1;
          atLineStart = label.text.endsWith("\n");
          continue;
        }
      }
      result.text += "[";
      appendParsedSegment(result, label);
      index = label.nextIndex;
      atLineStart = label.text.endsWith("\n");
      continue;
    }

    const codePoint = markdown.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    result.text += character;
    atLineStart = character === "\n";
    index += character.length;
  }

  return { ...result, nextIndex: index, closed: false };
}

function findTableEntities(text: string): TelegramMessageEntity[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/u.test(line);
  const isSeparator = (line: string): boolean =>
    /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(line);
  const entities: TelegramMessageEntity[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const header = lines[index - 1];
    const separator = lines[index];
    if (header === undefined || separator === undefined ||
        !isTableRow(header) || !isSeparator(separator)) {
      continue;
    }

    let endLine = index + 1;
    while (endLine < lines.length && isTableRow(lines[endLine] ?? "")) {
      endLine += 1;
    }
    const start = starts[index - 1];
    if (start === undefined) {
      continue;
    }
    const end = endLine < lines.length
      ? (starts[endLine] ?? text.length) - 1
      : text.length;
    if (end > start) {
      entities.push({ type: "pre", offset: start, length: end - start });
    }
    index = endLine - 1;
  }
  return entities;
}

/** Convert standard Markdown into plain text plus Bot API entities, avoiding parse_mode ambiguity. */
export function toTelegramFormattedText(text: string): TelegramFormattedText {
  const markdown = toTelegramMarkdown(text);
  const parsed = parseMarkdownSegment(markdown);
  parsed.entities.push(...findTableEntities(parsed.text));
  const codeRanges = parsed.entities
    .filter((entity) => entity.type === "code" || entity.type === "pre")
    .map((entity) => [entity.offset, entity.offset + entity.length] as const);
  return {
    text: parsed.text,
    entities: parsed.entities
      .filter((entity) => {
        if (entity.length <= 0 || entity.type === "code" || entity.type === "pre") {
          return entity.length > 0;
        }
        // Telegram forbids every other formatting entity from overlapping code/pre.
        return !codeRanges.some(([start, end]) => entity.offset < end && entity.offset + entity.length > start);
      })
      .sort((left, right) => left.offset - right.offset || right.length - left.length),
  };
}

function sliceFormattedText(
  formatted: TelegramFormattedText,
  start: number,
  end: number,
): TelegramFormattedText {
  return {
    text: formatted.text.slice(start, end),
    entities: formatted.entities.flatMap((entity): TelegramMessageEntity[] => {
      const entityStart = Math.max(start, entity.offset);
      const entityEnd = Math.min(end, entity.offset + entity.length);
      return entityEnd <= entityStart ? [] : [{
        ...entity,
        offset: entityStart - start,
        length: entityEnd - entityStart,
      }];
    }),
  };
}

function splitByEntityLimit(formatted: TelegramFormattedText): TelegramFormattedText[] {
  if (formatted.entities.length <= MAX_TELEGRAM_ENTITIES) {
    return [formatted];
  }
  const codePoints = Array.from(formatted.text);
  if (codePoints.length <= 1) {
    return [{ ...formatted, entities: formatted.entities.slice(0, MAX_TELEGRAM_ENTITIES) }];
  }
  const leftText = codePoints.slice(0, Math.ceil(codePoints.length / 2)).join("");
  const left = sliceFormattedText(formatted, 0, leftText.length);
  const right = sliceFormattedText(formatted, leftText.length, formatted.text.length);
  return [...splitByEntityLimit(left), ...splitByEntityLimit(right)];
}

function splitTelegramFormattedText(
  formatted: TelegramFormattedText,
  maxCodePoints: number,
): TelegramFormattedText[] {
  const chunks = splitTelegramText(formatted.text, maxCodePoints);
  const result: TelegramFormattedText[] = [];
  let chunkStart = 0;
  for (const text of chunks) {
    const chunk = sliceFormattedText(formatted, chunkStart, chunkStart + text.length);
    result.push(...splitByEntityLimit(chunk));
    chunkStart += text.length;
  }
  return result;
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
    let chunks: TelegramFormattedText[];
    try {
      chunks = splitTelegramFormattedText(toTelegramFormattedText(text), this.maxCodePoints);
    } catch {
      this.logger.warn("[telegram] Markdown conversion failed; sending plain text");
      chunks = splitTelegramText(text, this.maxCodePoints).map((chunk) => ({
        text: chunk,
        entities: [],
      }));
    }

    for (const chunk of chunks) {
      await this.sendFormattedChunk(String(chatId), chunk);
    }
  }

  public async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.request("setWebhook", {
      url,
      secret_token: secretToken,
    });
  }

  public async deleteWebhook(): Promise<void> {
    await this.request("deleteWebhook", { drop_pending_updates: false });
  }

  public async getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const result = await this.request("getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    }, signal);
    if (!Array.isArray(result)) {
      throw new TelegramApiError(200, undefined, "invalid getUpdates result");
    }
    return result.filter((value): value is TelegramUpdate => Boolean(
      value &&
      typeof value === "object" &&
      Number.isSafeInteger((value as Partial<TelegramUpdate>).update_id),
    ));
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.proxyAgent?.close();
  }

  private async sendFormattedChunk(
    chatId: string,
    formatted: TelegramFormattedText,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: formatted.text,
      ...(formatted.entities.length === 0 ? {} : { entities: formatted.entities }),
    };
    try {
      await this.request("sendMessage", body);
    } catch (error) {
      if (!isFormattingEntityError(error) || formatted.entities.length === 0) {
        throw error;
      }
      this.logger.warn(
        `[telegram] formatting entities rejected (${describeTelegramError(error)}); retrying as plain text`,
      );
      await this.request("sendMessage", { chat_id: chatId, text: formatted.text });
    }
  }

  private async request(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
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
          ...(signal === undefined ? {} : { signal }),
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
          return (payload as TelegramApiPayload).result;
        }

        const retryAfter = response.status === 429 ? asRetryAfter(payload) : undefined;
        throw new TelegramApiError(response.status, retryAfter, asDescription(payload));
      } catch (error) {
        if (signal?.aborted === true) {
          throw new TelegramTransportClosedError();
        }
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
