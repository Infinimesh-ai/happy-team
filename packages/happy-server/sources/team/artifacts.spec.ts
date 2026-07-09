import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManualInstallCommand, getTeamNodeArtifactInfo, validateNodeArtifactBinary } from "@/team/artifacts";

const originalNodeArtifactDir = process.env.TEAM_NODE_ARTIFACT_DIR;
let tempDirs: string[] = [];

describe("team artifacts", () => {
    afterEach(async () => {
        if (originalNodeArtifactDir === undefined) {
            delete process.env.TEAM_NODE_ARTIFACT_DIR;
        } else {
            process.env.TEAM_NODE_ARTIFACT_DIR = originalNodeArtifactDir;
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
