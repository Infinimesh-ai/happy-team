import { type FastifyRequest } from "fastify";
import { getTeamCliArtifactInfo, getTeamCliClaudeSdkInfo, getTeamNodeArtifactInfo, getTeamPublicServerUrl } from "@/team/artifacts";

type PreflightStatus = "ok" | "warning" | "action_required";

type PreflightCheck = {
    key: string;
    status: PreflightStatus;
    message: string;
    detail?: Record<string, string | number | boolean | null>;
};

const NODE_TARGETS = [
    { platform: "linux", arch: "x64", required: true },
    { platform: "linux", arch: "arm64", required: false },
    { platform: "darwin", arch: "x64", required: false },
    { platform: "darwin", arch: "arm64", required: false },
] as const;

export async function getTeamDeploymentPreflight(request?: FastifyRequest) {
    const checks: PreflightCheck[] = [];
    const serverUrl = getTeamPublicServerUrl(request);
    const nodeArtifactInfos = new Map<string, ReturnType<typeof getTeamNodeArtifactInfo>>();

    checks.push({
        key: "handy_master_secret",
        status: secretLooksStrong(process.env.HANDY_MASTER_SECRET) ? "ok" : "action_required",
        message: secretLooksStrong(process.env.HANDY_MASTER_SECRET)
            ? "HANDY_MASTER_SECRET is configured with sufficient length."
            : "Set HANDY_MASTER_SECRET to a strong random value before storing Team data.",
    });

    checks.push({
        key: "team_public_server_url",
        status: isLoopbackUrl(serverUrl) ? "warning" : "ok",
        message: isLoopbackUrl(serverUrl)
            ? "TEAM_PUBLIC_SERVER_URL resolves to localhost; remote target machines must be able to reach this URL."
            : "TEAM_PUBLIC_SERVER_URL is configured for remote targets.",
        detail: { url: serverUrl },
    });

    const cliArtifact = getTeamCliArtifactInfo();
    checks.push({
        key: "team_cli_artifact",
        status: cliArtifact.exists ? "ok" : "action_required",
        message: cliArtifact.exists
            ? "Team CLI artifact is available for provisioning and manual enroll."
            : "Build or mount happy-cli.tgz before provisioning machines.",
        detail: {
            path: cliArtifact.path,
            exists: cliArtifact.exists,
            size: cliArtifact.size ?? null,
        },
    });

    for (const target of NODE_TARGETS) {
        const info = getTeamNodeArtifactInfo(target.platform, target.arch);
        nodeArtifactInfos.set(`${target.platform}_${target.arch}`, info);
        const invalidArtifact = info.exists && info.valid === false;
        checks.push({
            key: `node_artifact_${target.platform}_${target.arch}`,
            status: invalidArtifact ? "action_required" : info.exists ? "ok" : target.required ? "action_required" : "warning",
            message: invalidArtifact
                ? `Node artifact for ${target.platform}/${target.arch} is invalid: ${info.validationError ?? "binary header did not match"}`
                : info.exists
                ? `Node artifact for ${target.platform}/${target.arch} is available.`
                : `Node artifact for ${target.platform}/${target.arch} is missing${target.required ? "." : "; provide it before provisioning this platform."}`,
            detail: {
                platform: info.platform,
                arch: info.arch,
                supported: info.supported,
                exists: info.exists,
                valid: info.valid ?? null,
                format: info.format ?? null,
                detectedPlatform: info.detectedPlatform ?? null,
                detectedArch: info.detectedArch ?? null,
                validationError: info.validationError ?? null,
                source: info.source ?? null,
                path: info.path,
                size: info.size ?? null,
            },
        });
    }

    const cliClaudeSdkInfo = await getTeamCliClaudeSdkInfo();
    for (const target of NODE_TARGETS) {
        const sdkTarget = cliClaudeSdkInfo.targets.find((candidate) => candidate.platform === target.platform && candidate.arch === target.arch);
        const nodeInfo = nodeArtifactInfos.get(`${target.platform}_${target.arch}`);
        const requiredForConfiguredTarget = target.required || Boolean(nodeInfo?.exists);
        const sdkBinaryReady = Boolean(cliClaudeSdkInfo.exists && !cliClaudeSdkInfo.error && sdkTarget?.exists);
        checks.push({
            key: `claude_sdk_binary_${target.platform}_${target.arch}`,
            status: sdkBinaryReady ? "ok" : requiredForConfiguredTarget ? "action_required" : "warning",
            message: sdkBinaryReady
                ? `Claude SDK native binary for ${target.platform}/${target.arch} is included in the CLI artifact.`
                : cliClaudeSdkInfo.error
                ? `Unable to inspect Claude SDK native binary for ${target.platform}/${target.arch}: ${cliClaudeSdkInfo.error}`
                : `Claude SDK native binary for ${target.platform}/${target.arch} is missing from the CLI artifact${requiredForConfiguredTarget ? "." : "; include it before provisioning this platform."}`,
            detail: {
                platform: target.platform,
                arch: target.arch,
                packageName: sdkTarget?.packageName ?? null,
                entry: sdkTarget?.entry ?? null,
                exists: sdkTarget?.exists ?? false,
                cliArtifactPath: cliClaudeSdkInfo.path,
                inspected: cliClaudeSdkInfo.exists && !cliClaudeSdkInfo.error,
                error: cliClaudeSdkInfo.error ?? null,
            },
        });
    }

    checks.push({
        key: "team_anthropic_api_key",
        status: process.env.TEAM_ANTHROPIC_API_KEY ? "ok" : "action_required",
        message: process.env.TEAM_ANTHROPIC_API_KEY
            ? "TEAM_ANTHROPIC_API_KEY is configured for Claude Code Company API mode."
            : "Set TEAM_ANTHROPIC_API_KEY before expecting zero-config Claude Code Company API sessions.",
    });

    checks.push({
        key: "team_openai_api_key",
        status: process.env.TEAM_OPENAI_API_KEY ? "ok" : "action_required",
        message: process.env.TEAM_OPENAI_API_KEY
            ? "TEAM_OPENAI_API_KEY is configured for Codex Company API mode."
            : "Set TEAM_OPENAI_API_KEY before expecting zero-config Codex Company API sessions.",
    });

    return {
        status: summarizeStatus(checks),
        checkedAt: new Date().toISOString(),
        serverUrl,
        checks,
    };
}

function summarizeStatus(checks: PreflightCheck[]): PreflightStatus {
    if (checks.some((check) => check.status === "action_required")) return "action_required";
    if (checks.some((check) => check.status === "warning")) return "warning";
    return "ok";
}

function secretLooksStrong(secret: string | undefined): boolean {
    return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= 32;
}

function isLoopbackUrl(value: string): boolean {
    try {
        const host = new URL(value).hostname.toLowerCase();
        return host === "localhost" || host === "127.0.0.1" || host === "::1";
    } catch {
        return true;
    }
}
