import { TeamRole, TeamUser, TeamUserStatus } from "@prisma/client";
import { db } from "@/storage/db";

export async function isTeamAccountDisabled(accountId: string): Promise<boolean> {
    const teamUser = await db.teamUser.findUnique({
        where: { accountId },
        select: { status: true },
    });
    return teamUser?.status === TeamUserStatus.DISABLED;
}

export async function getActiveTeamUser(accountId: string): Promise<TeamUser | null> {
    const teamUser = await db.teamUser.findUnique({
        where: { accountId },
    });
    if (!teamUser || teamUser.status !== TeamUserStatus.ACTIVE) {
        return null;
    }
    return teamUser;
}

export async function getActiveAdminTeamUser(accountId: string): Promise<TeamUser | null> {
    const teamUser = await getActiveTeamUser(accountId);
    if (!teamUser || teamUser.role !== TeamRole.ADMIN) {
        return null;
    }
    return teamUser;
}
