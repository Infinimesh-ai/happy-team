import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueMcpToken, verifyMcpToken } from "./mcpToken";

const originalSecret = process.env.HANDY_MASTER_SECRET;

describe("mcp tokens", () => {
    beforeAll(() => {
        process.env.HANDY_MASTER_SECRET = "mcp-token-test-secret";
    });
    afterAll(() => {
        if (originalSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = originalSecret;
    });

    const member = { id: "tu1", passwordHash: "$argon2id$fakehash" };

    it("round-trips a token", () => {
        const token = issueMcpToken(member);
        const payload = verifyMcpToken(token);
        expect(payload?.uid).toBe("tu1");
        expect(payload?.scope).toBe("tasks");
    });

    it("rejects a tampered payload", () => {
        const token = issueMcpToken(member);
        const [, sig] = token.split(".");
        const forged = `${Buffer.from(JSON.stringify({ uid: "other", scope: "tasks", pwd: "x", exp: Date.now() + 10_000 })).toString("base64url")}.${sig}`;
        expect(verifyMcpToken(forged)).toBeNull();
    });

    it("rejects an expired token", () => {
        const token = issueMcpToken(member, -1);
        expect(verifyMcpToken(token)).toBeNull();
    });

    it("rejects a task token (domain separation)", async () => {
        const { issueTaskToken } = await import("@/team/tasks/taskToken");
        const token = issueTaskToken({ taskId: "t1", stage: "execute", round: 0 });
        expect(verifyMcpToken(token)).toBeNull();
    });

    it("binds the payload to the password hash", () => {
        const token = issueMcpToken(member);
        const before = verifyMcpToken(token);
        const after = verifyMcpToken(issueMcpToken({ ...member, passwordHash: "$argon2id$rotated" }));
        expect(before?.pwd).not.toBe(after?.pwd);
    });
});
