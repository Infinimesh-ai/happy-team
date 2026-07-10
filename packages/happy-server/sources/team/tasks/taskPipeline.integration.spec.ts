/**
 * End-to-end pipeline integration test (C0 hardening for the C0.11 acceptance).
 *
 * Drives the REAL task state machine through a REAL git pipeline in-process:
 * real `git worktree add` off a local bare origin, a simulated agent session
 * that writes .happy-task/pr.md and commits, a real artifact-existence check,
 * and a real `git push` to origin. Only the two things that genuinely need
 * external infrastructure are stubbed: the encrypted socket transport (we call
 * the gateway directly) and the `gh`/`glab` PR creation (an injected URL). This
 * proves the whole spine — PENDING → PREPARING → RUNNING → deliver → SUCCEEDED,
 * transitions, and a branch actually landed on origin — end to end.
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, readFile as readFileFs, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskDaemonGateway } from "./taskDaemon";
import type { createTaskStateMachine as CreateFn } from "./taskStateMachine";

let db: typeof import("@/storage/db").db;
let createTaskStateMachine: typeof CreateFn;
let pgliteDir: string;
const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();
}

/** Bare origin (one commit on main) + a working clone that owns worktrees. */
async function makeRepo(): Promise<{ repoPath: string; originPath: string; worktreesDir: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "happy-pipeline-"));
    tempDirs.push(root);
    const originPath = path.join(root, "origin.git");
    const seedPath = path.join(root, "seed");
    const repoPath = path.join(root, "clone");
    const worktreesDir = path.join(root, "worktrees");

    execFileSync("git", ["init", "--bare", "-b", "main", originPath], { stdio: "pipe" });
    execFileSync("git", ["init", "-b", "main", seedPath], { stdio: "pipe" });
    git(seedPath, "config", "user.email", "t@example.com");
    git(seedPath, "config", "user.name", "T");
    await writeFile(path.join(seedPath, "README.md"), "# seed\n");
    git(seedPath, "add", ".");
    git(seedPath, "commit", "-m", "init");
    git(seedPath, "remote", "add", "origin", originPath);
    git(seedPath, "push", "origin", "main");

    execFileSync("git", ["clone", originPath, repoPath], { stdio: "pipe" });
    git(repoPath, "config", "user.email", "t@example.com");
    git(repoPath, "config", "user.name", "T");
    return { repoPath, originPath, worktreesDir };
}

/**
 * Gateway backed by real git. `spawnStage` stands in for the agent session:
 * it writes the expected artifact and commits, exactly what a real execute-only
 * session produces before it exits.
 */
function realGitGateway(
    repoPath: string,
    worktreesDir: string,
    prUrl: string,
    onDeliver: (branch: string) => void,
): TaskDaemonGateway {
    const worktreeFor = (taskId: string) => path.join(worktreesDir, taskId);
    return {
        async prepareWorktree(input) {
            const worktreePath = worktreeFor(input.taskId);
            git(repoPath, "fetch", "origin", input.baseBranch);
            git(repoPath, "worktree", "add", worktreePath, "-b", input.workBranch, `origin/${input.baseBranch}`);
            execFileSync("mkdir", ["-p", path.join(worktreePath, ".happy-task")], { stdio: "pipe" });
            return { worktreePath, skillsCommit: null };
        },
        async spawnStage(input) {
            // Simulate the execute-only agent: implement, write pr.md, commit.
            await writeFile(path.join(input.worktreePath, "CHANGES.txt"), "did the work\n");
            await writeFile(path.join(input.worktreePath, ".happy-task", "pr.md"), "# Automated change\n\nBody.\n");
            git(input.worktreePath, "add", ".");
            git(input.worktreePath, "commit", "-m", "feat: automated change");
            return { sessionId: `sess-${input.taskId}` };
        },
        async checkArtifacts(input) {
            const missing = input.artifacts.filter((a) => !existsSync(path.resolve(input.worktreePath, a)));
            return { missing };
        },
        async deliver(input) {
            const branch = git(input.worktreePath, "rev-parse", "--abbrev-ref", "HEAD").trim();
            git(input.worktreePath, "push", "-u", "origin", branch);
            onDeliver(branch);
            return { prUrl, platform: "github" };
        },
        async writeArtifact(input) {
            await writeFile(path.resolve(input.worktreePath, input.artifact), input.content);
        },
        async readArtifact(input) {
            const target = path.resolve(input.worktreePath, input.artifact);
            return { content: existsSync(target) ? await readFileFs(target, "utf8") : null };
        },
    };
}

describe("task pipeline (real git, in-process)", () => {
    beforeAll(async () => {
        pgliteDir = await mkdtemp(path.join(tmpdir(), "happy-pipeline-db-"));
        process.env.DB_PROVIDER = "pglite";
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = "pipeline-test-secret";
        const { runMigrations } = await import("@/standalone");
        await runMigrations({ pgliteDir, migrationsDir: path.join(process.cwd(), "prisma", "migrations") });
        ({ db } = await import("@/storage/db"));
        ({ createTaskStateMachine } = await import("./taskStateMachine"));
        await db.$connect();
    });

    afterAll(async () => {
        await db?.$disconnect();
        await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
        if (pgliteDir) await rm(pgliteDir, { recursive: true, force: true });
    });

    it("runs T1 end to end: real worktree, real commit, real push, delivered PR", async () => {
        const { repoPath, originPath, worktreesDir } = await makeRepo();
        const delivered: string[] = [];
        const gateway = realGitGateway(repoPath, worktreesDir, "https://github.test/pr/1", (b) => delivered.push(b));
        const sm = createTaskStateMachine({ daemon: gateway });

        const task = await db.teamTask.create({
            data: {
                ownerUserId: "u", machineId: "m", templateId: "execute-only", title: "Pipeline",
                goalPrompt: "do the work", repoPath, baseBranch: "main", workBranch: "happy/pipeline/change",
            },
        });

        await sm.startTask(task.id);
        // Session exit signal → completion determination → delivery.
        await sm.handleStageExit({ taskId: task.id });

        const finished = await db.teamTask.findUniqueOrThrow({ where: { id: task.id } });
        expect(finished.status).toBe("SUCCEEDED");
        expect(finished.prUrl).toBe("https://github.test/pr/1");
        expect(finished.worktreePath).toBe(path.join(worktreesDir, task.id));

        // The work branch really landed on origin with the agent's commit.
        expect(delivered).toEqual(["happy/pipeline/change"]);
        const originBranches = execFileSync("git", ["-C", originPath, "branch", "--list", "happy/pipeline/change"]).toString();
        expect(originBranches).toContain("happy/pipeline/change");
        const log = execFileSync("git", ["-C", originPath, "log", "happy/pipeline/change", "--oneline"]).toString();
        expect(log).toContain("automated change");

        const stageRun = await db.teamTaskStageRun.findFirstOrThrow({ where: { taskId: task.id } });
        expect(stageRun.status).toBe("SUCCEEDED");
        expect(stageRun.sessionId).toBe(`sess-${task.id}`);

        const transitions = await db.teamTaskTransition.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
        expect(transitions.map((t) => [t.fromStage, t.toStage])).toEqual([[null, "execute"], ["execute", "deliver"]]);
    });

    it("fails end to end when the agent produces no pr.md (no push, no PR)", async () => {
        const { repoPath, originPath, worktreesDir } = await makeRepo();
        const delivered: string[] = [];
        const base = realGitGateway(repoPath, worktreesDir, "https://github.test/pr/x", (b) => delivered.push(b));
        // Agent that commits code but forgets the required pr.md artifact.
        const gateway: TaskDaemonGateway = {
            ...base,
            async spawnStage(input) {
                await writeFile(path.join(input.worktreePath, "CHANGES.txt"), "work\n");
                git(input.worktreePath, "add", ".");
                git(input.worktreePath, "commit", "-m", "feat: work without pr.md");
                return { sessionId: `sess-${input.taskId}` };
            },
        };
        const sm = createTaskStateMachine({ daemon: gateway });

        const task = await db.teamTask.create({
            data: {
                ownerUserId: "u", machineId: "m", templateId: "execute-only", title: "NoArtifact",
                goalPrompt: "do the work", repoPath, baseBranch: "main", workBranch: "happy/pipeline/noartifact",
            },
        });

        await sm.startTask(task.id);
        await sm.handleStageExit({ taskId: task.id });

        const finished = await db.teamTask.findUniqueOrThrow({ where: { id: task.id } });
        expect(finished.status).toBe("FAILED");
        expect(finished.error).toContain("pr.md");
        expect(delivered).toEqual([]);
        // Nothing was pushed to origin.
        const originBranches = execFileSync("git", ["-C", originPath, "branch", "--list", "happy/pipeline/noartifact"]).toString();
        expect(originBranches).not.toContain("happy/pipeline/noartifact");
    });
});
