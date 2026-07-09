import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { type FastifyReply, type FastifyRequest } from "fastify";

const DEFAULT_CLI_ARTIFACT_PATH = "/opt/happy-team/artifacts/happy-cli.tgz";
const DEFAULT_NODE_ARTIFACT_DIR = "/opt/happy-team/artifacts/node";
const NODE_ARTIFACT_PLATFORMS = ["linux", "darwin"] as const;
const NODE_ARTIFACT_ARCHES = ["x64", "arm64"] as const;

export type NodeArtifactPlatform = typeof NODE_ARTIFACT_PLATFORMS[number];
export type NodeArtifactArch = typeof NODE_ARTIFACT_ARCHES[number];
export type TeamNodeArtifactInfo = {
    platform: string;
    arch: string;
    path: string;
    exists: boolean;
    supported: boolean;
    source?: "configured" | "local" | "server-runtime";
    size?: number;
};

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
    const info = getTeamNodeArtifactInfo(platform, arch);
    if (!info.supported) {
        return reply.code(404).send({
            error: "Unsupported Team Node artifact platform",
            platform: info.platform,
            arch: info.arch,
            supported: supportedNodeArtifactNames(),
        });
    }
    if (!info.exists) {
        return reply.code(503).send({
            error: "Team Node artifact is not configured",
            platform: info.platform,
            arch: info.arch,
            expectedPath: info.path,
            supported: supportedNodeArtifactNames(),
        });
    }
    return reply
        .type("application/octet-stream")
        .header("Content-Disposition", `attachment; filename=node-${info.platform}-${info.arch}`)
        .send(createReadStream(info.path));
}

export function getTeamNodeArtifactInfo(platform: string, arch: string): TeamNodeArtifactInfo {
    const normalizedPlatform = normalizeNodePlatform(platform);
    const normalizedArch = normalizeNodeArch(arch);
    const artifactDir = resolveTeamNodeArtifactDir();
    const primaryPath = path.join(artifactDir, `${normalizedPlatform}-${normalizedArch}`, "node");
    const supported = isSupportedNodeArtifact(normalizedPlatform, normalizedArch);
    if (!supported) {
        return {
            platform: normalizedPlatform,
            arch: normalizedArch,
            path: primaryPath,
            exists: false,
            supported: false,
        };
    }

    const candidates: Array<{ path: string; source: TeamNodeArtifactInfo["source"] }> = [
        { path: primaryPath, source: "configured" },
        { path: path.join(artifactDir, normalizedPlatform, normalizedArch, "node"), source: "configured" },
        { path: path.join(process.cwd(), ".team-artifacts", "node", `${normalizedPlatform}-${normalizedArch}`, "node"), source: "local" },
        { path: path.join(process.cwd(), ".team-artifacts", "node", normalizedPlatform, normalizedArch, "node"), source: "local" },
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate.path)) {
            const stat = statSync(candidate.path);
            return {
                platform: normalizedPlatform,
                arch: normalizedArch,
                path: candidate.path,
                exists: true,
                supported: true,
                source: candidate.source,
                size: stat.size,
            };
        }
    }

    if (normalizedPlatform === process.platform && normalizedArch === process.arch && existsSync(process.execPath)) {
        const stat = statSync(process.execPath);
        return {
            platform: normalizedPlatform,
            arch: normalizedArch,
            path: process.execPath,
            exists: true,
            supported: true,
            source: "server-runtime",
            size: stat.size,
        };
    }

    return {
        platform: normalizedPlatform,
        arch: normalizedArch,
        path: primaryPath,
        exists: false,
        supported: true,
    };
}

export function resolveTeamNodeArtifactDir(): string {
    return process.env.TEAM_NODE_ARTIFACT_DIR || DEFAULT_NODE_ARTIFACT_DIR;
}

export function buildNodeArtifactDownloadCommand(serverUrl: string, output: string): string {
    const server = shellQuote(serverUrl);
    return [
        "platform=$(uname -s | tr '[:upper:]' '[:lower:]')",
        "case \"$platform\" in linux|darwin) ;; *) echo \"Unsupported platform: $platform\" >&2; exit 1 ;; esac",
        "machine=$(uname -m)",
        "case \"$machine\" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo \"Unsupported architecture: $machine\" >&2; exit 1 ;; esac",
        `node_url=${server}/v1/team/artifacts/node/$platform/$arch`,
        downloadCommandFromVariable("node_url", output),
    ].join("\n");
}

export function buildManualInstallCommand(input: {
    serverUrl: string;
    token: string;
    agents: string[];
}): string {
    const cliUrl = `${input.serverUrl}/v1/team/artifacts/cli.tgz`;
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
        buildNodeArtifactDownloadCommand(input.serverUrl, "\"$HOME/.happy-team/bin/node\""),
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

function downloadCommandFromVariable(variableName: string, output: string): string {
    return `(command -v curl >/dev/null 2>&1 && curl -fsSL "$${variableName}" -o ${output} || wget -q "$${variableName}" -O ${output})`;
}

function normalizeNodePlatform(platform: string): string {
    const value = platform.toLowerCase();
    if (value === "macos" || value === "osx") return "darwin";
    return value;
}

function normalizeNodeArch(arch: string): string {
    const value = arch.toLowerCase();
    if (value === "x86_64" || value === "amd64") return "x64";
    if (value === "aarch64") return "arm64";
    return value;
}

function isSupportedNodeArtifact(platform: string, arch: string): boolean {
    return (NODE_ARTIFACT_PLATFORMS as readonly string[]).includes(platform)
        && (NODE_ARTIFACT_ARCHES as readonly string[]).includes(arch);
}

function supportedNodeArtifactNames(): string[] {
    return NODE_ARTIFACT_PLATFORMS.flatMap((platform) => NODE_ARTIFACT_ARCHES.map((arch) => `${platform}/${arch}`));
}
