import { execFile, execFileSync } from "child_process";
import net from "net";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SshExecutor } from "@/team/provision/ssh";

const execFileAsync = promisify(execFile);
const SSHD_IMAGE = "lscr.io/linuxserver/openssh-server:latest";
const SSH_USER = "happy";
const SSH_PASSWORD = "happy-password";

type DockerCommand = {
    command: string;
    prefixArgs: string[];
};

const docker = resolveDockerCommand();
const describeWithDocker = docker ? describe : describe.skip;

describeWithDocker("SSH provision executor", () => {
    let containerName = "";
    let hostPort = 0;

    beforeAll(async () => {
        hostPort = await allocatePort();
        containerName = `happy-sshd-${process.pid}-${Date.now()}`;
        await dockerExec([
            "run",
            "-d",
            "--rm",
            "--name",
            containerName,
            "-p",
            `127.0.0.1:${hostPort}:2222`,
            "-e",
            `USER_NAME=${SSH_USER}`,
            "-e",
            `USER_PASSWORD=${SSH_PASSWORD}`,
            "-e",
            "PASSWORD_ACCESS=true",
            "-e",
            "SUDO_ACCESS=false",
            SSHD_IMAGE,
        ], 120_000);
        await waitForSsh(hostPort);
    }, 150_000);

    afterAll(async () => {
        if (containerName) {
            await dockerExec(["rm", "-f", containerName], 30_000).catch(() => {});
        }
    });

    it("executes commands over a real sshd container", async () => {
        const executor = new SshExecutor();
        await executor.connect({
            host: "127.0.0.1",
            port: hostPort,
            username: SSH_USER,
            password: SSH_PASSWORD,
            readyTimeout: 20_000,
        });
        const result = await executor.exec("printf 'hello-team' && id -un", 20_000);
        executor.close();

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("hello-team");
        expect(result.stdout).toContain(SSH_USER);
        expect(result.stderr).toBe("");
    }, 30_000);
});

function resolveDockerCommand(): DockerCommand | null {
    try {
        execFileSync("docker", ["ps"], { stdio: "ignore" });
        return { command: "docker", prefixArgs: [] };
    } catch {}

    try {
        execFileSync("sudo", ["-n", "docker", "ps"], { stdio: "ignore" });
        return { command: "sudo", prefixArgs: ["-n", "docker"] };
    } catch {}

    return null;
}

async function dockerExec(args: string[], timeout: number): Promise<void> {
    if (!docker) throw new Error("Docker is not available");
    await execFileAsync(docker.command, [...docker.prefixArgs, ...args], { timeout });
}

async function allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => {
                if (typeof address === "object" && address) {
                    resolve(address.port);
                } else {
                    reject(new Error("Could not allocate local port"));
                }
            });
        });
    });
}

async function waitForSsh(port: number): Promise<void> {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
        const executor = new SshExecutor();
        try {
            await executor.connect({
                host: "127.0.0.1",
                port,
                username: SSH_USER,
                password: SSH_PASSWORD,
                readyTimeout: 5_000,
            });
            executor.close();
            return;
        } catch (error) {
            lastError = error;
            executor.close();
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Timed out waiting for sshd");
}
