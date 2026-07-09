import { Client, type ConnectConfig } from "ssh2";
import { type SshCredential } from "@prisma/client";
import { decryptSshCredentialAuth } from "@/team/sshCredentials";

export type SshExecResult = {
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
};

export type SshConnectionInput = {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    readyTimeout?: number;
};

export function buildSshConnectionInput(credential: SshCredential): SshConnectionInput {
    const auth = decryptSshCredentialAuth(credential);
    return {
        host: credential.host,
        port: credential.port,
        username: credential.username,
        readyTimeout: 20_000,
        ...(auth.type === "PASSWORD"
            ? { password: auth.password }
            : { privateKey: auth.privateKey, passphrase: auth.passphrase }),
    };
}

export class SshExecutor {
    private client = new Client();
    private connected = false;

    constructor() {
        // ssh2 may emit a late error after a failed handshake has already been
        // rejected and cleaned up. Keep a baseline listener so that late socket
        // errors do not escape as process-level unhandled exceptions.
        this.client.on("error", () => {});
    }

    async connect(input: SshConnectionInput): Promise<void> {
        if (this.connected) return;
        await new Promise<void>((resolve, reject) => {
            const onReady = () => {
                cleanup();
                this.connected = true;
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            const cleanup = () => {
                this.client.off("ready", onReady);
                this.client.off("error", onError);
            };
            const config: ConnectConfig = {
                host: input.host,
                port: input.port,
                username: input.username,
                password: input.password,
                privateKey: input.privateKey,
                passphrase: input.passphrase,
                readyTimeout: input.readyTimeout ?? 20_000,
            };
            this.client.once("ready", onReady);
            this.client.once("error", onError);
            this.client.connect(config);
        });
    }

    async exec(command: string, timeoutMs = 60_000): Promise<SshExecResult> {
        if (!this.connected) {
            throw new Error("SSH client is not connected");
        }

        return new Promise<SshExecResult>((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.client.exec(command, (error, stream) => {
                if (error) {
                    clearTimeout(timeout);
                    settled = true;
                    reject(error);
                    return;
                }

                stream.on("close", (code: number | null, signal: string | null) => {
                    if (settled) return;
                    clearTimeout(timeout);
                    settled = true;
                    resolve({ code, signal, stdout, stderr });
                });
                stream.on("data", (chunk: Buffer) => {
                    stdout += chunk.toString("utf8");
                });
                stream.stderr.on("data", (chunk: Buffer) => {
                    stderr += chunk.toString("utf8");
                });
            });
        });
    }

    close(): void {
        this.client.end();
        this.connected = false;
    }
}
