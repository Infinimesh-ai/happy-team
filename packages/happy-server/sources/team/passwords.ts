import { randomBytes, timingSafeEqual } from "crypto";
import { argon2idAsync } from "@noble/hashes/argon2";

const PASSWORD_MIN_LENGTH = 10;
const ARGON2_MEMORY_KIB = 19_456;
const ARGON2_ITERATIONS = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_HASH_LENGTH = 32;

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function assertValidPassword(password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH) {
        throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }
}

function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array {
    return Uint8Array.from(Buffer.from(value, "base64url"));
}

export async function hashPassword(password: string): Promise<string> {
    assertValidPassword(password);
    const salt = randomBytes(16);
    const hash = await argon2idAsync(password, salt, {
        m: ARGON2_MEMORY_KIB,
        t: ARGON2_ITERATIONS,
        p: ARGON2_PARALLELISM,
        dkLen: ARGON2_HASH_LENGTH,
    });
    return [
        "$argon2id",
        "v=19",
        `m=${ARGON2_MEMORY_KIB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}`,
        encodeBase64Url(salt),
        encodeBase64Url(hash),
    ].join("$");
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
    const parts = hash.split("$");
    if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19") {
        return false;
    }

    const params = Object.fromEntries(parts[3].split(",").map((part) => {
        const [key, value] = part.split("=");
        return [key, Number(value)];
    }));
    if (!params.m || !params.t || !params.p) {
        return false;
    }

    const salt = decodeBase64Url(parts[4]);
    const expected = decodeBase64Url(parts[5]);
    const actual = await argon2idAsync(password, salt, {
        m: params.m,
        t: params.t,
        p: params.p,
        dkLen: expected.length,
    });

    return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function generateTemporaryPassword(): string {
    return `Hpy-${randomBytes(12).toString("base64url")}`;
}
