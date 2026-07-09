import { createHash } from "crypto";
import { Redis } from "ioredis";
import { log } from "@/utils/log";

const WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 10;

let redisClient: Redis | null = null;
const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function getRedis(): Redis | null {
    if (!process.env.REDIS_URL) {
        return null;
    }
    if (!redisClient) {
        redisClient = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 1,
            lazyConnect: true,
        });
    }
    return redisClient;
}

function keyFor(ip: string, email: string): string {
    const digest = createHash("sha256").update(`${ip}:${email}`).digest("hex");
    return `team:login-rate:${digest}`;
}

function checkMemoryLimit(key: string): { ok: boolean; retryAfterSeconds?: number } {
    const now = Date.now();
    const existing = memoryBuckets.get(key);
    if (!existing || existing.resetAt <= now) {
        memoryBuckets.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
        return { ok: true };
    }

    existing.count++;
    if (existing.count > MAX_ATTEMPTS) {
        return { ok: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
    }
    return { ok: true };
}

export async function checkLoginRateLimit(ip: string, email: string): Promise<{ ok: boolean; retryAfterSeconds?: number }> {
    const key = keyFor(ip, email);
    const redis = getRedis();
    if (!redis) {
        return checkMemoryLimit(key);
    }

    try {
        if (redis.status === "wait") {
            await redis.connect();
        }
        const count = await redis.incr(key);
        if (count === 1) {
            await redis.expire(key, WINDOW_SECONDS);
        }
        if (count > MAX_ATTEMPTS) {
            const ttl = await redis.ttl(key);
            return { ok: false, retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
        }
        return { ok: true };
    } catch (error) {
        log({ module: "team-rate-limit", level: "warn" }, `Redis rate limit failed, using memory fallback: ${error}`);
        return checkMemoryLimit(key);
    }
}
