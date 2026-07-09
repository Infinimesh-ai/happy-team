#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const { mkdtemp, mkdir, rm, copyFile, chmod, readFile, stat } = require("fs/promises");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_NODE_VERSION = "20.20.2";
const DEFAULT_TARGETS = ["linux-arm64", "darwin-arm64", "darwin-x64"];
const SUPPORTED_TARGETS = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const version = opts.version || process.env.TEAM_NODE_ARTIFACT_VERSION || DEFAULT_NODE_VERSION;
  const baseUrl = (opts.baseUrl || process.env.NODE_DIST_BASE_URL || "https://nodejs.org/dist").replace(/\/$/, "");
  const outputDir = path.resolve(opts.outputDir || process.env.TEAM_NODE_ARTIFACT_HOST_DIR || ".team-artifacts/node");
  const targets = opts.targets.length > 0 ? opts.targets : DEFAULT_TARGETS;

  for (const target of targets) {
    if (!SUPPORTED_TARGETS.has(target)) {
      throw new Error(`Unsupported target "${target}". Supported targets: ${Array.from(SUPPORTED_TARGETS).join(", ")}`);
    }
  }

  if (opts.dryRun) {
    for (const target of targets) {
      const artifact = artifactFor(version, baseUrl, outputDir, target);
      console.log(`${target}: ${artifact.url} -> ${artifact.destination}`);
    }
    return;
  }

  await mkdir(outputDir, { recursive: true });
  const workspace = await mkdtemp(path.join(os.tmpdir(), "happy-team-node-artifacts-"));
  try {
    const sumsPath = path.join(workspace, `SHASUMS256-v${version}.txt`);
    await downloadFile(`${baseUrl}/v${version}/SHASUMS256.txt`, sumsPath);
    const sums = await readShasums(sumsPath);

    for (const target of targets) {
      const artifact = artifactFor(version, baseUrl, outputDir, target);
      const expectedHash = sums.get(artifact.filename);
      if (!expectedHash) {
        throw new Error(`No SHA256 entry for ${artifact.filename} in Node v${version} SHASUMS256.txt`);
      }

      const tarPath = path.join(workspace, artifact.filename);
      await downloadFile(artifact.url, tarPath);
      await verifySha256(tarPath, expectedHash);
      await extractNodeBinary(tarPath, artifact.packageDir, artifact.destination, workspace);
      const info = await stat(artifact.destination);
      console.log(`${target}: wrote ${artifact.destination} (${info.size} bytes, sha256 verified)`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const opts = {
    version: undefined,
    outputDir: undefined,
    baseUrl: undefined,
    targets: [],
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--version") {
      opts.version = readValue(args, ++i, arg);
    } else if (arg.startsWith("--version=")) {
      opts.version = arg.slice("--version=".length);
    } else if (arg === "--output-dir") {
      opts.outputDir = readValue(args, ++i, arg);
    } else if (arg.startsWith("--output-dir=")) {
      opts.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--base-url") {
      opts.baseUrl = readValue(args, ++i, arg);
    } else if (arg.startsWith("--base-url=")) {
      opts.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--target") {
      opts.targets.push(readValue(args, ++i, arg));
    } else if (arg.startsWith("--target=")) {
      opts.targets.push(arg.slice("--target=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function artifactFor(version, baseUrl, outputDir, target) {
  const [platform, arch] = target.split("-");
  const packageDir = `node-v${version}-${platform}-${arch}`;
  const filename = `${packageDir}.tar.gz`;
  return {
    filename,
    packageDir,
    url: `${baseUrl}/v${version}/${filename}`,
    destination: path.join(outputDir, target, "node"),
  };
}

async function readShasums(filePath) {
  const text = await readFile(filePath, "utf8");
  const sums = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match) {
      sums.set(match[2], match[1]);
    }
  }
  return sums;
}

async function verifySha256(filePath, expectedHash) {
  const data = await readFile(filePath);
  const actualHash = crypto.createHash("sha256").update(data).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`SHA256 mismatch for ${path.basename(filePath)}: expected ${expectedHash}, got ${actualHash}`);
  }
}

async function extractNodeBinary(tarPath, packageDir, destination, workspace) {
  const extractDir = path.join(workspace, "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarPath, "-C", extractDir, `${packageDir}/bin/node`], { stdio: "inherit" });
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(extractDir, packageDir, "bin", "node"), destination);
  await chmod(destination, 0o755);
}

async function downloadFile(url, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(new URL(response.headers.location, url).toString(), destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed for ${url}: HTTP ${response.statusCode}`));
        return;
      }

      const output = fs.createWriteStream(destination, { mode: 0o600 });
      response.pipe(output);
      output.on("finish", () => output.close(resolve));
      output.on("error", reject);
    });
    request.on("error", reject);
  });
}

function printHelp() {
  console.log(`Usage: node scripts/team-node-artifacts.cjs [options]

Downloads official Node.js runtime tarballs, verifies SHASUMS256.txt, and writes
the Team provisioning artifact layout expected by TEAM_NODE_ARTIFACT_HOST_DIR.

Options:
  --version <version>       Node version without leading "v" (default: ${DEFAULT_NODE_VERSION})
  --target <platform-arch>  Repeatable. Supported: ${Array.from(SUPPORTED_TARGETS).join(", ")}
                            Defaults: ${DEFAULT_TARGETS.join(", ")}
  --output-dir <dir>        Destination root (default: .team-artifacts/node)
  --base-url <url>          Node dist base URL (default: https://nodejs.org/dist)
  --dry-run                 Print URLs and destinations without downloading
  --help                    Show this help
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
