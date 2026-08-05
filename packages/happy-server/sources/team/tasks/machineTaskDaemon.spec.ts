import { describe, expect, it } from "vitest";
import { createMachineTaskDaemon, type MachineRpcCall } from "./machineTaskDaemon";

interface RecordedCall {
    method: string;
    payload: Record<string, unknown>;
}

function recorder(responses: Record<string, Record<string, unknown>>): { call: MachineRpcCall; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const call: MachineRpcCall = async (method, payload) => {
        calls.push({ method, payload: payload as Record<string, unknown> });
        const response = responses[method];
        if (!response) throw new Error(`unexpected method ${method}`);
        return response;
    };
    return { call, calls };
}

describe("machine task daemon", () => {
    it("maps prepareWorktree to the task-prepare-worktree RPC", async () => {
        const { call, calls } = recorder({ "task-prepare-worktree": { worktreePath: "/wt", skillsCommit: "abc123" } });
        const daemon = createMachineTaskDaemon(call);
        const result = await daemon.prepareWorktree({ taskId: "t1", repoPath: "/repo", baseBranch: "main", workBranch: "happy/u/x" });
        expect(result).toEqual({ worktreePath: "/wt", skillsCommit: "abc123" });
        expect(calls[0]).toEqual({
            method: "task-prepare-worktree",
            payload: { taskId: "t1", repoPath: "/repo", baseBranch: "main", workBranch: "happy/u/x" },
        });
    });

    it("spawns a stage via spawn-happy-session carrying prompt, mode and token in the environment", async () => {
        const { call, calls } = recorder({ "spawn-happy-session": { type: "success", sessionId: "sess-9" } });
        const daemon = createMachineTaskDaemon(call);
        const result = await daemon.spawnStage({
            taskId: "t1",
            stage: "execute",
            agent: "claude",
            worktreePath: "/wt",
            prompt: "do it",
            permissionMode: "auto",
            token: "tok-abc",
        });
        expect(result).toEqual({ sessionId: "sess-9" });
        expect(calls[0].method).toBe("spawn-happy-session");
        expect(calls[0].payload).toEqual({
            directory: "/wt",
            agent: "claude",
            environmentVariables: {
                HAPPY_TASK_ID: "t1",
                HAPPY_TASK_TOKEN: "tok-abc",
                HAPPY_TASK_STAGE: "execute",
                HAPPY_TASK_PROMPT: "do it",
                HAPPY_TASK_PERMISSION_MODE: "auto",
            },
        });
    });

    it("includes HAPPY_TASK_MODEL only when the stage sets a model", async () => {
        const { call, calls } = recorder({ "spawn-happy-session": { type: "success", sessionId: "sess-10" } });
        const daemon = createMachineTaskDaemon(call);
        await daemon.spawnStage({
            taskId: "t1",
            stage: "plan",
            agent: "claude",
            model: "claude-opus-4-8",
            worktreePath: "/wt",
            prompt: "plan it",
            permissionMode: "plan",
            token: "tok-def",
        });
        expect((calls[0].payload.environmentVariables as Record<string, string>).HAPPY_TASK_MODEL).toBe("claude-opus-4-8");
        expect((calls[0].payload.environmentVariables as Record<string, string>).HAPPY_TASK_PERMISSION_MODE).toBe("plan");
    });

    it("throws when spawn-happy-session does not return success", async () => {
        const { call } = recorder({ "spawn-happy-session": { type: "error" } });
        const daemon = createMachineTaskDaemon(call);
        await expect(
            daemon.spawnStage({ taskId: "t1", stage: "execute", agent: "claude", worktreePath: "/wt", prompt: "x", permissionMode: "auto", token: "t" }),
        ).rejects.toThrow(/session id/);
    });

    it("maps checkArtifacts and deliver responses", async () => {
        const { call } = recorder({
            "task-check-artifacts": { missing: [".happy-task/pr.md"] },
            "task-deliver": { prUrl: "https://pr/1", platform: "github" },
        });
        const daemon = createMachineTaskDaemon(call);
        expect(await daemon.checkArtifacts({ worktreePath: "/wt", artifacts: [".happy-task/pr.md"] })).toEqual({
            missing: [".happy-task/pr.md"],
        });
        expect(await daemon.deliver({ worktreePath: "/wt", baseBranch: "main" })).toEqual({
            prUrl: "https://pr/1",
            platform: "github",
        });
    });
});
