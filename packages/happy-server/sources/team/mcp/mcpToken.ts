/**
 * Stateless personal MCP tokens.
 *
 * A member mints one token (POST /v1/team/mcp/token) and configures it in an
 * external MCP client — e.g. a personal assistant like SparkClaw — which then
 * drives the task API through /v1/team/mcp. Tokens are HMAC-signed over
 * HANDY_MASTER_SECRET (no storage), domain-separated from task tokens, and
 * bound to a digest of the member's current passwordHash: changing the
 * password (or an admin resetting it) revokes every previously issued token.
 * DISABLED members are rejected at resolve time like on every other transport.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { TeamUser, TeamUserStatus } from "@prisma/client";
import { db } from "@/storage/db";

const TOKEN_DOMAIN = "happy-team-mcp-token.v1";
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export const MCP_TOKEN_SCOPE = "tasks";

interface McpTokenPayload {
    uid: string; // TeamUser.id
    scope: string;
    pwd: string; // digest of passwordHash at issue time
    exp: number;
}

function secret(): string {
    const value = process.env.HANDY_MASTER_SECRET;
    if (!value) throw new Error("HANDY_MASTER_SECRET is required to sign MCP tokens");
    return value;
}

function sign(payloadB64: string): string {
    return createHmac("sha256", secret()).update(`${TOKEN_DOMAIN}.${payloadB64}`).digest("base64url");
}

function passwordDigest(passwordHash: string): string {
    return createHash("sha256").update(passwordHash).digest("base64url").slice(0, 16);
}

/** Mint a personal MCP token for a member. */
export function issueMcpToken(teamUser: Pick<TeamUser, "id" | "passwordHash">, ttlMs: number = DEFAULT_TTL_MS): string {
    const payload: McpTokenPayload = {
        uid: teamUser.id,
        scope: MCP_TOKEN_SCOPE,
        pwd: passwordDigest(teamUser.passwordHash),
        exp: Date.now() + ttlMs,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${payloadB64}.${sign(payloadB64)}`;
}

/** Verify signature + expiry + shape; returns the payload or null. Does NOT hit the database. */
export function verifyMcpToken(token: string): McpTokenPayload | null {
    if (typeof token !== "string" || !token.includes(".")) return null;
    const [payloadB64, signature] = token.split(".");
    if (!payloadB64 || !signature) return null;

    const expected = sign(payloadB64);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let payload: McpTokenPayload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    if (typeof payload.uid !== "string" || payload.scope !== MCP_TOKEN_SCOPE || typeof payload.pwd !== "string") {
        return null;
    }
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
}

/**
 * Full resolution for a request: verify the token, load the member, and check
 * that the member is still ACTIVE and the password has not changed since the
 * token was issued. Returns the TeamUser or null.
 */
export async function resolveMcpTeamUser(token: string): Promise<TeamUser | null> {
    const payload = verifyMcpToken(token);
    if (!payload) return null;
    const teamUser = await db.teamUser.findUnique({ where: { id: payload.uid } });
    if (!teamUser || teamUser.status !== TeamUserStatus.ACTIVE) return null;
    if (passwordDigest(teamUser.passwordHash) !== payload.pwd) return null;
    return teamUser;
}
