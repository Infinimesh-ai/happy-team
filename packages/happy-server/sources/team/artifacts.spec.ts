import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManualInstallCommand, getTeamNodeArtifactInfo } from "@/team/artifacts";

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
        await writeFile(nodePath, "node-binary");

        const info = getTeamNodeArtifactInfo("linux", "aarch64");
        expect(info).toMatchObject({
            platform: "linux",
            arch: "arm64",
            path: nodePath,
            exists: true,
            supported: true,
            source: "configured",
        });
        expect(info.size).toBeGreaterThan(0);
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
