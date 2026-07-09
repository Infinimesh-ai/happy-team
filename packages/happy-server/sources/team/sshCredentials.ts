import { randomUUID } from "crypto";
import { type SshAuthType, type SshCredential } from "@prisma/client";
import { decryptString, encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import { writeTeamAudit } from "@/team/audit";

export type SshCredentialAuth =
    | { type: "PASSWORD"; password: string }
    | { type: "PRIVATE_KEY"; privateKey: string; passphrase?: string };

export type SafeSshCredential = {
    id: string;
    ownerUserId: string;
    label: string;
    host: string;
    port: number;
    username: string;
    authType: SshAuthType;
    deleteAfterUse: boolean;
    createdBy: string;
    createdAt: string;
};

function credentialPath(id: string): string[] {
    return ["team", "ssh-credential", id, "auth"];
}

export function toSafeSshCredential(credential: SshCredential): SafeSshCredential {
    return {
        id: credential.id,
        ownerUserId: credential.ownerUserId,
        label: credential.label,
        host: credential.host,
        port: credential.port,
        username: credential.username,
        authType: credential.authType,
        deleteAfterUse: credential.deleteAfterUse,
        createdBy: credential.createdBy,
        createdAt: credential.createdAt.toISOString(),
    };
}

export async function createSshCredential(input: {
    ownerUserId: string;
    label: string;
    host: string;
    port: number;
    username: string;
    auth: SshCredentialAuth;
    deleteAfterUse: boolean;
    createdBy: string;
}): Promise<SafeSshCredential> {
    const id = randomUUID();
    const created = await db.sshCredential.create({
        data: {
            id,
            ownerUserId: input.ownerUserId,
            label: input.label,
            host: input.host,
            port: input.port,
            username: input.username,
            authType: input.auth.type,
            encAuth: encryptString(credentialPath(id), JSON.stringify(input.auth)),
            deleteAfterUse: input.deleteAfterUse,
            createdBy: input.createdBy,
        },
    });

    await writeTeamAudit({
        actorId: input.createdBy,
        action: "create_ssh_credential",
        target: created.id,
        detail: {
            ownerUserId: created.ownerUserId,
            host: created.host,
            port: created.port,
            username: created.username,
            authType: created.authType,
            deleteAfterUse: created.deleteAfterUse,
        },
    });

    return toSafeSshCredential(created);
}

export function decryptSshCredentialAuth(credential: Pick<SshCredential, "id" | "encAuth">): SshCredentialAuth {
    const raw = decryptString(credentialPath(credential.id), credential.encAuth);
    return JSON.parse(raw) as SshCredentialAuth;
}

export async function deleteSshCredential(id: string, actorId: string): Promise<boolean> {
    const credential = await db.sshCredential.findUnique({ where: { id } });
    if (!credential) {
        return false;
    }
    await db.sshCredential.delete({ where: { id } });
    await writeTeamAudit({
        actorId,
        action: "delete_ssh_credential",
        target: id,
        detail: { ownerUserId: credential.ownerUserId, host: credential.host, port: credential.port },
    });
    return true;
}
