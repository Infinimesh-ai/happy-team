/**
 * Daemon gateway — the effect boundary of the task state machine (plan §4, §8).
 *
 * The state machine (spine) is deterministic and observable; every side effect
 * that must run on the member's machine (prepare worktree, spawn a stage
 * session, check artifacts, deliver) is expressed through this interface. The
 * real implementation (encrypted machine RPCs via callRegisteredRpcMethod) is
 * wired in C0.7; the state machine and its tests depend only on this contract,
 * so orchestration can be tested against an in-memory fake daemon (plan §11
 * "假 daemon 桩").
 */

export interface PrepareWorktreeEffect {
    taskId: string;
    repoPath: string;
    baseBranch: string;
    workBranch: string;
}

export interface SpawnStageEffect {
    taskId: string;
    stage: string;
    agent: string;
    model?: string;
    worktreePath: string;
    prompt: string;
    permissionMode: "plan" | "auto";
    /** Short-lived task-control token injected into the session (plan §7). */
    token: string;
}

export interface CheckArtifactsEffect {
    worktreePath: string;
    artifacts: string[];
}

export interface DeliverEffect {
    worktreePath: string;
    baseBranch: string;
}

export interface WriteArtifactEffect {
    worktreePath: string;
    /** Path relative to the worktree, e.g. ".happy-task/plan.md". */
    artifact: string;
    content: string;
}

export interface TaskDaemonGateway {
    prepareWorktree(input: PrepareWorktreeEffect): Promise<{ worktreePath: string; skillsCommit: string | null }>;
    spawnStage(input: SpawnStageEffect): Promise<{ sessionId: string }>;
    /** Existence check for a stage's expected artifacts; returns the missing ones. */
    checkArtifacts(input: CheckArtifactsEffect): Promise<{ missing: string[] }>;
    deliver(input: DeliverEffect): Promise<{ prUrl: string; platform: string }>;
    /** Write an artifact back into the worktree (e.g. an edited plan.md on approval). */
    writeArtifact(input: WriteArtifactEffect): Promise<void>;
    /** Read an artifact from the worktree (e.g. plan.md for the approval card). */
    readArtifact(input: { worktreePath: string; artifact: string }): Promise<{ content: string | null }>;
    /** Run the project's validation gate in the worktree (materialized evidence). */
    runValidation(input: { worktreePath: string }): Promise<{ command: string | null; exitCode: number | null; output: string }>;
}

/**
 * Notification sink for task lifecycle events (plan §1.1). Default is a no-op;
 * the real push-notification implementation lands in C0.8.
 */
export type TaskNotification =
    | { type: "stage_started"; taskId: string; stage: string }
    | { type: "approval_needed"; taskId: string; stage: string }
    | { type: "task_escalated"; taskId: string; reason: string }
    | { type: "task_delivered"; taskId: string; prUrl: string }
    | { type: "task_failed"; taskId: string; error: string }
    | { type: "task_cancelled"; taskId: string };

export interface TaskNotifier {
    notify(event: TaskNotification): Promise<void>;
}

export const noopTaskNotifier: TaskNotifier = {
    async notify() {
        // no-op until C0.8 wires real push notifications
    },
};
