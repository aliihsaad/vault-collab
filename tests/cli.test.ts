import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function parseJson<T>(result: CliResult): T {
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as T;
}

describe("vault-collab CLI", () => {
  let dbPath: string;
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "vault-collab-cli-"));
    dbPath = join(cwd, "collab.db");
  });

  afterEach(() => {
    // SQLite files stay in the OS temp directory for post-failure inspection.
  });

  it("runs the session and handoff smoke workflow through JSON commands", async () => {
    const codex = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Codex",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--capability",
        "handoffs=true"
      ])
    );
    const claude = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Claude Code",
        "--client-type",
        "claude-code",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--capability",
        "handoffs=true"
      ])
    );

    const sessions = parseJson<Array<{ sessionUid: string; sessionToken?: string }>>(
      await runCli(["sessions", "--db", dbPath, "--project", "Vault Collab"])
    );

    expect(sessions.map((session) => session.sessionUid)).toEqual([
      codex.sessionUid,
      claude.sessionUid
    ]);
    expect(sessions[0]).not.toHaveProperty("sessionToken");

    const published = parseJson<{ handoffUid: string; status: string; urgent: boolean }>(
      await runCli([
        "publish",
        "--db",
        dbPath,
        "--short-prompt",
        "Add CLI smoke commands.",
        "--source-project",
        "Vault Collab",
        "--target-project",
        "Vault Collab",
        "--source-session-uid",
        codex.sessionUid,
        "--suggested-client-type",
        "claude-code",
        "--related-file",
        "src/cli.ts",
        "--related-file",
        "tests/cli.test.ts",
        "--priority",
        "high",
        "--urgent"
      ])
    );

    expect(published).toMatchObject({
      status: "available",
      urgent: true
    });

    const linked = parseJson<{ vaultMemoryUid: string | null }>(
      await runCli([
        "link-vault-memory",
        "--db",
        dbPath,
        "--handoff-uid",
        published.handoffUid,
        "--session-uid",
        codex.sessionUid,
        "--session-token",
        codex.sessionToken,
        "--vault-memory-uid",
        "vm_cli_full_brief"
      ])
    );

    expect(linked.vaultMemoryUid).toBe("vm_cli_full_brief");

    const inbox = parseJson<Array<{ handoffUid: string; claimToken?: string }>>(
      await runCli(["inbox", "--db", dbPath, "--target-project", "Vault Collab"])
    );

    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      handoffUid: published.handoffUid
    });
    expect(inbox[0]).not.toHaveProperty("claimToken");

    const claimed = parseJson<{ status: string; claimedBySessionUid: string }>(
      await runCli([
        "claim",
        "--db",
        dbPath,
        "--handoff-uid",
        published.handoffUid,
        "--session-uid",
        claude.sessionUid,
        "--session-token",
        claude.sessionToken
      ])
    );

    expect(claimed).toMatchObject({
      status: "claimed",
      claimedBySessionUid: claude.sessionUid
    });

    const updated = parseJson<{ status: string; progressNote: string }>(
      await runCli([
        "update",
        "--db",
        dbPath,
        "--handoff-uid",
        published.handoffUid,
        "--session-uid",
        claude.sessionUid,
        "--session-token",
        claude.sessionToken,
        "--status",
        "in_progress",
        "--progress-note",
        "CLI tests are driving the implementation."
      ])
    );

    expect(updated).toMatchObject({
      status: "in_progress",
      progressNote: "CLI tests are driving the implementation."
    });

    const resolved = parseJson<{ status: string; resolutionSummary: string }>(
      await runCli([
        "resolve",
        "--db",
        dbPath,
        "--handoff-uid",
        published.handoffUid,
        "--session-uid",
        claude.sessionUid,
        "--session-token",
        claude.sessionToken,
        "--summary",
        "CLI smoke workflow verified."
      ])
    );

    expect(resolved).toMatchObject({
      status: "resolved",
      resolutionSummary: "CLI smoke workflow verified."
    });

    const reopened = parseJson<{ status: string; claimedBySessionUid: string | null }>(
      await runCli([
        "reopen",
        "--db",
        dbPath,
        "--handoff-uid",
        published.handoffUid,
        "--reason",
        "User requested another pass.",
        "--status",
        "available"
      ])
    );

    expect(reopened).toMatchObject({
      status: "available",
      claimedBySessionUid: null
    });
  });

  it("rejects unknown commands without creating a destructive escape hatch", async () => {
    const result = await runCli(["clean", "--db", dbPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/unknown command/i);
  });
});
