import { AgentAuthMode, ProvisionStatus, type TeamUser } from "@prisma/client";
import { db } from "@/storage/db";
import { buildClaudeSdkCliWrapperCommand, buildCodexCliWrapperCommand, buildManualInstallCommand, buildNodeArtifactDownloadCommand, downloadCommand, shellQuote } from "@/team/artifacts";
import { buildSshConnectionInput, SshExecutor, type SshExecResult } from "@/team/provision/ssh";
import { decryptSshCredentialAuth } from "@/team/sshCredentials";
import { writeTeamAudit } from "@/team/audit";

const MAX_CONCURRENT_PROVISION_JOBS = 3;
const MAX_LOG_APPEND_LENGTH = 4000;

type ProvisionSecrets = {
    enrollToken: string;
    serverUrl: string;
};

type ProvisionQueueItem = {
    jobId: string;
    secrets: ProvisionSecrets;
};

let activeJobs = 0;
const pendingJobs: ProvisionQueueItem[] = [];

export function enqueueProvisionJob(jobId: string, secrets: ProvisionSecrets): void {
    pendingJobs.push({ jobId, secrets });
    drainProvisionQueue();
}

export function getProvisionQueueState(): { activeJobs: number; pendingJobs: number } {
    return { activeJobs, pendingJobs: pendingJobs.length };
}

function drainProvisionQueue(): void {
    while (activeJobs < MAX_CONCURRENT_PROVISION_JOBS && pendingJobs.length > 0) {
        const item = pendingJobs.shift()!;
        activeJobs += 1;
        runProvisionJob(item.jobId, item.secrets)
            .catch((error) => {
                console.error("Provision job failed", error);
            })
            .finally(() => {
                activeJobs -= 1;
                drainProvisionQueue();
            });
    }
}

export async function runProvisionJob(jobId: string, secrets: ProvisionSecrets): Promise<void> {
    const job = await db.provisionJob.findUnique({ where: { id: jobId } });
    if (!job) {
        throw new Error(`Provision job ${jobId} not found`);
    }
    if (!job.credentialId) {
        throw new Error("Provision job does not have an SSH credential");
    }

    const [credential, targetUser] = await Promise.all([
        db.sshCredential.findUnique({ where: { id: job.credentialId } }),
        db.teamUser.findUnique({ where: { id: job.targetUserId } }),
    ]);
    if (!credential) throw new Error("SSH credential not found");
    if (!targetUser) throw new Error("Target user not found");

    const sshAuth = decryptSshCredentialAuth(credential);
    const redactions = [
        secrets.enrollToken,
        process.env.TEAM_ANTHROPIC_API_KEY,
        process.env.TEAM_OPENAI_API_KEY,
        sshAuth.type === "PASSWORD" ? sshAuth.password : sshAuth.privateKey,
        sshAuth.type === "PRIVATE_KEY" ? sshAuth.passphrase : undefined,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);

    const executor = new SshExecutor();
    const startTime = new Date();

    await db.provisionJob.update({
        where: { id: jobId },
        data: {
            status: ProvisionStatus.RUNNING,
            step: "connect",
            log: "",
        },
    });
    await appendJobLog(jobId, "connect", `Connecting to ${credential.username}@${credential.host}:${credential.port}`, redactions);

    try {
        await executor.connect(buildSshConnectionInput(credential));
        await appendJobLog(jobId, "connect", "SSH connection established", redactions);

        await setStep(jobId, "detect");
        await runShell(executor, jobId, "detect", "uname -a && printf '\\nHOME=%s\\nUSER=%s\\n' \"$HOME\" \"$(id -un)\"", redactions, 20_000);

        await setStep(jobId, "install_node");
        const nodePath = await installNode(executor, jobId, secrets.serverUrl, redactions);

        await setStep(jobId, "install_cli");
        await installCli(executor, jobId, secrets.serverUrl, nodePath, redactions);

        await setStep(jobId, "enroll");
        await runShell(
            executor,
            jobId,
            "enroll",
            `"${escapeDoubleQuoted("$HOME/.happy-team/bin/happy")}" enroll --server ${shellQuote(secrets.serverUrl)} --token ${shellQuote(secrets.enrollToken)} --force`,
            redactions,
            60_000,
        );

        await setStep(jobId, "setup_agents");
        await setupAgents(executor, jobId, targetUser, job.agents, redactions);

        await setStep(jobId, "start_daemon");
        await startDaemon(executor, jobId, secrets.serverUrl, redactions);

        await setStep(jobId, "verify");
        const machine = await waitForMachine(targetUser.accountId, startTime);

        if (credential.deleteAfterUse) {
            await db.sshCredential.delete({ where: { id: credential.id } });
            await appendJobLog(jobId, "cleanup", "Deleted SSH credential after successful provisioning", redactions);
        }

        await db.provisionJob.update({
            where: { id: jobId },
            data: {
                status: ProvisionStatus.SUCCEEDED,
                step: "verify",
                machineId: machine.id,
                finishedAt: new Date(),
            },
        });
        await writeTeamAudit({
            actorId: job.createdBy,
            action: "provision_succeeded",
            target: job.targetUserId,
            detail: { jobId, machineId: machine.id, agents: job.agents },
        });
    } catch (error) {
        await failJob(jobId, error instanceof Error ? error.message : String(error), secrets, redactions);
        throw error;
    } finally {
        executor.close();
    }
}

async function failJob(jobId: string, errorMessage: string, secrets: ProvisionSecrets, existingRedactions: string[] = []): Promise<void> {
    const redactions = [secrets.enrollToken, ...existingRedactions].filter((value) => value.length > 0);
    const redacted = redact(errorMessage, redactions);
    await appendJobLog(jobId, "failed", redacted, redactions).catch(() => {});
    const job = await db.provisionJob.findUnique({ where: { id: jobId } });
    await db.provisionJob.update({
        where: { id: jobId },
        data: {
            status: ProvisionStatus.FAILED,
            error: redacted,
            finishedAt: new Date(),
        },
    }).catch(() => {});
    if (job) {
        await writeTeamAudit({
            actorId: job.createdBy,
            action: "provision_failed",
            target: job.targetUserId,
            detail: { jobId, error: redacted },
        }).catch(() => {});
    }
}

async function setStep(jobId: string, step: string): Promise<void> {
    await db.provisionJob.update({ where: { id: jobId }, data: { step } });
}

async function appendJobLog(jobId: string, step: string, message: string, redactions: string[]): Promise<void> {
    const job = await db.provisionJob.findUnique({ where: { id: jobId }, select: { log: true } });
    if (!job) return;
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${step}: ${redact(message, redactions).slice(0, MAX_LOG_APPEND_LENGTH)}\n`;
    await db.provisionJob.update({
        where: { id: jobId },
        data: { log: job.log + line },
    });
}

function redact(input: string, redactions: string[]): string {
    let out = input;
    for (const secret of redactions) {
        if (secret.length === 0) continue;
        out = out.split(secret).join("[redacted]");
    }
    return out;
}

export function redactProvisionText(input: string, redactions: string[]): string {
    return redact(input, redactions);
}

async function runShell(
    executor: SshExecutor,
    jobId: string,
    step: string,
    command: string,
    redactions: string[],
    timeoutMs: number,
): Promise<SshExecResult> {
    const result = await executor.exec(`set -eu\n${command}`, timeoutMs);
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    if (output.length > 0) {
        await appendJobLog(jobId, step, output, redactions);
    }
    if (result.code !== 0) {
        throw new Error(`Remote command failed at ${step} with code ${result.code ?? "unknown"}: ${output}`);
    }
    return result;
}

export function buildInstallNodeCommand(serverUrl: string): string {
    return [
        "mkdir -p \"$HOME/.happy-team/bin\"",
        "if command -v node >/dev/null 2>&1 && node -e 'const v=Number(process.versions.node.split(\".\")[0]); process.exit(v >= 20 ? 0 : 1)' >/dev/null 2>&1; then",
        "  command -v node",
        "else",
        // Download to a temp path and rename over the target: a running daemon
        // keeps the old binary open (writing in place fails with ETXTBSY on
        // re-provisioning), while rename() swaps it atomically.
        buildNodeArtifactDownloadCommand(serverUrl, "\"$HOME/.happy-team/bin/node.download\"").split("\n").map((line) => `  ${line}`).join("\n"),
        "  chmod 700 \"$HOME/.happy-team/bin/node.download\"",
        "  mv -f \"$HOME/.happy-team/bin/node.download\" \"$HOME/.happy-team/bin/node\"",
        "  printf '%s\\n' \"$HOME/.happy-team/bin/node\"",
        "fi",
    ].join("\n");
}

async function installNode(executor: SshExecutor, jobId: string, serverUrl: string, redactions: string[]): Promise<string> {
    const result = await runShell(executor, jobId, "install_node", buildInstallNodeCommand(serverUrl), redactions, 120_000);
    const nodePath = result.stdout.trim().split("\n").at(-1)?.trim();
    if (!nodePath) {
        throw new Error("Could not determine Node path");
    }
    await appendJobLog(jobId, "install_node", `Node ready at ${nodePath}`, redactions);
    return nodePath;
}

async function installCli(executor: SshExecutor, jobId: string, serverUrl: string, nodePath: string, redactions: string[]): Promise<void> {
    await runShell(executor, jobId, "install_cli", buildInstallCliCommand(serverUrl, nodePath), redactions, 180_000);
}

export function buildInstallCliCommand(serverUrl: string, nodePath: string): string {
    const cliUrl = `${serverUrl}/v1/team/artifacts/cli.tgz`;
    return [
        "mkdir -p \"$HOME/.happy-team/bin\" \"$HOME/.happy-team/cli.tmp\"",
        "rm -rf \"$HOME/.happy-team/cli.tmp\" \"$HOME/.happy-team/cli\"",
        "mkdir -p \"$HOME/.happy-team/cli.tmp\"",
        downloadCommand(cliUrl, "/tmp/happy-cli.tgz"),
        "tar -xzf /tmp/happy-cli.tgz -C \"$HOME/.happy-team/cli.tmp\"",
        "mv \"$HOME/.happy-team/cli.tmp\" \"$HOME/.happy-team/cli\"",
        "cat > \"$HOME/.happy-team/bin/happy\" <<'HAPPY_TEAM_SH'",
        "#!/bin/sh",
        `exec ${shellQuote(nodePath)} "$HOME/.happy-team/cli/bin/happy.mjs" "$@"`,
        "HAPPY_TEAM_SH",
        "chmod 700 \"$HOME/.happy-team/bin/happy\"",
        buildClaudeSdkCliWrapperCommand(),
        buildCodexCliWrapperCommand(shellQuote(nodePath)),
        "test -s \"$HOME/.happy-team/cli/dist/index.mjs\"",
        `${shellQuote(nodePath)} -e 'console.log("happy cli installed")'`,
    ].join("\n");
}

async function setupAgents(
    executor: SshExecutor,
    jobId: string,
    targetUser: TeamUser,
    agents: string[],
    redactions: string[],
): Promise<void> {
    const envLines: string[] = [
        "# Managed by Happy Team Edition. Rewrite through the team admin UI.",
    ];

    if (agents.includes("claude") && targetUser.claudeAuthMode === AgentAuthMode.COMPANY_API) {
        if (!process.env.TEAM_ANTHROPIC_API_KEY) {
            throw new Error("TEAM_ANTHROPIC_API_KEY is not configured");
        }
        envLines.push(`ANTHROPIC_API_KEY=${shellQuote(process.env.TEAM_ANTHROPIC_API_KEY)}`);
        if (process.env.TEAM_ANTHROPIC_BASE_URL) {
            envLines.push(`ANTHROPIC_BASE_URL=${shellQuote(process.env.TEAM_ANTHROPIC_BASE_URL)}`);
        }
    }
    if (agents.includes("codex") && targetUser.codexAuthMode === AgentAuthMode.COMPANY_API) {
        if (!process.env.TEAM_OPENAI_API_KEY) {
            throw new Error("TEAM_OPENAI_API_KEY is not configured");
        }
        envLines.push(`OPENAI_API_KEY=${shellQuote(process.env.TEAM_OPENAI_API_KEY)}`);
        if (process.env.TEAM_OPENAI_BASE_URL) {
            envLines.push(`OPENAI_BASE_URL=${shellQuote(process.env.TEAM_OPENAI_BASE_URL)}`);
        }
    }

    const envContent = `${envLines.join("\n")}\n`;
    const command = [
        "mkdir -p \"$HOME/.happy-team\"",
        `cat > "$HOME/.happy-team/agent.env" <<'HAPPY_TEAM_ENV'\n${envContent}HAPPY_TEAM_ENV`,
        "chmod 600 \"$HOME/.happy-team/agent.env\"",
        "ls -l \"$HOME/.happy-team/agent.env\"",
    ].join("\n");
    await runShell(executor, jobId, "setup_agents", command, redactions, 30_000);
}

async function startDaemon(executor: SshExecutor, jobId: string, serverUrl: string, redactions: string[]): Promise<void> {
    await runShell(executor, jobId, "start_daemon", buildStartDaemonCommand(serverUrl), redactions, 60_000);
}

export function buildStartDaemonCommand(serverUrl: string): string {
    return [
        "platform=$(uname -s | tr '[:upper:]' '[:lower:]')",
        "case \"$platform\" in",
        "darwin)",
        buildMacLaunchdStartCommand(serverUrl),
        ";;",
        "*)",
        buildLinuxStartDaemonCommand(serverUrl),
        ";;",
        "esac",
    ].join("\n");
}

function buildLinuxStartDaemonCommand(serverUrl: string): string {
    const unitContent = [
        "[Unit]",
        "Description=Happy Team daemon",
        "After=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        `Environment=HAPPY_SERVER_URL=${serverUrl}`,
        "Environment=HAPPY_HOME_DIR=%h/.happy",
        "Environment=PATH=%h/.happy-team/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "EnvironmentFile=%h/.happy-team/agent.env",
        "ExecStart=%h/.happy-team/bin/happy daemon start-sync",
        "Restart=always",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");

    const pathExport = "PATH=\"$HOME/.happy-team/bin:$PATH\"; export PATH";
    const daemonStartShell = `${pathExport}; set -a; . "$HOME/.happy-team/agent.env"; set +a; "$HOME/.happy-team/bin/happy" daemon start`;
    const rebootCommand = shellQuote(
        `@reboot HAPPY_SERVER_URL=${shellQuote(serverUrl)} HAPPY_HOME_DIR="$HOME/.happy" sh -lc ${shellQuote(daemonStartShell)}`,
    );
    const fallbackStart = [
        pathExport,
        "\"$HOME/.happy-team/bin/happy\" daemon stop >/dev/null 2>&1 || true",
        `HAPPY_SERVER_URL=${shellQuote(serverUrl)} HAPPY_HOME_DIR="$HOME/.happy" sh -lc ${shellQuote(daemonStartShell)}`,
        "if command -v crontab >/dev/null 2>&1; then",
        "  (crontab -l 2>/dev/null | grep -v 'happy-team/bin/happy daemon start' || true; " +
            `printf '%s\\n' ${rebootCommand}) | crontab -`,
        "else",
        "  echo 'crontab unavailable; daemon started without reboot fallback'",
        "fi",
    ].join("\n");

    const command = [
        "mkdir -p \"$HOME/.config/systemd/user\"",
        `cat > "$HOME/.config/systemd/user/happy-team.service" <<'HAPPY_TEAM_UNIT'\n${unitContent}HAPPY_TEAM_UNIT`,
        "if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then",
        "  systemctl --user daemon-reload",
        "  systemctl --user enable --now happy-team.service",
        "else",
        fallbackStart.split("\n").map((line) => `  ${line}`).join("\n"),
        "fi",
    ].join("\n");
    return command;
}

function buildMacLaunchdStartCommand(serverUrl: string): string {
    const macPath = "$HOME/.happy-team/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const claudeOauthExport = buildMacClaudeOauthExportSnippet();
    const detachedStartShell = [
        `PATH="${macPath}"; export PATH`,
        "set -a",
        ". \"$HOME/.happy-team/agent.env\"",
        "set +a",
        claudeOauthExport,
        "\"$HOME/.happy-team/bin/happy\" daemon start",
    ].join("; ");
    const fallbackStart = [
        `PATH="${macPath}"; export PATH`,
        "\"$HOME/.happy-team/bin/happy\" daemon stop >/dev/null 2>&1 || true",
        `HAPPY_SERVER_URL=${shellQuote(serverUrl)} HAPPY_HOME_DIR="$HOME/.happy" sh -lc ${shellQuote(detachedStartShell)}`,
    ].join("\n");
    const launchdScript = [
        "#!/bin/sh",
        `PATH="${macPath}"`,
        "export PATH",
        "set -a",
        ". \"$HOME/.happy-team/agent.env\"",
        "set +a",
        claudeOauthExport,
        "exec \"$HOME/.happy-team/bin/happy\" daemon start-sync",
        "",
    ].join("\n");

    return [
        "label=com.happy-team.daemon",
        "plist=\"$HOME/Library/LaunchAgents/$label.plist\"",
        "launch_script=\"$HOME/.happy-team/launchd-start.sh\"",
        "mkdir -p \"$HOME/Library/LaunchAgents\" \"$HOME/.happy\"",
        `cat > "$launch_script" <<'HAPPY_TEAM_LAUNCHD_SH'\n${launchdScript}HAPPY_TEAM_LAUNCHD_SH`,
        "chmod 700 \"$launch_script\"",
        "xml_escape() { sed -e 's/&/\\&amp;/g' -e 's/</\\&lt;/g' -e 's/>/\\&gt;/g' -e 's/\"/\\&quot;/g'; }",
        `server_xml=$(printf '%s' ${shellQuote(serverUrl)} | xml_escape)`,
        "home_xml=$(printf '%s' \"$HOME\" | xml_escape)",
        "launch_command=\"exec \\\"$launch_script\\\"\"",
        "launch_command_xml=$(printf '%s' \"$launch_command\" | xml_escape)",
        `path_xml=$(printf '%s' "${macPath}" | xml_escape)`,
        "cat > \"$plist\" <<HAPPY_TEAM_PLIST",
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\">",
        "<dict>",
        "  <key>Label</key>",
        "  <string>$label</string>",
        "  <key>ProgramArguments</key>",
        "  <array>",
        "    <string>/bin/sh</string>",
        "    <string>-lc</string>",
        "    <string>$launch_command_xml</string>",
        "  </array>",
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        "    <key>HAPPY_SERVER_URL</key>",
        "    <string>$server_xml</string>",
        "    <key>HAPPY_HOME_DIR</key>",
        "    <string>$home_xml/.happy</string>",
        "    <key>PATH</key>",
        "    <string>$path_xml</string>",
        "  </dict>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        "  <key>KeepAlive</key>",
        "  <true/>",
        "  <key>StandardOutPath</key>",
        "  <string>$home_xml/.happy/daemon.log</string>",
        "  <key>StandardErrorPath</key>",
        "  <string>$home_xml/.happy/daemon.err</string>",
        "</dict>",
        "</plist>",
        "HAPPY_TEAM_PLIST",
        "chmod 644 \"$plist\"",
        "if command -v launchctl >/dev/null 2>&1; then",
        "  uid=$(id -u)",
        "  launchctl bootout \"gui/$uid\" \"$plist\" >/dev/null 2>&1 || launchctl unload \"$plist\" >/dev/null 2>&1 || true",
        "  if launchctl bootstrap \"gui/$uid\" \"$plist\" >/dev/null 2>&1 || launchctl load \"$plist\" >/dev/null 2>&1; then",
        "    launchctl kickstart -k \"gui/$uid/$label\" >/dev/null 2>&1 || true",
        "    echo \"launchd agent installed at $plist\"",
        "  else",
        "    echo 'launchctl could not load user agent; daemon started without launchd fallback'",
        fallbackStart.split("\n").map((line) => `    ${line}`).join("\n"),
        "  fi",
        "else",
        "  echo 'launchctl unavailable; daemon started without launchd fallback'",
        fallbackStart.split("\n").map((line) => `  ${line}`).join("\n"),
        "fi",
    ].join("\n");
}

function buildMacClaudeOauthExportSnippet(): string {
    return [
        "if [ -z \"${ANTHROPIC_API_KEY:-}\" ] && [ -z \"${CLAUDE_CODE_OAUTH_TOKEN:-}\" ] && [ -x \"$HOME/.happy-team/bin/node\" ]; then",
        "  token=$(",
        "    \"$HOME/.happy-team/bin/node\" 2>/dev/null <<'HAPPY_TEAM_CLAUDE_TOKEN' || true",
        "const fs = require('node:fs');",
        "const os = require('node:os');",
        "const path = require('node:path');",
        "const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');",
        "const credentialsPath = path.join(configDir, '.credentials.json');",
        "try {",
        "  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));",
        "  const candidates = [",
        "    credentials?.claudeAiOauth?.accessToken,",
        "    credentials?.claudeAiOauth?.access_token,",
        "    credentials?.oauth?.accessToken,",
        "    credentials?.oauth?.access_token,",
        "    credentials?.accessToken,",
        "    credentials?.access_token,",
        "    credentials?.token,",
        "  ];",
        "  const token = candidates.find((value) => typeof value === 'string' && value.length > 0);",
        "  if (token) process.stdout.write(token);",
        "} catch {}",
        "HAPPY_TEAM_CLAUDE_TOKEN",
        "  )",
        "  if [ -n \"$token\" ]; then export CLAUDE_CODE_OAUTH_TOKEN=\"$token\"; fi",
        "  unset token",
        "fi",
    ].join("\n");
}

async function waitForMachine(accountId: string, startTime: Date): Promise<{ id: string }> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const machine = await db.machine.findFirst({
            where: {
                accountId,
                active: true,
                lastActiveAt: { gte: startTime },
            },
            orderBy: { lastActiveAt: "desc" },
            select: { id: true },
        });
        if (machine) {
            return machine;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Timed out waiting for the enrolled daemon to come online");
}

function escapeDoubleQuoted(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export function buildProvisionManualInstallCommand(input: { serverUrl: string; token: string; agents: string[] }): string {
    return buildManualInstallCommand(input);
}
