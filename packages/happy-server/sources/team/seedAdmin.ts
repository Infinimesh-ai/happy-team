import { TeamRole } from "@prisma/client";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { createTeamUser } from "@/team/teamUsers";

export async function seedTeamAdmin(): Promise<void> {
    const existingAdmin = await db.teamUser.findFirst({
        where: { role: TeamRole.ADMIN },
        select: { id: true },
    });
    if (existingAdmin) {
        return;
    }

    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_INITIAL_PASSWORD;
    if (!email || !password) {
        log({ module: "team-seed-admin" }, "No Team ADMIN exists and ADMIN_EMAIL/ADMIN_INITIAL_PASSWORD are not set; skipping seed");
        return;
    }

    const created = await createTeamUser({
        email,
        password,
        role: TeamRole.ADMIN,
        actorId: null,
    });
    log({ module: "team-seed-admin", adminId: created.user.id }, "Seeded Team ADMIN from environment");
}
