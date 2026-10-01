export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const MAX_TELEGRAM_CODE_POINTS = 3900;

export interface BridgeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: BridgeLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export interface BridgeConfig {
  botToken: string;
  allowedChatId: string;
  webhookSecret: string;
  host: string;
  port: number;
  telegramProxy?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TELEGRAM_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseProxy(value: string | undefined): string | undefined {
  const proxy = value?.trim();
  if (!proxy) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    throw new Error("TELEGRAM_PROXY must be a valid HTTP or HTTPS URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("TELEGRAM_PROXY must use http:// or https://");
  }
  return proxy;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const botToken = required(env, "TELEGRAM_BOT_TOKEN");
  const allowedChatId = required(env, "TELEGRAM_ALLOWED_CHAT_ID");
  const webhookSecret = required(env, "TELEGRAM_WEBHOOK_SECRET");
  const host = env.TELEGRAM_HOST?.trim() || DEFAULT_HOST;
  const port = parsePort(env.TELEGRAM_PORT);
  const telegramProxy = parseProxy(env.TELEGRAM_PROXY);

  if (!/^-?\d+$/.test(allowedChatId)) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_ID must be a numeric chat ID");
  }

  const config: BridgeConfig = {
    botToken,
    allowedChatId,
    webhookSecret,
    host,
    port,
  };
  if (telegramProxy !== undefined) {
    config.telegramProxy = telegramProxy;
  }
  return config;
}
