import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { AsyncEntry } from "@napi-rs/keyring";

import { loadConfig, type BridgeConfig } from "./config.js";

export const CREDENTIAL_SERVICE = "pi-telegram-bridge";
export const BOT_TOKEN_ACCOUNT = "bot-token";
export const WEBHOOK_SECRET_ACCOUNT = "webhook-secret";
export const DEFAULT_PROFILE_NAME = "default";
export const DEFAULT_CONFIG_DIRECTORY = join(homedir(), ".pi", "agent", "telegram-bridge");
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIRECTORY, "config.json");
export const DEFAULT_AUTOSTART_PATH = join(DEFAULT_CONFIG_DIRECTORY, "autostart.json");

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
  load(profileName?: string): Promise<StoredSecrets>;
  save(secrets: { botToken: string; webhookSecret: string }, profileName?: string): Promise<void>;
}

function credentialAccount(base: string, profileName: string): string {
  return profileName === DEFAULT_PROFILE_NAME ? base : `${base}:${profileName}`;
}

export class SystemCredentialStore implements CredentialStore {
  public async load(profileName = DEFAULT_PROFILE_NAME): Promise<StoredSecrets> {
    const [botToken, webhookSecret] = await Promise.all([
      new AsyncEntry(CREDENTIAL_SERVICE, credentialAccount(BOT_TOKEN_ACCOUNT, profileName)).getPassword(),
      new AsyncEntry(CREDENTIAL_SERVICE, credentialAccount(WEBHOOK_SECRET_ACCOUNT, profileName)).getPassword(),
    ]);
    return {
      ...(botToken === undefined ? {} : { botToken }),
      ...(webhookSecret === undefined ? {} : { webhookSecret }),
    };
  }

  public async save(
    secrets: { botToken: string; webhookSecret: string },
    profileName = DEFAULT_PROFILE_NAME,
  ): Promise<void> {
    await Promise.all([
      new AsyncEntry(CREDENTIAL_SERVICE, credentialAccount(BOT_TOKEN_ACCOUNT, profileName))
        .setPassword(secrets.botToken),
      new AsyncEntry(CREDENTIAL_SERVICE, credentialAccount(WEBHOOK_SECRET_ACCOUNT, profileName))
        .setPassword(secrets.webhookSecret),
    ]);
  }
}

export function validateProfileName(value: string): string {
  const profileName = value.trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(profileName)) {
    throw new Error("Bot 配置名称只能包含字母、数字、- 和 _");
  }
  return profileName;
}

export function profileConfigPath(
  profileName: string,
  configDirectory = DEFAULT_CONFIG_DIRECTORY,
): string {
  const validated = validateProfileName(profileName);
  return validated === DEFAULT_PROFILE_NAME
    ? join(configDirectory, "config.json")
    : join(configDirectory, "profiles", `${validated}.json`);
}

export async function listProfiles(
  configDirectory = DEFAULT_CONFIG_DIRECTORY,
): Promise<string[]> {
  const profiles: string[] = [];
  try {
    await readFile(join(configDirectory, "config.json"), "utf8");
    profiles.push(DEFAULT_PROFILE_NAME);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const entries = await readdir(join(configDirectory, "profiles"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const profileName = basename(entry.name, ".json");
      try {
        profiles.push(validateProfileName(profileName));
      } catch {
        // Ignore files that cannot represent a profile.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return [...new Set(profiles)].sort();
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

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function saveConfig(
  config: SavedBridgeConfig,
  path = DEFAULT_CONFIG_PATH,
): Promise<void> {
  await writeJsonAtomically(path, parseSavedConfig(config));
}

export interface LoadEffectiveConfigOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  configDirectory?: string;
  credentialStore?: CredentialStore;
  profileName?: string;
}

/** Environment variables override only the legacy-compatible default profile. */
export async function loadEffectiveConfig(
  options: LoadEffectiveConfigOptions = {},
): Promise<BridgeConfig> {
  const profileName = validateProfileName(options.profileName ?? DEFAULT_PROFILE_NAME);
  const sourceEnv = options.env ?? process.env;
  const env = profileName === DEFAULT_PROFILE_NAME ? sourceEnv : {};
  const configPath = options.configPath
    ?? profileConfigPath(profileName, options.configDirectory ?? DEFAULT_CONFIG_DIRECTORY);
  const saved = await readSavedConfig(configPath);
  const needsBotToken = !env.TELEGRAM_BOT_TOKEN?.trim();
  const needsWebhookSecret = !env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const secrets = needsBotToken || needsWebhookSecret
    ? await (options.credentialStore ?? new SystemCredentialStore()).load(profileName)
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

interface AutostartFile {
  directories: Record<string, string>;
}

export function normalizeWorkingDirectory(value: string): string {
  const normalized = resolve(value).replaceAll("\\", "/").replace(/\/$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function readAutostartFile(path: string): Promise<AutostartFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { directories: {} };
    }
    throw error;
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || !("directories" in value)) {
    throw new Error("invalid Telegram Bridge autostart configuration");
  }
  const directories = (value as { directories: unknown }).directories;
  if (!directories || typeof directories !== "object" || Array.isArray(directories)) {
    throw new Error("invalid Telegram Bridge autostart directories");
  }
  const validated: Record<string, string> = {};
  for (const [directory, profileName] of Object.entries(directories)) {
    if (typeof profileName !== "string") {
      throw new Error("invalid Telegram Bridge autostart profile");
    }
    validated[normalizeWorkingDirectory(directory)] = validateProfileName(profileName);
  }
  return { directories: validated };
}

export async function getAutostartProfile(
  workingDirectory: string,
  path = DEFAULT_AUTOSTART_PATH,
): Promise<string | undefined> {
  const config = await readAutostartFile(path);
  return config.directories[normalizeWorkingDirectory(workingDirectory)];
}

export async function setAutostartProfile(
  workingDirectory: string,
  profileName: string | undefined,
  path = DEFAULT_AUTOSTART_PATH,
): Promise<void> {
  const config = await readAutostartFile(path);
  const key = normalizeWorkingDirectory(workingDirectory);
  if (profileName === undefined) {
    delete config.directories[key];
  } else {
    config.directories[key] = validateProfileName(profileName);
  }
  await writeJsonAtomically(path, config);
}

export async function getProfileAutostartDirectories(
  profileName: string,
  path = DEFAULT_AUTOSTART_PATH,
): Promise<string[]> {
  const validated = validateProfileName(profileName);
  const config = await readAutostartFile(path);
  return Object.entries(config.directories)
    .filter(([, name]) => name === validated)
    .map(([directory]) => directory)
    .sort();
}

/** Replace every directory binding for one profile with zero or one directory. */
export async function setProfileAutostartDirectory(
  profileName: string,
  workingDirectory: string | undefined,
  path = DEFAULT_AUTOSTART_PATH,
): Promise<void> {
  const validated = validateProfileName(profileName);
  const config = await readAutostartFile(path);
  for (const [directory, name] of Object.entries(config.directories)) {
    if (name === validated) {
      delete config.directories[directory];
    }
  }
  if (workingDirectory !== undefined) {
    config.directories[normalizeWorkingDirectory(workingDirectory)] = validated;
  }
  await writeJsonAtomically(path, config);
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
