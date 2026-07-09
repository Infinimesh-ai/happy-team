import axios from 'axios';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { authChallenge, decodeBase64, encodeBase64 } from '@/api/encryption';
import { stopDaemon } from '@/daemon/controlClient';
import { clearCredentials, clearMachineId, readCredentials, readSettings, updateSettings, writeCredentialsLegacy } from '@/persistence';
import { logger } from '@/ui/logger';

type EnrollOptions = {
  serverUrl: string;
  token: string;
  force: boolean;
};

export async function handleEnrollCommand(args: string[]): Promise<void> {
  const options = parseEnrollArgs(args);
  if (!options) {
    showEnrollHelp();
    return;
  }

  const existingCredentials = await readCredentials();
  const existingSettings = await readSettings();
  if (!options.force && (existingCredentials || existingSettings.machineId)) {
    throw new Error('This machine is already enrolled. Re-run with --force to replace local credentials and machine ID.');
  }

  if (options.force) {
    try {
      await stopDaemon();
    } catch (error) {
      logger.debug('Daemon was not running or failed to stop before enroll:', error);
    }
    await clearCredentials();
    await clearMachineId();
  }

  const secretKey = await fetchManagedSecretKey(options.serverUrl, options.token);
  const happyToken = await authGetToken(options.serverUrl, secretKey);
  const machineId = randomUUID();

  await writeCredentialsLegacy({
    secret: secretKey,
    token: happyToken,
  });
  await updateSettings((settings) => ({
    ...settings,
    onboardingCompleted: true,
    serverUrl: options.serverUrl,
    webappUrl: settings.webappUrl,
    machineId,
  }));

  console.log(chalk.green('Enrolled with Happy Team successfully'));
  console.log(chalk.gray(`  Server: ${options.serverUrl}`));
  console.log(chalk.gray(`  Machine ID: ${machineId}`));
  console.log(chalk.gray(`  Host: ${os.hostname()}`));
}

function parseEnrollArgs(args: string[]): EnrollOptions | null {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return null;
  }

  let serverUrl: string | undefined;
  let token: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--server') {
      serverUrl = args[++i];
    } else if (arg === '--token') {
      token = args[++i];
    } else if (arg === '--force' || arg === '-f') {
      force = true;
    } else {
      throw new Error(`Unknown enroll option: ${arg}`);
    }
  }

  if (!serverUrl) {
    throw new Error('Missing required --server <url>');
  }
  if (!token) {
    throw new Error('Missing required --token <token>');
  }

  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  return { serverUrl: normalizedServerUrl, token, force };
}

function normalizeServerUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('--server must be an http(s) URL');
  }
  return parsed.toString().replace(/\/$/, '');
}

async function fetchManagedSecretKey(serverUrl: string, token: string): Promise<Uint8Array> {
  const response = await axios.post(`${serverUrl}/v1/team/enroll`, { token }, {
    headers: { 'X-Happy-Client': 'cli/team-enroll' },
  });
  const secretKey = response.data?.secretKey;
  if (typeof secretKey !== 'string') {
    throw new Error('Team enroll response did not include a secretKey');
  }
  const decoded = decodeBase64(secretKey, 'base64url');
  if (decoded.length !== 32) {
    throw new Error('Team enroll response returned an invalid secretKey');
  }
  return decoded;
}

async function authGetToken(serverUrl: string, secret: Uint8Array): Promise<string> {
  const { challenge, publicKey, signature } = authChallenge(secret);
  const response = await axios.post(`${serverUrl}/v1/auth`, {
    challenge: encodeBase64(challenge),
    publicKey: encodeBase64(publicKey),
    signature: encodeBase64(signature),
  }, {
    headers: { 'X-Happy-Client': 'cli/team-enroll' },
  });

  if (!response.data?.success || typeof response.data.token !== 'string') {
    throw new Error('Authentication failed after team enroll');
  }
  return response.data.token;
}

function showEnrollHelp(): void {
  console.log(`
${chalk.bold('happy enroll')} - Enroll this machine with Happy Team

${chalk.bold('Usage:')}
  happy enroll --server <url> --token <one-time-token> [--force]

${chalk.bold('Options:')}
  --server <url>   Happy Team server URL
  --token <token>  One-time enroll token from your team admin
  --force          Replace local credentials and machine ID
`);
}
