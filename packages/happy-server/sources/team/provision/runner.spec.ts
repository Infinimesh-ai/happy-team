import { spawnSync } from "child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { buildInstallCliCommand, buildStartDaemonCommand } from "@/team/provision/runner";

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
        expect(command).toContain("launch_script=\"$HOME/.happy-team/launchd-start.sh\"");
        expect(command).toContain("daemon start-sync");
        expect(command).toContain("CLAUDE_CODE_OAUTH_TOKEN");
        expect(command).toContain(". \"$HOME/.happy-team/agent.env\"");
        expect(command).toContain("EnvironmentFile=%h/.happy-team/agent.env");
        expect(command).toContain("systemctl --user enable --now happy-team.service");
        expect(command).toContain("crontab -l");
        expect(command).not.toContain("TEAM_ANTHROPIC_API_KEY");
        expect(command).not.toContain("TEAM_OPENAI_API_KEY");
        expect(command).not.toContain("ANTHROPIC_API_KEY=");
        expect(command).not.toContain("OPENAI_API_KEY=");
    });

    it("uses the selected Node runtime when installing the CLI", () => {
        const command = buildInstallCliCommand(serverUrl, "/usr/local/bin/node");

        expect(command).toContain("exec '/usr/local/bin/node' \"$HOME/.happy-team/cli/bin/happy.mjs\" \"$@\"");
        expect(command).toContain("'/usr/local/bin/node' -e 'console.log(\"happy cli installed\")'");
        expect(command).not.toContain("\"$HOME/.happy-team/bin/node\" -e");
    });

    it("loads Claude OAuth credentials in the macOS launchd wrapper without storing tokens in the plist", async () => {
        const command = buildStartDaemonCommand(serverUrl);
        const launchdScript = extractLaunchdScript(command);
        const syntax = spawnSync("sh", ["-n"], {
            input: launchdScript,
            encoding: "utf8",
        });
        expect(syntax.status).toBe(0);
        expect(syntax.stderr).toBe("");

        const home = await mkdtemp(path.join(tmpdir(), "happy-team-launchd-"));
        try {
            await mkdir(path.join(home, ".happy-team", "bin"), { recursive: true });
            await mkdir(path.join(home, ".claude"), { recursive: true });
            await writeFile(path.join(home, ".happy-team", "agent.env"), "# personal oauth\n", { mode: 0o600 });
            await symlink(process.execPath, path.join(home, ".happy-team", "bin", "node"));
            await writeFile(path.join(home, ".claude", ".credentials.json"), JSON.stringify({
                claudeAiOauth: { accessToken: "oauth-test-token" },
            }));
            await writeFile(
                path.join(home, ".happy-team", "bin", "happy"),
                "#!/bin/sh\nprintf '%s' \"$CLAUDE_CODE_OAUTH_TOKEN\" > \"$HOME/token.out\"\n",
                { mode: 0o700 },
            );
            const scriptPath = path.join(home, ".happy-team", "launchd-start.sh");
            await writeFile(scriptPath, launchdScript, { mode: 0o700 });

            const result = spawnSync("sh", [scriptPath], {
                env: {
                    ...process.env,
                    HOME: home,
                    CLAUDE_CODE_OAUTH_TOKEN: "",
                    ANTHROPIC_API_KEY: "",
                },
                encoding: "utf8",
            });
            expect(result.status).toBe(0);
            expect(result.stderr).toBe("");
            await expect(readFile(path.join(home, "token.out"), "utf8")).resolves.toBe("oauth-test-token");
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});

function extractLaunchdScript(command: string): string {
    const match = command.match(/cat > "\$launch_script" <<'HAPPY_TEAM_LAUNCHD_SH'\n([\s\S]*?)HAPPY_TEAM_LAUNCHD_SH/);
    if (!match) {
        throw new Error("launchd wrapper heredoc not found");
    }
    return match[1];
}
