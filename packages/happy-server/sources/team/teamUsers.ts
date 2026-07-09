import { AgentAuthMode, TeamRole, TeamUserStatus } from "@prisma/client";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createManagedAccount, decryptManagedSecretKey, encodeSecretKey } from "@/team/escrow";
import { generateTemporaryPassword, hashPassword, normalizeEmail } from "@/team/passwords";
import { writeTeamAudit } from "@/team/audit";

export interface SafeTeamUser {
    id: string;
    email: string;
    role: TeamRole;
    status: TeamUserStatus;
    mustChangePassword: boolean;
    accountId: string;
    claudeAuthMode: AgentAuthMode;
    codexAuthMode: AgentAuthMode;
    machineCount?: number;
    createdAt: string;
    updatedAt: string;
}

export function toSafeTeamUser(user: {
    id: string;
    email: string;
    role: TeamRole;
    status: TeamUserStatus;
    mustChangePassword: boolean;
    accountId: string;
    claudeAuthMode: AgentAuthMode;
    codexAuthMode: AgentAuthMode;
    createdAt: Date;
    updatedAt: Date;
}, machineCount?: number): SafeTeamUser {
    return {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        mustChangePassword: user.mustChangePassword,
        accountId: user.accountId,
        claudeAuthMode: user.claudeAuthMode,
        codexAuthMode: user.codexAuthMode,
        machineCount,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
    };
}

export async function createTeamUser(input: {
    email: string;
    password?: string;
    role?: TeamRole;
    actorId?: string | null;
}): Promise<{ user: SafeTeamUser; initialPassword: string }> {
    const email = normalizeEmail(input.email);
    const initialPassword = input.password ?? generateTemporaryPassword();
    const passwordHash = await hashPassword(initialPassword);
    const managed = await createManagedAccount();

    const user = await db.teamUser.create({
        data: {
            email,
            passwordHash,
            role: input.role ?? TeamRole.MEMBER,
            status: TeamUserStatus.ACTIVE,
            mustChangePassword: true,
            accountId: managed.accountId,
            encSecretKey: managed.encSecretKey,
        },
    });

    await writeTeamAudit({
        actorId: input.actorId ?? null,
        action: "create_user",
        target: user.id,
        detail: { email: user.email, role: user.role },
    });

    return { user: toSafeTeamUser(user), initialPassword };
}

export async function buildTeamLoginResponse(user: {
    id: string;
    accountId: string;
    encSecretKey: Uint8Array;
    role: TeamRole;
    mustChangePassword: boolean;
}): Promise<{ happyToken: string; secretKey: string; role: TeamRole; mustChangePassword: boolean }> {
    const secretKey = decryptManagedSecretKey(user.accountId, user.encSecretKey);
    return {
        happyToken: await auth.createToken(user.accountId),
        secretKey: encodeSecretKey(secretKey),
        role: user.role,
        mustChangePassword: user.mustChangePassword,
    };
}
