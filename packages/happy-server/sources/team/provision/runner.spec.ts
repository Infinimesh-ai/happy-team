import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";
import { buildStartDaemonCommand } from "@/team/provision/runner";

describe("provision daemon startup script", () => {
    const serverUrl = "https://happy.example.com/api?x=1&y=2";

    it("generates syntactically valid POSIX shell", () => {
        const script = `set -eu\n${buildStartDaemonCommand(serverUrl)}\n`;
        const result = spawnSync("sh", ["-n"], {
            input: script,
            encoding: "utf8",
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
    });

    it("includes macOS launchd and Linux fallback startup paths without company secrets", () => {
        const command = buildStartDaemonCommand(serverUrl);

        expect(command).toContain("case \"$platform\" in");
        expect(command).toContain("darwin)");
        expect(command).toContain("plist=\"$HOME/Library/LaunchAgents/$label.plist\"");
        expect(command).toContain("label=com.happy-team.daemon");
        expect(command).toContain("launchctl bootstrap \"gui/$uid\" \"$plist\"");
        expect(command).toContain("daemon start-sync");
        expect(command).toContain(". \"$HOME/.happy-team/agent.env\"");
        expect(command).toContain("EnvironmentFile=%h/.happy-team/agent.env");
        expect(command).toContain("systemctl --user enable --now happy-team.service");
        expect(command).toContain("crontab -l");
        expect(command).not.toContain("TEAM_ANTHROPIC_API_KEY");
        expect(command).not.toContain("TEAM_OPENAI_API_KEY");
        expect(command).not.toContain("ANTHROPIC_API_KEY=");
        expect(command).not.toContain("OPENAI_API_KEY=");
    });
});
