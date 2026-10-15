import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { DEFAULT_CONFIG_DIRECTORY, validateProfileName } from "./settings.js";

const execFileAsync = promisify(execFile);

export interface WindowsAutostartOptions {
  profileName: string;
  workingDirectory: string;
  minimized: boolean;
  configDirectory?: string;
  piCommand?: string;
  pwshCommand?: string;
}

export function windowsTaskName(profileName: string): string {
  return `Pi Telegram Bridge - ${validateProfileName(profileName)}`;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function resolveCommand(command: string): Promise<string> {
  const { stdout } = await execFileAsync("where.exe", [command], { windowsHide: true });
  const resolved = stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (resolved === undefined) {
    throw new Error(`找不到 ${command}`);
  }
  return resolved;
}

export async function installWindowsAutostart(options: WindowsAutostartOptions): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Windows 登录自启动只支持 Windows");
  }
  const profileName = validateProfileName(options.profileName);
  const configDirectory = options.configDirectory ?? DEFAULT_CONFIG_DIRECTORY;
  const launcherPath = join(configDirectory, `start-${profileName}.ps1`);
  const piCommand = options.piCommand ?? await resolveCommand("pi.cmd");
  const pwshCommand = options.pwshCommand ?? await resolveCommand("pwsh.exe");
  const launcher = [
    '$ErrorActionPreference = "Stop"',
    `Set-Location -LiteralPath ${quotePowerShellLiteral(options.workingDirectory)}`,
    `& ${quotePowerShellLiteral(piCommand)}`,
    "",
  ].join("\n");
  await mkdir(dirname(launcherPath), { recursive: true, mode: 0o700 });
  await writeFile(launcherPath, launcher, { encoding: "utf8", mode: 0o600 });

  const actionArguments = [
    "-NoLogo",
    "-NoProfile",
    ...(options.minimized ? ["-WindowStyle", "Minimized"] : []),
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    `\"${launcherPath}\"`,
  ].join(" ");
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$taskName = ${quotePowerShellLiteral(windowsTaskName(profileName))}`,
    `$action = New-ScheduledTaskAction -Execute ${quotePowerShellLiteral(pwshCommand)} -Argument ${quotePowerShellLiteral(actionArguments)} -WorkingDirectory ${quotePowerShellLiteral(options.workingDirectory)}`,
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity",
    "$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable",
    `Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ${quotePowerShellLiteral(`Start Pi for Telegram Bot ${profileName}`)} -Force | Out-Null`,
  ].join("\n");
  await execFileAsync(pwshCommand, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedPowerShellCommand(script),
  ], { windowsHide: true });
}

export async function removeWindowsAutostart(
  profileName: string,
  configDirectory = DEFAULT_CONFIG_DIRECTORY,
  pwshCommand?: string,
): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const validated = validateProfileName(profileName);
  const resolvedPwsh = pwshCommand ?? await resolveCommand("pwsh.exe");
  const script = [
    `$taskName = ${quotePowerShellLiteral(windowsTaskName(validated))}`,
    "if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {",
    "  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false",
    "}",
  ].join("\n");
  await execFileAsync(resolvedPwsh, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedPowerShellCommand(script),
  ], { windowsHide: true });
  await rm(join(configDirectory, `start-${validated}.ps1`), { force: true });
}
