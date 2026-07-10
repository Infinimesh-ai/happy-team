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

    it("spawns a stage via spawn-happy-session with worktree directory and HAPPY_TASK_ID", async () => {
        const { call, calls } = recorder({ "spawn-happy-session": { type: "success", sessionId: "sess-9" } });
        const daemon = createMachineTaskDaemon(call);
        const result = await daemon.spawnStage({
            taskId: "t1",
            stage: "execute",
            agent: "claude",
            worktreePath: "/wt",
            prompt: "do it",
            permissionMode: "auto",
        });
        expect(result).toEqual({ sessionId: "sess-9" });
        expect(calls[0].method).toBe("spawn-happy-session");
        expect(calls[0].payload).toMatchObject({
            directory: "/wt",
            agent: "claude",
            environmentVariables: { HAPPY_TASK_ID: "t1" },
        });
    });

    it("throws when spawn-happy-session does not return success", async () => {
        const { call } = recorder({ "spawn-happy-session": { type: "error" } });
        const daemon = createMachineTaskDaemon(call);
        await expect(
            daemon.spawnStage({ taskId: "t1", stage: "execute", agent: "claude", worktreePath: "/wt", prompt: "x", permissionMode: "auto" }),
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
