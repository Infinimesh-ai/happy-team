import { Prisma } from "@prisma/client";
import { db } from "@/storage/db";

export interface WriteTeamAuditInput {
    actorId?: string | null;
    action: string;
    target?: string | null;
    detail?: Prisma.InputJsonValue;
}

export async function writeTeamAudit(input: WriteTeamAuditInput): Promise<void> {
    await db.teamAuditLog.create({
        data: {
            actorId: input.actorId ?? null,
            action: input.action,
            target: input.target ?? null,
            detail: input.detail ?? undefined,
        },
    });
}
