import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { type FastifyReply, type FastifyRequest } from "fastify";

const DEFAULT_CLI_ARTIFACT_PATH = "/opt/happy-team/artifacts/happy-cli.tgz";

export function getTeamPublicServerUrl(request?: FastifyRequest): string {
    if (process.env.TEAM_PUBLIC_SERVER_URL) return process.env.TEAM_PUBLIC_SERVER_URL.replace(/\/$/, "");
    if (process.env.HAPPY_PUBLIC_SERVER_URL) return process.env.HAPPY_PUBLIC_SERVER_URL.replace(/\/$/, "");
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");

    const proto = request?.headers["x-forwarded-proto"];
    const host = request?.headers["x-forwarded-host"] ?? request?.headers.host;
    if (typeof host === "string" && host.length > 0) {
        return `${typeof proto === "string" ? proto.split(",")[0] : "http"}://${host}`.replace(/\/$/, "");
    }

    return `http://localhost:${process.env.PORT || "3005"}`;
}

export function resolveTeamCliArtifactPath(): string {
    const configured = process.env.TEAM_CLI_ARTIFACT_PATH;
    if (configured) return configured;
    const local = path.join(process.cwd(), ".team-artifacts", "happy-cli.tgz");
    if (existsSync(local)) return local;
    return DEFAULT_CLI_ARTIFACT_PATH;
}

export function getTeamCliArtifactInfo(): { path: string; exists: boolean; size?: number } {
    const artifactPath = resolveTeamCliArtifactPath();
    if (!existsSync(artifactPath)) {
        return { path: artifactPath, exists: false };
    }
    const stat = statSync(artifactPath);
    return { path: artifactPath, exists: true, size: stat.size };
}

export function sendTeamCliArtifact(reply: FastifyReply) {
    const info = getTeamCliArtifactInfo();
    if (!info.exists) {
        return reply.code(503).send({
            error: "Team CLI artifact is not configured",
            expectedPath: info.path,
        });
    }
    return reply
        .type("application/gzip")
        .header("Content-Disposition", "attachment; filename=happy-cli.tgz")
        .send(createReadStream(info.path));
}

export function sendNodeArtifact(reply: FastifyReply, platform: string, arch: string) {
    if (platform !== "linux" || arch !== "x64") {
        return reply.code(404).send({ error: "Node artifact is only available for linux-x64 in this build" });
    }
    return reply
        .type("application/octet-stream")
        .header("Content-Disposition", "attachment; filename=node")
        .send(createReadStream(process.execPath));
}

export function buildManualInstallCommand(input: {
    serverUrl: string;
    token: string;
    agents: string[];
}): string {
    const cliUrl = `${input.serverUrl}/v1/team/artifacts/cli.tgz`;
    const nodeUrl = `${input.serverUrl}/v1/team/artifacts/node/linux/x64`;
    const token = shellQuote(input.token);
    const server = shellQuote(input.serverUrl);
    const wrapperLines = [
        "#!/bin/sh",
        "exec \"$HOME/.happy-team/bin/node\" \"$HOME/.happy-team/cli/bin/happy.mjs\" \"$@\"",
    ]
        .map(shellQuote)
        .join(" ");
    return [
        "mkdir -p \"$HOME/.happy-team/bin\" \"$HOME/.happy-team/cli\"",
        downloadCommand(nodeUrl, "\"$HOME/.happy-team/bin/node\""),
        "chmod 700 \"$HOME/.happy-team/bin/node\"",
        downloadCommand(cliUrl, "/tmp/happy-cli.tgz"),
        "tar -xzf /tmp/happy-cli.tgz -C \"$HOME/.happy-team/cli\"",
        `printf '%s\\n' ${wrapperLines} > "$HOME/.happy-team/bin/happy"`,
        "chmod 700 \"$HOME/.happy-team/bin/happy\"",
        "PATH=\"$HOME/.happy-team/bin:$PATH\"; export PATH",
        "\"$HOME/.happy-team/bin/happy\" enroll --server " + server + " --token " + token + " --force",
        "HAPPY_SERVER_URL=" + server + " \"$HOME/.happy-team/bin/happy\" daemon start",
    ].join(" && ");
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function downloadCommand(url: string, output: string): string {
    const quotedUrl = shellQuote(url);
    return `(command -v curl >/dev/null 2>&1 && curl -fsSL ${quotedUrl} -o ${output} || wget -q ${quotedUrl} -O ${output})`;
}
