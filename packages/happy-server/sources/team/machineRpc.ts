/**
 * Encrypted machine RPC transport (extracted from team/agentAuth so both agent
 * auth and the cloud-agent task daemon gateway share one implementation — the
 * plan's "reuse the auth/encryption手法"). Payloads are encrypted with the
 * machine's managed key (legacy secretbox or per-machine AES-GCM data key) and
 * routed to the daemon via the registered-RPC room mechanism.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "crypto";
import { type Machine, type TeamUser } from "@prisma/client";
import nacl from "tweetnacl";
import { type Server } from "socket.io";
import { callRegisteredRpcMethod } from "@/app/api/socket/rpcHandler";
import { decryptManagedSecretKey } from "@/team/escrow";

export interface MachineEncryption {
    key: Uint8Array;
    variant: "legacy" | "dataKey";
}

export type MachineRpcResult =
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; error: string };

/**
 * Encrypt `payload` for `machine`, invoke `<machineId>:<baseMethod>` on the
 * member's daemon, and decrypt the response. Errors (transport, unreadable
 * payload, or a daemon-reported `{ error }`) come back as `{ ok: false }`.
 */
export async function callMachineRpc(
    io: Server,
    teamUser: TeamUser,
    machine: Machine,
    baseMethod: string,
    payload: unknown,
): Promise<MachineRpcResult> {
    const encryption = resolveMachineEncryption(teamUser, machine);
    const method = `${machine.id}:${baseMethod}`;
    const encryptedParams = encodeBase64(encryptRpcPayload(encryption, payload));
    const rpc = await callRegisteredRpcMethod(io, teamUser.accountId, method, encryptedParams);
    if (!rpc.ok) {
        return { ok: false, error: rpc.error ?? "RPC call failed" };
    }
    if (typeof rpc.result !== "string") {
        return { ok: false, error: "Invalid RPC response" };
    }
    const response = decryptRpcPayload(encryption, decodeBase64(rpc.result));
    if (!response || typeof response !== "object") {
        return { ok: false, error: "Unreadable RPC response" };
    }
    if (typeof (response as { error?: unknown }).error === "string") {
        return { ok: false, error: (response as { error: string }).error };
    }
    return { ok: true, result: response as Record<string, unknown> };
}

export function resolveMachineEncryption(teamUser: TeamUser, machine: Machine): MachineEncryption {
    const secret = decryptManagedSecretKey(teamUser.accountId, machineSafeBytes(teamUser.encSecretKey));
    if (!machine.dataEncryptionKey) {
        return { key: secret, variant: "legacy" };
    }

    const dataKey = decryptDataEncryptionKey(machineSafeBytes(machine.dataEncryptionKey), secret);
    if (!dataKey) {
        throw new Error("Unable to decrypt machine data key");
    }
    return { key: dataKey, variant: "dataKey" };
}

function machineSafeBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    return out;
}

function decryptDataEncryptionKey(bundle: Uint8Array, managedSecret: Uint8Array): Uint8Array | null {
    if (bundle[0] !== 0) {
        return null;
    }
    const keyPair = deriveContentBoxKeyPair(managedSecret);
    return decryptBox(bundle.slice(1), keyPair.secretKey);
}

function deriveContentBoxKeyPair(secret: Uint8Array): nacl.BoxKeyPair {
    const seed = deriveKey(secret, "Happy EnCoder", ["content"]);
    const hashedSeed = new Uint8Array(createHash("sha512").update(seed).digest());
    return nacl.box.keyPair.fromSecretKey(hashedSeed.slice(0, 32));
}

function deriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    const root = hmacSha512(new TextEncoder().encode(`${usage} Master Seed`), master);
    let state = {
        key: root.slice(0, 32),
        chainCode: root.slice(32),
    };

    for (const index of path) {
        const data = new Uint8Array([0x00, ...new TextEncoder().encode(index)]);
        const derived = hmacSha512(state.chainCode, data);
        state = {
            key: derived.slice(0, 32),
            chainCode: derived.slice(32),
        };
    }

    return state.key;
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    const hmac = createHmac("sha512", key);
    hmac.update(data);
    return new Uint8Array(hmac.digest());
}

function decryptBox(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    const ephemeralPublicKey = encryptedBundle.slice(0, nacl.box.publicKeyLength);
    const nonce = encryptedBundle.slice(nacl.box.publicKeyLength, nacl.box.publicKeyLength + nacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(nacl.box.publicKeyLength + nacl.box.nonceLength);
    const decrypted = nacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    return decrypted ? new Uint8Array(decrypted) : null;
}

export function encryptRpcPayload(encryption: MachineEncryption, data: unknown): Uint8Array {
    if (encryption.variant === "legacy") {
        return encryptLegacy(data, encryption.key);
    }
    return encryptWithDataKey(data, encryption.key);
}

export function decryptRpcPayload(encryption: MachineEncryption, bundle: Uint8Array): any | null {
    if (encryption.variant === "legacy") {
        return decryptLegacy(bundle, encryption.key);
    }
    return decryptWithDataKey(bundle, encryption.key);
}

function encryptLegacy(data: unknown, secret: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(randomBytes(nacl.secretbox.nonceLength));
    const encrypted = nacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

function decryptLegacy(data: Uint8Array, secret: Uint8Array): any | null {
    const nonce = data.slice(0, nacl.secretbox.nonceLength);
    const encrypted = data.slice(nacl.secretbox.nonceLength);
    const decrypted = nacl.secretbox.open(encrypted, nonce, secret);
    if (!decrypted) {
        return null;
    }
    return JSON.parse(new TextDecoder().decode(decrypted));
}

function encryptWithDataKey(data: unknown, dataKey: Uint8Array): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
    const encrypted = Buffer.concat([
        cipher.update(new TextEncoder().encode(JSON.stringify(data))),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const bundle = new Uint8Array(1 + nonce.length + encrypted.length + authTag.length);
    bundle.set([0], 0);
    bundle.set(nonce, 1);
    bundle.set(encrypted, 13);
    bundle.set(authTag, 13 + encrypted.length);
    return bundle;
}

function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): any | null {
    if (bundle[0] !== 0 || bundle.length < 29) {
        return null;
    }
    const nonce = bundle.slice(1, 13);
    const ciphertext = bundle.slice(13, bundle.length - 16);
    const authTag = bundle.slice(bundle.length - 16);
    try {
        const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

export function encodeBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

export function decodeBase64(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, "base64"));
}
