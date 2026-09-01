import { execSync } from 'child_process';
import os from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'node:module';
import { findAgyBin } from '@/agy/constants';

const nodeRequire = createRequire(import.meta.url);
type ClaudeAgentSdkBinaryCandidate = {
  packageName: string;
  binary: string;
};

export interface CLIAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  openclaw: boolean;
  agy: boolean;
  detectedAt: number;
}

/**
 * Detects which CLI tools are available on this machine.
 * Cross-platform: uses `command -v` on POSIX, `Get-Command` on Windows.
 */
export function detectCLIAvailability(): CLIAvailability {
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    return detectWindows();
  }
  return detectPosix();
}

export function hasBundledClaudeAgentSdk(): boolean {
  try {
    nodeRequire.resolve('@anthropic-ai/claude-agent-sdk');
  } catch {
    return false;
  }

  return getClaudeAgentSdkBinaryCandidates().some((candidate) => {
    try {
      nodeRequire.resolve(`${candidate.packageName}/${candidate.binary}`);
      return true;
    } catch {
      return false;
    }
  });
}

export function resolveClaudeAvailability(commandAvailable: boolean, bundledSdkAvailable = hasBundledClaudeAgentSdk()): boolean {
  return commandAvailable || bundledSdkAvailable;
}

export function getClaudeAgentSdkBinaryCandidates(
  platform: NodeJS.Platform = os.platform(),
  arch: string = os.arch(),
): ClaudeAgentSdkBinaryCandidate[] {
  if (platform === 'darwin') {
    if (arch === 'arm64') return [{ packageName: '@anthropic-ai/claude-agent-sdk-darwin-arm64', binary: 'claude' }];
    if (arch === 'x64') return [{ packageName: '@anthropic-ai/claude-agent-sdk-darwin-x64', binary: 'claude' }];
  }
  if (platform === 'linux') {
    const libc = getLinuxLibc();
    if (arch === 'arm64') {
      return libc === 'musl'
        ? [{ packageName: '@anthropic-ai/claude-agent-sdk-linux-arm64-musl', binary: 'claude' }]
        : [{ packageName: '@anthropic-ai/claude-agent-sdk-linux-arm64', binary: 'claude' }];
    }
    if (arch === 'x64') {
      return libc === 'musl'
        ? [{ packageName: '@anthropic-ai/claude-agent-sdk-linux-x64-musl', binary: 'claude' }]
        : [{ packageName: '@anthropic-ai/claude-agent-sdk-linux-x64', binary: 'claude' }];
    }
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return [{ packageName: '@anthropic-ai/claude-agent-sdk-win32-arm64', binary: 'claude.exe' }];
    if (arch === 'x64') return [{ packageName: '@anthropic-ai/claude-agent-sdk-win32-x64', binary: 'claude.exe' }];
  }
  return [];
}

function getLinuxLibc(): 'glibc' | 'musl' {
  const report = typeof process.report?.getReport === 'function' ? process.report.getReport() : undefined;
  const header = (report as { header?: Record<string, unknown> } | undefined)?.header;
  return header && 'glibcVersionRuntime' in header ? 'glibc' : 'musl';
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command} >/dev/null 2>&1`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function detectPosix(): CLIAvailability {
  const claude = resolveClaudeAvailability(commandExists('claude'));
  const codex = commandExists('codex');
  const gemini = commandExists('gemini');
  const agy = findAgyBin() !== undefined;

  // OpenClaw: check command, config file, or env var
  const openclawCommand = commandExists('openclaw');
  const openclawConfig = existsSync(join(os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, agy, detectedAt: Date.now() };
}

function detectWindows(): CLIAvailability {
  const checkCommand = (name: string): boolean => {
    try {
      execSync(`powershell -NoProfile -Command "Get-Command ${name} -ErrorAction SilentlyContinue"`, { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };

  const claude = resolveClaudeAvailability(checkCommand('claude'));
  const codex = checkCommand('codex');
  const gemini = checkCommand('gemini');
  const agy = findAgyBin() !== undefined;

  // OpenClaw: check command, config file, or env var
  const openclawCommand = checkCommand('openclaw');
  const openclawConfig = existsSync(join(process.env.USERPROFILE || os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, agy, detectedAt: Date.now() };
}
