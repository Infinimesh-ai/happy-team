/**
 * Real {@link TaskDaemonGateway} backed by machine RPCs (milestone C0.7).
 *
 * Pure translation from state-machine effects to daemon RPC calls; the encrypted
 * transport is injected as {@link MachineRpcCall} so this mapping is unit-tested
 * without a live daemon. taskRuntime wires the real transport (callMachineRpc).
 * Stage sessions start through the existing `spawn-happy-session` RPC with the
 * worktree as the directory and `HAPPY_TASK_ID` in the environment (plan §8).
 */
import type { TaskDaemonGateway } from "./taskDaemon";

/** Invoke a daemon RPC, resolving the decrypted result or throwing on error. */
export interface MachineRpcCall {
    (baseMethod: string, payload: unknown): Promise<Record<string, unknown>>;
}

export function createMachineTaskDaemon(call: MachineRpcCall): TaskDaemonGateway {
    return {
        async prepareWorktree(input) {
            const result = await call("task-prepare-worktree", {
                taskId: input.taskId,
                repoPath: input.repoPath,
                baseBranch: input.baseBranch,
                workBranch: input.workBranch,
            });
            if (typeof result.worktreePath !== "string") {
                throw new Error("task-prepare-worktree did not return a worktree path");
            }
            return {
                worktreePath: result.worktreePath,
                skillsCommit: typeof result.skillsCommit === "string" ? result.skillsCommit : null,
            };
        },

        async spawnStage(input) {
            // The stage prompt, permission mode and model ride in as environment
            // variables: spawn-happy-session has no first-message parameter, so
            // the spawned CLI reads HAPPY_TASK_* at startup (taskSessionBootstrap)
            // and seeds its own message queue / initial mode from them.
            const environmentVariables: Record<string, string> = {
                HAPPY_TASK_ID: input.taskId,
                HAPPY_TASK_TOKEN: input.token,
                HAPPY_TASK_STAGE: input.stage,
                HAPPY_TASK_PROMPT: input.prompt,
                HAPPY_TASK_PERMISSION_MODE: input.permissionMode,
            };
            if (input.model) {
                environmentVariables.HAPPY_TASK_MODEL = input.model;
            }
            const result = await call("spawn-happy-session", {
                directory: input.worktreePath,
                agent: input.agent,
                environmentVariables,
            });
            if (result.type !== "success" || typeof result.sessionId !== "string") {
                throw new Error("spawn-happy-session did not return a session id");
            }
            return { sessionId: result.sessionId };
        },

        async checkArtifacts(input) {
            const result = await call("task-check-artifacts", {
                worktreePath: input.worktreePath,
                artifacts: input.artifacts,
            });
            const missing = Array.isArray(result.missing) ? result.missing.map((entry) => String(entry)) : [];
            return { missing };
        },

        async deliver(input) {
            const result = await call("task-deliver", {
                worktreePath: input.worktreePath,
                baseBranch: input.baseBranch,
            });
            if (typeof result.prUrl !== "string") {
                throw new Error("task-deliver did not return a PR url");
            }
            return { prUrl: result.prUrl, platform: typeof result.platform === "string" ? result.platform : "unknown" };
        },

        async writeArtifact(input) {
            await call("task-write-artifact", {
                worktreePath: input.worktreePath,
                artifact: input.artifact,
                content: input.content,
            });
        },

        async readArtifact(input) {
            const result = await call("task-read-artifact", { worktreePath: input.worktreePath, artifact: input.artifact });
            return { content: typeof result.content === "string" ? result.content : null };
        },

        async runValidation(input) {
            const result = await call("task-run-validation", { worktreePath: input.worktreePath });
            return {
                command: typeof result.command === "string" ? result.command : null,
                exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
                output: typeof result.output === "string" ? result.output : "",
            };
        },
    };
}
