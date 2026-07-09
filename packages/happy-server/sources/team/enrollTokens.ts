import { createHash, randomBytes } from "crypto";
import { TeamUserStatus } from "@prisma/client";
import { db } from "@/storage/db";
import { decryptManagedSecretKey, encodeSecretKey } from "@/team/escrow";
import { writeTeamAudit } from "@/team/audit";

const DEFAULT_ENROLL_TOKEN_TTL_MS = 15 * 60 * 1000;

export type CreateEnrollTokenResult = {
    id: string;
    token: string;
    expiresAt: Date;
};

export type ConsumeEnrollTokenResult =
    | { ok: true; secretKey: string; targetUserId: string; accountId: string }
    | { ok: false; statusCode: 400 | 403 | 404; error: string };

export function hashEnrollToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createEnrollToken(input: {
    targetUserId: string;
    actorId: string;
    ttlMs?: number;
}): Promise<CreateEnrollTokenResult> {
    const token = `hte_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_ENROLL_TOKEN_TTL_MS));

    const created = await db.enrollToken.create({
        data: {
            tokenHash: hashEnrollToken(token),
            targetUserId: input.targetUserId,
            expiresAt,
            createdBy: input.actorId,
        },
    });

    await writeTeamAudit({
        actorId: input.actorId,
        action: "create_enroll_token",
        target: input.targetUserId,
        detail: { enrollTokenId: created.id, expiresAt: expiresAt.toISOString() },
    });

    return {
        id: created.id,
        token,
        expiresAt,
    };
}

export async function consumeEnrollToken(token: string): Promise<ConsumeEnrollTokenResult> {
    const tokenHash = hashEnrollToken(token);
    const now = new Date();

    const enrollToken = await db.enrollToken.findUnique({
        where: { tokenHash },
    });
    if (!enrollToken) {
        await writeTeamAudit({
            action: "enroll_failed",
            detail: { reason: "not_found" },
        });
        return { ok: false, statusCode: 404, error: "Invalid enroll token" };
    }
    if (enrollToken.usedAt) {
        await writeTeamAudit({
            action: "enroll_failed",
            target: enrollToken.targetUserId,
            detail: { enrollTokenId: enrollToken.id, reason: "already_used" },
        });
        return { ok: false, statusCode: 400, error: "Enroll token has already been used" };
    }
    if (enrollToken.expiresAt <= now) {
        await writeTeamAudit({
            action: "enroll_failed",
            target: enrollToken.targetUserId,
            detail: { enrollTokenId: enrollToken.id, reason: "expired" },
        });
        return { ok: false, statusCode: 400, error: "Enroll token has expired" };
    }

    const teamUser = await db.teamUser.findUnique({
        where: { id: enrollToken.targetUserId },
    });
    if (!teamUser || teamUser.status !== TeamUserStatus.ACTIVE) {
        await writeTeamAudit({
            action: "enroll_failed",
            target: enrollToken.targetUserId,
            detail: { enrollTokenId: enrollToken.id, reason: "target_inactive" },
        });
        return { ok: false, statusCode: 403, error: "Enroll target is not active" };
    }

    const consumed = await db.enrollToken.updateMany({
        where: {
            id: enrollToken.id,
            usedAt: null,
            expiresAt: { gt: now },
        },
        data: { usedAt: now },
    });
    if (consumed.count !== 1) {
        await writeTeamAudit({
            action: "enroll_failed",
            target: enrollToken.targetUserId,
            detail: { enrollTokenId: enrollToken.id, reason: "concurrent_use" },
        });
        return { ok: false, statusCode: 400, error: "Enroll token is no longer valid" };
    }

    const secretKey = decryptManagedSecretKey(teamUser.accountId, teamUser.encSecretKey);
    await writeTeamAudit({
        action: "enroll",
        target: teamUser.id,
        detail: { enrollTokenId: enrollToken.id },
    });

    return {
        ok: true,
        secretKey: encodeSecretKey(secretKey),
        targetUserId: teamUser.id,
        accountId: teamUser.accountId,
    };
}
