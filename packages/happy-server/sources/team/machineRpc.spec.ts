/**
 * Machine-RPC payload encryption round-trip tests. This crypto was extracted
 * verbatim from agentAuth in C0.7 and is the transport every real daemon RPC
 * rides on (task prepare/spawn/deliver, intents) — but it had no direct
 * coverage. Both the legacy secretbox variant and the per-machine AES-GCM data
 * key variant must round-trip and must reject tampering.
 */
import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { decodeBase64, decryptRpcPayload, encodeBase64, encryptRpcPayload, type MachineEncryption } from "@/team/machineRpc";

const legacy: MachineEncryption = { key: new Uint8Array(randomBytes(32)), variant: "legacy" };
const dataKey: MachineEncryption = { key: new Uint8Array(randomBytes(32)), variant: "dataKey" };

describe("machine RPC payload encryption", () => {
    it("round-trips a payload under the legacy secretbox variant", () => {
        const payload = { method: "task-prepare-worktree", worktreePath: "/wt", nested: { a: 1, b: [true, "x"] } };
        const bundle = encryptRpcPayload(legacy, payload);
        expect(decryptRpcPayload(legacy, bundle)).toEqual(payload);
    });

    it("round-trips a payload under the per-machine data-key (AES-GCM) variant", () => {
        const payload = { sessionId: "sess-1", env: { HAPPY_TASK_ID: "t1", HAPPY_TASK_TOKEN: "tok" } };
        const bundle = encryptRpcPayload(dataKey, payload);
        expect(decryptRpcPayload(dataKey, bundle)).toEqual(payload);
    });

    it("does not decrypt with the wrong key", () => {
        const bundle = encryptRpcPayload(dataKey, { secret: 42 });
        const wrong: MachineEncryption = { key: new Uint8Array(randomBytes(32)), variant: "dataKey" };
        expect(decryptRpcPayload(wrong, bundle)).toBeNull();
    });

    it("rejects a tampered ciphertext (AES-GCM auth tag)", () => {
        const bundle = encryptRpcPayload(dataKey, { ok: true });
        bundle[bundle.length - 1] ^= 0xff; // flip a bit in the auth tag
        expect(decryptRpcPayload(dataKey, bundle)).toBeNull();
    });

    it("returns null on well-formed-but-invalid input", () => {
        // dataKey rejects a short/garbage bundle; legacy rejects a correctly-sized
        // but unauthenticated one (24-byte nonce + ciphertext that fails the MAC).
        expect(decryptRpcPayload(dataKey, new Uint8Array([1, 2, 3]))).toBeNull();
        expect(decryptRpcPayload(legacy, new Uint8Array(48))).toBeNull();
    });

    it("base64 encode/decode round-trips the wire form", () => {
        const bundle = encryptRpcPayload(legacy, { hello: "world" });
        expect(decodeBase64(encodeBase64(bundle))).toEqual(bundle);
    });
});
