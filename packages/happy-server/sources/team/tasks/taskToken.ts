/**
 * Stateless task-control tokens (plan §7, milestone C1.1).
 *
 * Each stage session is handed a short-lived token identifying its task, stage
 * and round. Tokens are HMAC-signed over HANDY_MASTER_SECRET (no storage). A
 * token is "revoked" the moment the task advances: the intent endpoint checks
 * the decoded {stage, round} against the task's current {stage, round}, so a
 * token minted for a finished stage no longer matches and is rejected — plus a
 * short expiry as a secondary bound.
 */
import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_DOMAIN = "happy-task-token.v1";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h — comfortably covers a stage

export interface TaskTokenClaims {
    taskId: string;
    stage: string;
    round: number;
}

interface TaskTokenPayload extends TaskTokenClaims {
    exp: number;
}

function secret(): string {
    const value = process.env.HANDY_MASTER_SECRET;
    if (!value) throw new Error("HANDY_MASTER_SECRET is required to sign task tokens");
    return value;
}

function base64url(input: Buffer | string): string {
    return Buffer.from(input).toString("base64url");
}

function sign(payloadB64: string): string {
    return createHmac("sha256", secret()).update(`${TOKEN_DOMAIN}.${payloadB64}`).digest("base64url");
}

/** Mint a token for a task's current stage/round. */
export function issueTaskToken(claims: TaskTokenClaims, ttlMs: number = DEFAULT_TTL_MS): string {
    const payload: TaskTokenPayload = { ...claims, exp: Date.now() + ttlMs };
    const payloadB64 = base64url(JSON.stringify(payload));
    return `${payloadB64}.${sign(payloadB64)}`;
}

/** Verify signature + expiry; returns claims or null. Does NOT check task state. */
export function verifyTaskToken(token: string): TaskTokenClaims | null {
    if (typeof token !== "string" || !token.includes(".")) return null;
    const [payloadB64, signature] = token.split(".");
    if (!payloadB64 || !signature) return null;

    const expected = sign(payloadB64);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let payload: TaskTokenPayload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    if (typeof payload.taskId !== "string" || typeof payload.stage !== "string" || typeof payload.round !== "number") {
        return null;
    }
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return { taskId: payload.taskId, stage: payload.stage, round: payload.round };
}
