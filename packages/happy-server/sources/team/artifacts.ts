import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "fs";
import path from "path";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { createGunzip } from "zlib";

const DEFAULT_CLI_ARTIFACT_PATH = "/opt/happy-team/artifacts/happy-cli.tgz";
const DEFAULT_NODE_ARTIFACT_DIR = "/opt/happy-team/artifacts/node";
const NODE_ARTIFACT_PLATFORMS = ["linux", "darwin"] as const;
const NODE_ARTIFACT_ARCHES = ["x64", "arm64"] as const;
type NodeArtifactFormat = "elf" | "macho";
type TeamNodeArtifactValidation = {
    valid: boolean;
    format?: NodeArtifactFormat;
    detectedPlatform?: string;
    detectedArch?: string;
    error?: string;
};
type TeamCliClaudeSdkTarget = {
    platform: NodeArtifactPlatform;
    arch: NodeArtifactArch;
    packageName: string;
    entry: string;
    exists: boolean;
};

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
    valid?: boolean;
    format?: NodeArtifactFormat;
    detectedPlatform?: string;
    detectedArch?: string;
    validationError?: string;
};
export type TeamCliClaudeSdkInfo = {
    path: string;
    exists: boolean;
    complete: boolean;
    error?: string;
    targets: TeamCliClaudeSdkTarget[];
};

const TEAM_CLAUDE_SDK_TARGETS: Array<Omit<TeamCliClaudeSdkTarget, "exists">> = [
    {
        platform: "linux",
        arch: "x64",
        packageName: "@anthropic-ai/claude-agent-sdk-linux-x64",
        entry: "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    },
    {
        platform: "linux",
        arch: "arm64",
        packageName: "@anthropic-ai/claude-agent-sdk-linux-arm64",
        entry: "node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
    },
    {
        platform: "darwin",
        arch: "x64",
        packageName: "@anthropic-ai/claude-agent-sdk-darwin-x64",
        entry: "node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude",
    },
    {
        platform: "darwin",
        arch: "arm64",
        packageName: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
        entry: "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
    },
];

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

export async function getTeamCliClaudeSdkInfo(): Promise<TeamCliClaudeSdkInfo> {
    const artifact = getTeamCliArtifactInfo();
    if (!artifact.exists) {
        return {
            path: artifact.path,
            exists: false,
            complete: false,
            targets: TEAM_CLAUDE_SDK_TARGETS.map((target) => ({ ...target, exists: false })),
        };
    }

    try {
        const foundEntries = await findGzipTarEntries(artifact.path, TEAM_CLAUDE_SDK_TARGETS.map((target) => target.entry));
        const targets = TEAM_CLAUDE_SDK_TARGETS.map((target) => ({
            ...target,
            exists: foundEntries.has(target.entry),
        }));
        return {
            path: artifact.path,
            exists: true,
            complete: targets.every((target) => target.exists),
            targets,
        };
    } catch (error) {
        return {
            path: artifact.path,
            exists: true,
            complete: false,
            error: error instanceof Error ? error.message : "Unable to inspect CLI artifact",
            targets: TEAM_CLAUDE_SDK_TARGETS.map((target) => ({ ...target, exists: false })),
        };
    }
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

async function findGzipTarEntries(filePath: string, expectedEntries: string[]): Promise<Set<string>> {
    const remaining = new Set(expectedEntries);
    const found = new Set<string>();
    let buffer = Buffer.alloc(0);
    let skipBytes = 0;

    const stream = createReadStream(filePath).pipe(createGunzip());
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk as Buffer]);

        while (true) {
            if (skipBytes > 0) {
                const consumed = Math.min(skipBytes, buffer.length);
                buffer = buffer.subarray(consumed);
                skipBytes -= consumed;
                if (skipBytes > 0) break;
                continue;
            }

            if (buffer.length < 512) break;
            const header = buffer.subarray(0, 512);
            buffer = buffer.subarray(512);
            if (isZeroTarBlock(header)) return found;

            const entryName = normalizeTarEntryPath(readTarEntryName(header));
            for (const expected of remaining) {
                if (entryName === expected || entryName.endsWith(`/${expected}`)) {
                    found.add(expected);
                    remaining.delete(expected);
                }
            }
            if (remaining.size === 0) return found;

            const entrySize = readTarEntrySize(header);
            skipBytes = Math.ceil(entrySize / 512) * 512;
        }
    }

    return found;
}

function isZeroTarBlock(block: Buffer): boolean {
    for (const byte of block) {
        if (byte !== 0) return false;
    }
    return true;
}

function readTarEntryName(header: Buffer): string {
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    return prefix ? `${prefix}/${name}` : name;
}

function readTarEntrySize(header: Buffer): number {
    const size = readTarString(header, 124, 12);
    const parsed = Number.parseInt(size || "0", 8);
    return Number.isFinite(parsed) ? parsed : 0;
}

function readTarString(header: Buffer, start: number, length: number): string {
    return header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/, "")
        .trim();
}

function normalizeTarEntryPath(value: string): string {
    return value.replace(/^\.\/+/, "").replace(/^\/+/, "");
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
    if (info.valid === false) {
        return reply.code(503).send({
            error: "Team Node artifact does not match requested platform",
            platform: info.platform,
            arch: info.arch,
            expectedPath: info.path,
            validationError: info.validationError,
            detectedPlatform: info.detectedPlatform,
            detectedArch: info.detectedArch,
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
            const validation = validateNodeArtifactBinary(candidate.path, normalizedPlatform, normalizedArch);
            return {
                platform: normalizedPlatform,
                arch: normalizedArch,
                path: candidate.path,
                exists: true,
                supported: true,
                source: candidate.source,
                size: stat.size,
                ...toArtifactValidationInfo(validation),
            };
        }
    }

    if (normalizedPlatform === process.platform && normalizedArch === process.arch && existsSync(process.execPath)) {
        const stat = statSync(process.execPath);
        const validation = validateNodeArtifactBinary(process.execPath, normalizedPlatform, normalizedArch);
        return {
            platform: normalizedPlatform,
            arch: normalizedArch,
            path: process.execPath,
            exists: true,
            supported: true,
            source: "server-runtime",
            size: stat.size,
            ...toArtifactValidationInfo(validation),
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

export function validateNodeArtifactBinary(filePath: string, expectedPlatform: string, expectedArch: string): TeamNodeArtifactValidation {
    const header = Buffer.alloc(64);
    let fd: number | undefined;
    try {
        fd = openSync(filePath, "r");
        const bytesRead = readSync(fd, header, 0, header.length, 0);
        if (bytesRead < 8) {
            return {
                valid: false,
                error: "Artifact is too small to be a Node binary",
            };
        }
    } catch (error) {
        return {
            valid: false,
            error: error instanceof Error ? error.message : "Unable to read artifact",
        };
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }

    const detected = detectNodeBinaryHeader(header);
    if (!detected) {
        return {
            valid: false,
            error: "Artifact is not a supported 64-bit ELF or Mach-O binary",
        };
    }

    const valid = detected.platform === expectedPlatform && detected.arch === expectedArch;
    return {
        valid,
        format: detected.format,
        detectedPlatform: detected.platform,
        detectedArch: detected.arch,
        error: valid ? undefined : `Expected ${expectedPlatform}/${expectedArch}, got ${detected.platform}/${detected.arch}`,
    };
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

function toArtifactValidationInfo(validation: TeamNodeArtifactValidation): Pick<TeamNodeArtifactInfo, "valid" | "format" | "detectedPlatform" | "detectedArch" | "validationError"> {
    return {
        valid: validation.valid,
        format: validation.format,
        detectedPlatform: validation.detectedPlatform,
        detectedArch: validation.detectedArch,
        validationError: validation.error,
    };
}

function detectNodeBinaryHeader(header: Buffer): { format: NodeArtifactFormat; platform: string; arch: string } | null {
    if (header.length >= 20 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
        if (header[4] !== 2 || header[5] !== 1) {
            return null;
        }
        const machine = header.readUInt16LE(18);
        if (machine === 0x3e) return { format: "elf", platform: "linux", arch: "x64" };
        if (machine === 0xb7) return { format: "elf", platform: "linux", arch: "arm64" };
        return null;
    }

    if (header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf) {
        const cpuType = header.readInt32LE(4);
        if (cpuType === 0x01000007) return { format: "macho", platform: "darwin", arch: "x64" };
        if (cpuType === 0x0100000c) return { format: "macho", platform: "darwin", arch: "arm64" };
        return null;
    }

    return null;
}

function isSupportedNodeArtifact(platform: string, arch: string): boolean {
    return (NODE_ARTIFACT_PLATFORMS as readonly string[]).includes(platform)
        && (NODE_ARTIFACT_ARCHES as readonly string[]).includes(arch);
}

function supportedNodeArtifactNames(): string[] {
    return NODE_ARTIFACT_PLATFORMS.flatMap((platform) => NODE_ARTIFACT_ARCHES.map((arch) => `${platform}/${arch}`));
}
