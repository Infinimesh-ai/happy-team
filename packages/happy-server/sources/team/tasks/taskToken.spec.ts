import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueTaskToken, verifyTaskToken } from "./taskToken";

const originalSecret = process.env.HANDY_MASTER_SECRET;

describe("task tokens", () => {
    beforeAll(() => {
        process.env.HANDY_MASTER_SECRET = "task-token-test-secret";
    });
    afterAll(() => {
        if (originalSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = originalSecret;
    });

    it("round-trips claims", () => {
        const token = issueTaskToken({ taskId: "t1", stage: "execute", round: 2 });
        expect(verifyTaskToken(token)).toEqual({ taskId: "t1", stage: "execute", round: 2 });
    });

    it("rejects a tampered payload", () => {
        const token = issueTaskToken({ taskId: "t1", stage: "execute", round: 0 });
        const [, sig] = token.split(".");
        const forged = `${Buffer.from(JSON.stringify({ taskId: "t1", stage: "execute", round: 0, exp: Date.now() + 10000 })).toString("base64url")}.${sig}`;
        expect(verifyTaskToken(forged)).toBeNull();
    });

    it("rejects an expired token", () => {
        const token = issueTaskToken({ taskId: "t1", stage: "execute", round: 0 }, -1);
        expect(verifyTaskToken(token)).toBeNull();
    });

    it("rejects garbage", () => {
        expect(verifyTaskToken("not-a-token")).toBeNull();
        expect(verifyTaskToken("")).toBeNull();
        expect(verifyTaskToken("a.b")).toBeNull();
    });

    it("rejects a token signed with a different secret", () => {
        const token = issueTaskToken({ taskId: "t1", stage: "execute", round: 0 });
        process.env.HANDY_MASTER_SECRET = "a-different-secret";
        expect(verifyTaskToken(token)).toBeNull();
        process.env.HANDY_MASTER_SECRET = "task-token-test-secret";
    });
});
