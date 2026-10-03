import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { AsyncEntry } from "@napi-rs/keyring";

import { loadConfig, type BridgeConfig } from "./config.js";

export const CREDENTIAL_SERVICE = "pi-telegram-bridge";
export const BOT_TOKEN_ACCOUNT = "bot-token";
export const WEBHOOK_SECRET_ACCOUNT = "webhook-secret";
export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "telegram-bridge",
  "config.json",
);

export interface SavedBridgeConfig {
  allowedChatId: string;
  host: string;
  port: number;
  proxy?: string;
  webhookUrl?: string;
}

export interface StoredSecrets {
  botToken?: string;
  webhookSecret?: string;
}

export interface CredentialStore {
  load(): Promise<StoredSecrets>;
  save(secrets: { botToken: string; webhookSecret: string }): Promise<void>;
}

export class SystemCredentialStore implements CredentialStore {
  public async load(): Promise<StoredSecrets> {
    const [botToken, webhookSecret] = await Promise.all([
      new AsyncEntry(CREDENTIAL_SERVICE, BOT_TOKEN_ACCOUNT).getPassword(),
      new AsyncEntry(CREDENTIAL_SERVICE, WEBHOOK_SECRET_ACCOUNT).getPassword(),
    ]);
    return {
      ...(botToken === undefined ? {} : { botToken }),
      ...(webhookSecret === undefined ? {} : { webhookSecret }),
    };
  }

  public async save(secrets: { botToken: string; webhookSecret: string }): Promise<void> {
    await Promise.all([
      new AsyncEntry(CREDENTIAL_SERVICE, BOT_TOKEN_ACCOUNT).setPassword(secrets.botToken),
      new AsyncEntry(CREDENTIAL_SERVICE, WEBHOOK_SECRET_ACCOUNT).setPassword(secrets.webhookSecret),
    ]);
  }
}

export function validateWebhookUrl(value: string): string {
  const webhookUrl = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error("Webhook URL must be a valid HTTPS URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use https://");
  }
  if (
    parsed.pathname !== "/telegram/webhook" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("Webhook URL must end with /telegram/webhook and contain no query or credentials");
  }
  return webhookUrl;
}

function parseSavedConfig(value: unknown): SavedBridgeConfig {
  if (!value || typeof value !== "object") {
    throw new Error("saved Telegram configuration must be an object");
  }
  const candidate = value as Partial<SavedBridgeConfig>;
  const webhookUrlValue = (value as { webhookUrl?: unknown }).webhookUrl;
  const env: NodeJS.ProcessEnv = {
    TELEGRAM_BOT_TOKEN: "validation-placeholder",
    TELEGRAM_WEBHOOK_SECRET: "validation-placeholder",
    TELEGRAM_ALLOWED_CHAT_ID: candidate.allowedChatId,
    TELEGRAM_HOST: candidate.host,
    TELEGRAM_PORT: candidate.port === undefined ? undefined : String(candidate.port),
    TELEGRAM_PROXY: candidate.proxy,
  };
  const validated = loadConfig(env);
  if (webhookUrlValue !== undefined && typeof webhookUrlValue !== "string") {
    throw new Error("Webhook URL must be a string");
  }
  const webhookUrl = webhookUrlValue === undefined
    ? undefined
    : validateWebhookUrl(webhookUrlValue);
  return {
    allowedChatId: validated.allowedChatId,
    host: validated.host,
    port: validated.port,
    ...(validated.telegramProxy === undefined ? {} : { proxy: validated.telegramProxy }),
    ...(webhookUrl === undefined ? {} : { webhookUrl }),
  };
}

export async function readSavedConfig(
  path = DEFAULT_CONFIG_PATH,
): Promise<SavedBridgeConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    return parseSavedConfig(JSON.parse(text) as unknown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`invalid saved Telegram configuration: ${reason}`);
  }
}

export async function saveConfig(
  config: SavedBridgeConfig,
  path = DEFAULT_CONFIG_PATH,
): Promise<void> {
  const validated = parseSavedConfig(config);
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export interface LoadEffectiveConfigOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  credentialStore?: CredentialStore;
}

/** Environment variables override values saved by the setup command. */
export async function loadEffectiveConfig(
  options: LoadEffectiveConfigOptions = {},
): Promise<BridgeConfig> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const saved = await readSavedConfig(configPath);
  const needsBotToken = !env.TELEGRAM_BOT_TOKEN?.trim();
  const needsWebhookSecret = !env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const secrets = needsBotToken || needsWebhookSecret
    ? await (options.credentialStore ?? new SystemCredentialStore()).load()
    : {};

  const merged: NodeJS.ProcessEnv = { ...env };
  merged.TELEGRAM_BOT_TOKEN ||= secrets.botToken;
  merged.TELEGRAM_WEBHOOK_SECRET ||= secrets.webhookSecret;
  merged.TELEGRAM_ALLOWED_CHAT_ID ||= saved?.allowedChatId;
  merged.TELEGRAM_HOST ??= saved?.host;
  merged.TELEGRAM_PORT ??= saved === undefined ? undefined : String(saved.port);
  merged.TELEGRAM_PROXY ??= saved?.proxy;
  return loadConfig(merged);
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
