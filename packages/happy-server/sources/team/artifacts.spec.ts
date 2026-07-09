import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { gzipSync } from "zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildManualInstallCommand, getTeamCliClaudeSdkInfo, getTeamNodeArtifactInfo, validateNodeArtifactBinary } from "@/team/artifacts";

const originalCliArtifactPath = process.env.TEAM_CLI_ARTIFACT_PATH;
const originalNodeArtifactDir = process.env.TEAM_NODE_ARTIFACT_DIR;
let tempDirs: string[] = [];

describe("team artifacts", () => {
    afterEach(async () => {
        if (originalNodeArtifactDir === undefined) {
            delete process.env.TEAM_NODE_ARTIFACT_DIR;
        } else {
            process.env.TEAM_NODE_ARTIFACT_DIR = originalNodeArtifactDir;
        }
        if (originalCliArtifactPath === undefined) {
            delete process.env.TEAM_CLI_ARTIFACT_PATH;
        } else {
            process.env.TEAM_CLI_ARTIFACT_PATH = originalCliArtifactPath;
        }
        await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        tempDirs = [];
    });

    it("resolves configured Linux arm64 Node artifacts", async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), "happy-team-node-artifacts-"));
        tempDirs.push(artifactDir);
        process.env.TEAM_NODE_ARTIFACT_DIR = artifactDir;

        const nodePath = path.join(artifactDir, "linux-arm64", "node");
        await mkdir(path.dirname(nodePath), { recursive: true });
        await writeFile(nodePath, elfHeader(0xb7));

        const info = getTeamNodeArtifactInfo("linux", "aarch64");
        expect(info).toMatchObject({
            platform: "linux",
            arch: "arm64",
            path: nodePath,
            exists: true,
            supported: true,
            source: "configured",
            valid: true,
            format: "elf",
            detectedPlatform: "linux",
            detectedArch: "arm64",
        });
        expect(info.size).toBeGreaterThan(0);
    });

    it("detects configured Node artifacts that do not match the requested platform", async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), "happy-team-wrong-node-artifacts-"));
        tempDirs.push(artifactDir);
        process.env.TEAM_NODE_ARTIFACT_DIR = artifactDir;

        const nodePath = path.join(artifactDir, "darwin-arm64", "node");
        await mkdir(path.dirname(nodePath), { recursive: true });
        await writeFile(nodePath, elfHeader(0xb7));

        const info = getTeamNodeArtifactInfo("darwin", "arm64");
        expect(info).toMatchObject({
            platform: "darwin",
            arch: "arm64",
            exists: true,
            supported: true,
            valid: false,
            format: "elf",
            detectedPlatform: "linux",
            detectedArch: "arm64",
            validationError: "Expected darwin/arm64, got linux/arm64",
        });
    });

    it("validates Mach-O arm64 artifacts", async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), "happy-team-macho-node-artifacts-"));
        tempDirs.push(artifactDir);
        const nodePath = path.join(artifactDir, "node");
        await writeFile(nodePath, machoHeader(0x0100000c));

        expect(validateNodeArtifactBinary(nodePath, "darwin", "arm64")).toMatchObject({
            valid: true,
            format: "macho",
            detectedPlatform: "darwin",
            detectedArch: "arm64",
        });
        expect(validateNodeArtifactBinary(nodePath, "darwin", "x64")).toMatchObject({
            valid: false,
            format: "macho",
            detectedPlatform: "darwin",
            detectedArch: "arm64",
            error: "Expected darwin/x64, got darwin/arm64",
        });
    });

    it("falls back to the server runtime for the current Node platform", async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), "happy-team-empty-node-artifacts-"));
        tempDirs.push(artifactDir);
        process.env.TEAM_NODE_ARTIFACT_DIR = artifactDir;

        const info = getTeamNodeArtifactInfo(process.platform, process.arch);
        expect(info.exists).toBe(true);
        expect(info.supported).toBe(true);
        expect(info.source).toBe("server-runtime");
        expect(info.path).toBe(process.execPath);
    });

    it("builds manual install commands with target platform detection", () => {
        const command = buildManualInstallCommand({
            serverUrl: "https://happy.example.com",
            token: "hte_test_token",
            agents: ["claude", "codex"],
        });
        expect(command).toContain("uname -s");
        expect(command).toContain("uname -m");
        expect(command).toContain("/v1/team/artifacts/node/$platform/$arch");
        expect(command).toContain("PATH=\"$HOME/.happy-team/bin:$PATH\"; export PATH");
        expect(command).toContain("enroll --server");
        expect(command).not.toContain("TEAM_ANTHROPIC_API_KEY");
        expect(command).not.toContain("TEAM_OPENAI_API_KEY");
    });

    it("inspects CLI artifacts for Claude SDK native binaries", async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), "happy-team-cli-artifact-"));
        tempDirs.push(artifactDir);
        const artifactPath = path.join(artifactDir, "happy-cli.tgz");
        process.env.TEAM_CLI_ARTIFACT_PATH = artifactPath;
        await writeFile(artifactPath, tarGzip([
            "./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
            "./node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
        ]));

        const info = await getTeamCliClaudeSdkInfo();
        expect(info.exists).toBe(true);
        expect(info.complete).toBe(false);
        expect(info.targets.find((target) => target.platform === "linux" && target.arch === "x64")?.exists).toBe(true);
        expect(info.targets.find((target) => target.platform === "linux" && target.arch === "arm64")?.exists).toBe(false);
        expect(info.targets.find((target) => target.platform === "darwin" && target.arch === "arm64")?.exists).toBe(true);
    });
});

function elfHeader(machine: number): Buffer {
    const header = Buffer.alloc(64);
    header[0] = 0x7f;
    header[1] = 0x45;
    header[2] = 0x4c;
    header[3] = 0x46;
    header[4] = 2;
    header[5] = 1;
    header.writeUInt16LE(machine, 18);
    return header;
}

function machoHeader(cpuType: number): Buffer {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeInt32LE(cpuType, 4);
    return header;
}

function tarGzip(entries: string[]): Buffer {
    return gzipSync(Buffer.concat([
        ...entries.map((entry) => tarHeader(entry)),
        Buffer.alloc(1024),
    ]));
}

function tarHeader(name: string): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write("00000000000\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(" ", 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    return header;
}
