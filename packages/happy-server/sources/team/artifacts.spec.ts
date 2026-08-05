import { spawnSync } from "child_process";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { gzipSync } from "zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeSdkCliWrapperCommand, buildCodexCliWrapperCommand, buildManualInstallCommand, getTeamCliClaudeSdkInfo, getTeamCliCodexInfo, getTeamNodeArtifactInfo, shellQuote, validateNodeArtifactBinary } from "@/team/artifacts";

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

    it("resolves configured Linux musl Node artifacts without server-runtime fallback", async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), "happy-team-musl-node-artifacts-"));
        tempDirs.push(artifactDir);
        process.env.TEAM_NODE_ARTIFACT_DIR = artifactDir;

        const nodePath = path.join(artifactDir, "linux-x64-musl", "node");
        await mkdir(path.dirname(nodePath), { recursive: true });
        await writeFile(nodePath, elfHeader(0x3e));

        const info = getTeamNodeArtifactInfo("linux", "x86_64", "musl");
        expect(info).toMatchObject({
            platform: "linux",
            arch: "x64",
            libc: "musl",
            path: nodePath,
            exists: true,
            supported: true,
            source: "configured",
            valid: true,
            format: "elf",
            detectedPlatform: "linux",
            detectedArch: "x64",
        });

        await rm(path.dirname(nodePath), { recursive: true, force: true });
        const missingMusl = getTeamNodeArtifactInfo("linux", "x86_64", "musl");
        expect(missingMusl).toMatchObject({
            platform: "linux",
            arch: "x64",
            libc: "musl",
            path: nodePath,
            exists: false,
            supported: true,
        });
        expect(missingMusl.source).toBeUndefined();
        expect(missingMusl.path).not.toBe(process.execPath);
    });

    it("rejects Linux musl Node artifacts with external shared-library dependencies", async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), "happy-team-musl-node-deps-"));
        tempDirs.push(artifactDir);
        process.env.TEAM_NODE_ARTIFACT_DIR = artifactDir;

        const nodePath = path.join(artifactDir, "linux-x64-musl", "node");
        await mkdir(path.dirname(nodePath), { recursive: true });
        await writeFile(nodePath, elfWithNeededLibraries(0x3e, [
            "libstdc++.so.6",
            "libgcc_s.so.1",
            "libc.musl-x86_64.so.1",
        ]));

        const info = getTeamNodeArtifactInfo("linux", "x64", "musl");
        expect(info).toMatchObject({
            platform: "linux",
            arch: "x64",
            libc: "musl",
            exists: true,
            supported: true,
            valid: false,
            format: "elf",
            detectedPlatform: "linux",
            detectedArch: "x64",
            neededLibraries: [
                "libstdc++.so.6",
                "libgcc_s.so.1",
                "libc.musl-x86_64.so.1",
            ],
            validationError: "Musl Node artifact has external shared-library dependencies: libstdc++.so.6, libgcc_s.so.1",
        });
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
        const syntax = spawnSync("sh", ["-n"], {
            input: `set -eu\n${command}\n`,
            encoding: "utf8",
        });

        expect(syntax.status).toBe(0);
        expect(syntax.stderr).toBe("");
        expect(command).toContain("uname -s");
        expect(command).toContain("uname -m");
        expect(command).toContain("/v1/team/artifacts/node/$platform/$arch");
        expect(command).toContain("ldd /bin/sh");
        expect(command).toContain("node_url=\"$node_url?libc=musl\"");
        expect(command).toContain("PATH=\"$HOME/.happy-team/bin:$PATH\"; export PATH");
        expect(command).toContain("cat > \"$HOME/.happy-team/bin/claude\"");
        expect(command).toContain("@anthropic-ai/claude-agent-sdk-darwin-arm64");
        expect(command).toContain("cat > \"$HOME/.happy-team/bin/codex\"");
        expect(command).toContain("@openai/codex/bin/codex.js");
        expect(command).toContain("enroll --server");
        expect(command).not.toContain("TEAM_ANTHROPIC_API_KEY");
        expect(command).not.toContain("TEAM_OPENAI_API_KEY");
        // Re-running the manual command against a live daemon must not write
        // busy binaries in place: node goes through a temp download + rename,
        // the CLI tree through an extract-then-swap.
        expect(command).toContain("mv -f \"$HOME/.happy-team/bin/node.download\" \"$HOME/.happy-team/bin/node\"");
        expect(command).toContain("tar -xzf /tmp/happy-cli.tgz -C \"$HOME/.happy-team/cli.tmp\"");
        expect(command).toContain("mv \"$HOME/.happy-team/cli.tmp\" \"$HOME/.happy-team/cli\"");
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
        expect(info.targets.find((target) => target.platform === "linux" && target.arch === "x64" && target.libc === "glibc")?.exists).toBe(true);
        expect(info.targets.find((target) => target.platform === "linux" && target.arch === "x64" && target.libc === "musl")?.exists).toBe(false);
        expect(info.targets.find((target) => target.platform === "linux" && target.arch === "arm64" && target.libc === "glibc")?.exists).toBe(false);
        expect(info.targets.find((target) => target.platform === "darwin" && target.arch === "arm64")?.exists).toBe(true);
    });

    it("inspects CLI artifacts for Codex native binaries", async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), "happy-team-codex-artifact-"));
        tempDirs.push(artifactDir);
        const artifactPath = path.join(artifactDir, "happy-cli.tgz");
        process.env.TEAM_CLI_ARTIFACT_PATH = artifactPath;
        await writeFile(artifactPath, tarGzip([
            "./node_modules/@openai/codex/bin/codex.js",
            "./node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex",
            "./node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex",
        ]));

        const info = await getTeamCliCodexInfo();
        expect(info.exists).toBe(true);
        expect(info.launcherExists).toBe(true);
        expect(info.complete).toBe(false);
        expect(info.targets.find((target) => target.platform === "linux" && target.arch === "x64")?.exists).toBe(true);
        expect(info.targets.find((target) => target.platform === "linux" && target.arch === "arm64")?.exists).toBe(false);
        expect(info.targets.find((target) => target.platform === "darwin" && target.arch === "arm64")?.exists).toBe(true);
    });

    it("creates a claude wrapper that executes the packaged SDK binary", async () => {
        const home = await mkdtemp(path.join(tmpdir(), "happy-team-claude-wrapper-"));
        tempDirs.push(home);
        await mkdir(path.join(home, ".happy-team", "bin"), { recursive: true });
        await writeFakeClaudeSdkBinary(home, "@anthropic-ai/claude-agent-sdk-linux-x64");
        await writeFakeClaudeSdkBinary(home, "@anthropic-ai/claude-agent-sdk-linux-x64-musl");

        const result = spawnSync("sh", ["-c", `set -eu\n${buildClaudeSdkCliWrapperCommand()}\n"$HOME/.happy-team/bin/claude" --version`], {
            env: {
                ...process.env,
                HOME: home,
            },
            encoding: "utf8",
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout.trim()).toBe("fake-claude:--version");
    });

    it("creates a codex wrapper that executes the packaged CLI launcher", async () => {
        const home = await mkdtemp(path.join(tmpdir(), "happy-team-codex-wrapper-"));
        tempDirs.push(home);
        await mkdir(path.join(home, ".happy-team", "bin"), { recursive: true });
        await writeFakeCodexLauncher(home);

        const result = spawnSync("sh", ["-c", `set -eu\n${buildCodexCliWrapperCommand(shellQuote(process.execPath))}\n"$HOME/.happy-team/bin/codex" --version`], {
            env: {
                ...process.env,
                HOME: home,
            },
            encoding: "utf8",
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout.trim()).toBe("fake-codex:--version");
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

function elfWithNeededLibraries(machine: number, libraries: string[]): Buffer {
    const headerSize = 64;
    const programHeaderSize = 56;
    const programHeaderCount = 2;
    const dynamicOffset = headerSize + programHeaderSize * programHeaderCount;
    const stringTableOffset = dynamicOffset + (libraries.length + 3) * 16;
    const baseVaddr = 0x400000;
    const stringOffsets: number[] = [];
    const stringTableParts = [Buffer.from([0])];
    for (const library of libraries) {
        stringOffsets.push(Buffer.concat(stringTableParts).length);
        stringTableParts.push(Buffer.from(`${library}\0`, "utf8"));
    }
    const stringTable = Buffer.concat(stringTableParts);
    const totalSize = stringTableOffset + stringTable.length;
    const elf = Buffer.alloc(totalSize);
    elfHeader(machine).copy(elf, 0);
    elf.writeBigUInt64LE(BigInt(headerSize), 32);
    elf.writeUInt16LE(headerSize, 52);
    elf.writeUInt16LE(programHeaderSize, 54);
    elf.writeUInt16LE(programHeaderCount, 56);

    writeProgramHeader(elf, headerSize, {
        type: 1,
        offset: 0,
        vaddr: baseVaddr,
        filesz: totalSize,
        memsz: totalSize,
    });
    writeProgramHeader(elf, headerSize + programHeaderSize, {
        type: 2,
        offset: dynamicOffset,
        vaddr: baseVaddr + dynamicOffset,
        filesz: (libraries.length + 3) * 16,
        memsz: (libraries.length + 3) * 16,
    });

    let dynamicCursor = dynamicOffset;
    for (const stringOffset of stringOffsets) {
        writeDynamicEntry(elf, dynamicCursor, 1, stringOffset);
        dynamicCursor += 16;
    }
    writeDynamicEntry(elf, dynamicCursor, 5, baseVaddr + stringTableOffset);
    dynamicCursor += 16;
    writeDynamicEntry(elf, dynamicCursor, 10, stringTable.length);
    stringTable.copy(elf, stringTableOffset);
    return elf;
}

function writeProgramHeader(buffer: Buffer, offset: number, input: { type: number; offset: number; vaddr: number; filesz: number; memsz: number }) {
    buffer.writeUInt32LE(input.type, offset);
    buffer.writeUInt32LE(5, offset + 4);
    buffer.writeBigUInt64LE(BigInt(input.offset), offset + 8);
    buffer.writeBigUInt64LE(BigInt(input.vaddr), offset + 16);
    buffer.writeBigUInt64LE(BigInt(input.vaddr), offset + 24);
    buffer.writeBigUInt64LE(BigInt(input.filesz), offset + 32);
    buffer.writeBigUInt64LE(BigInt(input.memsz), offset + 40);
    buffer.writeBigUInt64LE(BigInt(0x1000), offset + 48);
}

function writeDynamicEntry(buffer: Buffer, offset: number, tag: number, value: number) {
    buffer.writeBigUInt64LE(BigInt(tag), offset);
    buffer.writeBigUInt64LE(BigInt(value), offset + 8);
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

async function writeFakeClaudeSdkBinary(home: string, packageName: string): Promise<void> {
    const binaryPath = path.join(home, ".happy-team", "cli", "node_modules", packageName, "claude");
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, "#!/bin/sh\nprintf 'fake-claude:%s\\n' \"$*\"\n", { mode: 0o700 });
}

async function writeFakeCodexLauncher(home: string): Promise<void> {
    const launcherPath = path.join(home, ".happy-team", "cli", "node_modules", "@openai", "codex", "bin", "codex.js");
    await mkdir(path.dirname(launcherPath), { recursive: true });
    await writeFile(launcherPath, "console.log(`fake-codex:${process.argv.slice(2).join(' ')}`);\n", { mode: 0o700 });
}
