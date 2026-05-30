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

  it("runs a local install check without starting hidden work", async () => {
    const check = parseJson<{
      ok: boolean;
      databasePath: string;
      storage: string;
      mode: string;
      cliBin: string;
      mcpBin: string;
    }>(await runCli(["check", "--db", dbPath]));

    expect(check).toEqual({
      ok: true,
      databasePath: dbPath,
      storage: "sqlite",
      mode: "local-first",
      cliBin: "vault-collab",
      mcpBin: "vault-collab-mcp"
    });

    const sessions = parseJson<unknown[]>(await runCli(["sessions", "--db", dbPath]));
    expect(sessions).toEqual([]);
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
        "--suggested-session-uid",
        claude.sessionUid,
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

    for (const status of ["abandoned", "stale"]) {
      const terminalUpdate = await runCli([
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
        status,
        "--progress-note",
        "Do not route terminal state through update."
      ]);

      expect(terminalUpdate.exitCode).toBe(1);
      expect(terminalUpdate.stderr).toMatch(/dedicated lifecycle method/i);
    }

    const detail = parseJson<{
      handoff: { handoffUid: string; status: string };
      events: Array<{ eventType: string }>;
      sessions: {
        sourceSession: { sessionUid: string; sessionToken?: string } | null;
        suggestedSession: { sessionUid: string; sessionToken?: string } | null;
        claimedBySession: { sessionUid: string; sessionToken?: string } | null;
      };
    }>(await runCli(["handoff", "--db", dbPath, "--handoff-uid", published.handoffUid]));

    expect(detail.handoff).toMatchObject({
      handoffUid: published.handoffUid,
      status: "in_progress"
    });
    expect(detail.events.map((event) => event.eventType)).toEqual([
      "handoff.published",
      "handoff.vault_memory_linked",
      "handoff.claimed",
      "handoff.updated"
    ]);
    expect(detail.sessions.sourceSession).toMatchObject({
      sessionUid: codex.sessionUid
    });
    expect(detail.sessions.suggestedSession).toMatchObject({
      sessionUid: claude.sessionUid
    });
    expect(detail.sessions.claimedBySession).toMatchObject({
      sessionUid: claude.sessionUid
    });
    expect(JSON.stringify(detail)).not.toContain(codex.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(claude.sessionToken);

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

    const handoffEvents = parseJson<
      Array<{
        eventType: string;
        handoffUid: string | null;
        sessionUid: string | null;
        payload: Record<string, unknown>;
      }>
    >(await runCli(["events", "--db", dbPath, "--handoff-uid", published.handoffUid]));

    expect(handoffEvents.map((event) => event.eventType)).toEqual([
      "handoff.published",
      "handoff.vault_memory_linked",
      "handoff.claimed",
      "handoff.updated",
      "handoff.resolved",
      "handoff.reopened"
    ]);
    expect(handoffEvents[0]).toMatchObject({
      handoffUid: published.handoffUid,
      sessionUid: codex.sessionUid
    });
    expect(JSON.stringify(handoffEvents)).not.toContain(codex.sessionToken);
    expect(JSON.stringify(handoffEvents)).not.toContain(claude.sessionToken);

    const claudeEvents = parseJson<Array<{ eventType: string }>>(
      await runCli(["events", "--db", dbPath, "--session-uid", claude.sessionUid])
    );

    expect(claudeEvents.map((event) => event.eventType)).toEqual([
      "session.registered",
      "handoff.claimed",
      "handoff.updated",
      "handoff.resolved"
    ]);
  });

  it("recovers a stranded handoff through the CLI without leaking owner tokens", async () => {
    const source = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Source",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd
      ])
    );
    const implementer = parseJson<{ sessionUid: string; sessionToken: string }>(
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
        cwd
      ])
    );
    const handoff = parseJson<{ handoffUid: string }>(
      await runCli([
        "publish",
        "--db",
        dbPath,
        "--short-prompt",
        "Recover with CLI",
        "--source-project",
        "Vault Collab",
        "--target-project",
        "Vault Collab",
        "--source-session-uid",
        source.sessionUid
      ])
    );

    await runCli([
      "claim",
      "--db",
      dbPath,
      "--handoff-uid",
      handoff.handoffUid,
      "--session-uid",
      implementer.sessionUid,
      "--session-token",
      implementer.sessionToken
    ]);
    await runCli([
      "update",
      "--db",
      dbPath,
      "--handoff-uid",
      handoff.handoffUid,
      "--session-uid",
      implementer.sessionUid,
      "--session-token",
      implementer.sessionToken,
      "--status",
      "in_progress",
      "--progress-note",
      "Complete but stranded"
    ]);

    const recovered = parseJson<{ status: string; claimedBySessionUid: string }>(
      await runCli([
        "recover",
        "--db",
        dbPath,
        "--handoff-uid",
        handoff.handoffUid,
        "--actor-session-uid",
        source.sessionUid,
        "--actor-session-token",
        source.sessionToken,
        "--reason",
        "Owner token unavailable after compaction.",
        "--summary",
        "Completion report accepted.",
        "--evidence-vault-memory-uid",
        "vm_recovery_evidence"
      ])
    );
    const events = parseJson<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await runCli(["events", "--db", dbPath, "--handoff-uid", handoff.handoffUid])
    );

    expect(recovered).toMatchObject({
      status: "resolved",
      claimedBySessionUid: implementer.sessionUid
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "handoff.published",
      "handoff.claimed",
      "handoff.updated",
      "handoff.recovery_resolved"
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      reason: "Owner token unavailable after compaction.",
      summary: "Completion report accepted.",
      evidenceVaultMemoryUid: "vm_recovery_evidence",
      previousClaimedBySessionUid: implementer.sessionUid,
      previousStatus: "in_progress",
      actorAuthorizedBy: "source_session"
    });
    expect(JSON.stringify(events)).not.toContain(source.sessionToken);
    expect(JSON.stringify(events)).not.toContain(implementer.sessionToken);
  });

  it("records session pings and permission-needed events through the CLI", async () => {
    const coordinator = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Coordinator",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd
      ])
    );
    const worker = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Worker",
        "--client-type",
        "claude-code",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd
      ])
    );

    const ping = parseJson<{ eventType: string; sessionUid: string }>(
      await runCli([
        "ping-session",
        "--db",
        dbPath,
        "--target-session-uid",
        worker.sessionUid,
        "--actor-session-uid",
        coordinator.sessionUid,
        "--message",
        "Check the inbox when active."
      ])
    );
    const awaitingSession = parseJson<{ status: string; statusDetail: string }>(
      await runCli([
        "session-permission-request",
        "--db",
        dbPath,
        "--session-uid",
        worker.sessionUid,
        "--session-token",
        worker.sessionToken,
        "--question",
        "Allow filesystem write?",
        "--requested-capability",
        "filesystem-write",
        "--command-preview",
        "npm run build",
        "--source",
        "claude-code"
      ])
    );
    const handoff = parseJson<{ handoffUid: string }>(
      await runCli([
        "publish",
        "--db",
        dbPath,
        "--short-prompt",
        "Needs permission",
        "--source-project",
        "Vault Collab",
        "--target-project",
        "Vault Collab"
      ])
    );
    await runCli([
      "claim",
      "--db",
      dbPath,
      "--handoff-uid",
      handoff.handoffUid,
      "--session-uid",
      worker.sessionUid,
      "--session-token",
      worker.sessionToken
    ]);
    const awaitingHandoff = parseJson<{ status: string; progressNote: string }>(
      await runCli([
        "handoff-permission-request",
        "--db",
        dbPath,
        "--handoff-uid",
        handoff.handoffUid,
        "--session-uid",
        worker.sessionUid,
        "--session-token",
        worker.sessionToken,
        "--question",
        "Allow network access?",
        "--requested-capability",
        "network",
        "--command-preview",
        "git push origin main",
        "--source",
        "claude-code"
      ])
    );
    const permissionEvents = parseJson<Array<{ eventType: string }>>(
      await runCli([
        "events",
        "--db",
        dbPath,
        "--session-uid",
        worker.sessionUid,
        "--event-type",
        "session.permission_requested"
      ])
    );
    const attention = parseJson<{
      session: { sessionUid: string };
      items: Array<{ kind: string }>;
    }>(await runCli(["attention", "--db", dbPath, "--session-uid", worker.sessionUid]));

    expect(ping).toMatchObject({
      eventType: "session.pinged",
      sessionUid: worker.sessionUid
    });
    const busyPing = await runCli([
      "ping-session",
      "--db",
      dbPath,
      "--target-session-uid",
      worker.sessionUid,
      "--actor-session-uid",
      coordinator.sessionUid,
      "--message",
      "This should not interrupt an awaiting_user session."
    ]);
    expect(busyPing.exitCode).toBe(1);
    expect(busyPing.stderr).toMatch(/only ping idle sessions/i);
    expect(awaitingSession).toMatchObject({
      status: "awaiting_user",
      statusDetail: "Allow filesystem write?"
    });
    expect(awaitingHandoff).toMatchObject({
      status: "awaiting_user",
      progressNote: "Allow network access?"
    });
    expect(permissionEvents.map((event) => event.eventType)).toEqual([
      "session.permission_requested"
    ]);
    expect(attention.session.sessionUid).toBe(worker.sessionUid);
    expect(attention.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["session_ping", "session_permission", "handoff_permission"])
    );
    expect(JSON.stringify(permissionEvents)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(attention)).not.toContain(worker.sessionToken);
  });

  it("runs the agent, queue, and discussion workflow through flat JSON commands", async () => {
    const roles = parseJson<Array<{ role: string }>>(await runCli(["roles", "--db", dbPath]));
    expect(roles.map((role) => role.role)).toEqual([
      "coordinator",
      "implementer",
      "reviewer",
      "sweeper",
      "observer"
    ]);

    const reviewer = parseJson<{ agentUid: string; clientType: string }>(
      await runCli([
        "agent-upsert",
        "--db",
        dbPath,
        "--stable-name",
        "claude-reviewer",
        "--display-name",
        "Claude Reviewer",
        "--role",
        "reviewer",
        "--client-type",
        "claude-code",
        "--project",
        "Vault Collab",
        "--capability",
        "review=true"
      ])
    );
    const implementer = parseJson<{ agentUid: string; clientType: string }>(
      await runCli([
        "agent-upsert",
        "--db",
        dbPath,
        "--stable-name",
        "opencode-implementer",
        "--display-name",
        "OpenCode Implementer",
        "--role",
        "implementer",
        "--client-type",
        "opencode",
        "--project",
        "Vault Collab"
      ])
    );

    expect(reviewer.clientType).toBe("claude-code");
    expect(implementer.clientType).toBe("opencode");

    const agents = parseJson<Array<{ agentUid: string; stableName: string }>>(
      await runCli(["agents", "--db", dbPath, "--project", "Vault Collab"])
    );
    expect(agents.map((agent) => agent.stableName)).toEqual([
      "claude-reviewer",
      "opencode-implementer"
    ]);

    const claude = parseJson<{ sessionUid: string; sessionToken: string; agentUid: string }>(
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
        "--agent-uid",
        reviewer.agentUid
      ])
    );
    const opencode = parseJson<{ sessionUid: string; sessionToken: string; agentUid: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "OpenCode",
        "--client-type",
        "opencode",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--agent-uid",
        implementer.agentUid
      ])
    );

    expect(claude.agentUid).toBe(reviewer.agentUid);
    expect(opencode.agentUid).toBe(implementer.agentUid);

    const published = parseJson<{
      handoffUid: string;
      queueKey: string;
      labels: string[];
      queuePosition: number;
    }>(
      await runCli([
        "publish",
        "--db",
        dbPath,
        "--short-prompt",
        "Discuss CLI contract.",
        "--source-project",
        "Vault Collab",
        "--target-project",
        "Vault Collab",
        "--source-session-uid",
        claude.sessionUid,
        "--queue-key",
        "phase-1",
        "--queue-position",
        "500",
        "--label",
        "cli",
        "--label",
        "discussion"
      ])
    );

    expect(published).toMatchObject({
      queueKey: "phase-1",
      labels: ["cli", "discussion"],
      queuePosition: 500
    });

    const metadata = parseJson<{ labels: string[]; dependsOnHandoffUid: string }>(
      await runCli([
        "handoff-metadata",
        "--db",
        dbPath,
        "--handoff-uid",
        published.handoffUid,
        "--session-uid",
        claude.sessionUid,
        "--session-token",
        claude.sessionToken,
        "--label",
        "cli",
        "--label",
        "reviewed",
        "--depends-on-handoff-uid",
        "vc_handoff_previous"
      ])
    );
    expect(metadata).toMatchObject({
      labels: ["cli", "reviewed"],
      dependsOnHandoffUid: "vc_handoff_previous"
    });

    const badCreate = await runCli([
      "discussion-create",
      "--db",
      dbPath,
      "--project",
      "Vault Collab",
      "--handoff-uid",
      published.handoffUid,
      "--title",
      "Bad token",
      "--session-uid",
      claude.sessionUid,
      "--session-token",
      "bad-token"
    ]);
    expect(badCreate.exitCode).toBe(1);
    expect(badCreate.stderr).toMatch(/invalid session token/i);
    expect(badCreate.stderr).not.toContain("bad-token");

    const thread = parseJson<{ threadUid: string }>(
      await runCli([
        "discussion-create",
        "--db",
        dbPath,
        "--project",
        "Vault Collab",
        "--handoff-uid",
        published.handoffUid,
        "--title",
        "CLI contract discussion",
        "--session-uid",
        claude.sessionUid,
        "--session-token",
        claude.sessionToken
      ])
    );

    await runCli([
      "discussion-add-message",
      "--db",
      dbPath,
      "--thread-uid",
      thread.threadUid,
      "--session-uid",
      opencode.sessionUid,
      "--session-token",
      opencode.sessionToken,
      "--type",
      "proposal",
      "--body",
      "Keep CLI commands flat and provider-neutral.",
      "--metadata",
      "source=cli-test"
    ]);

    const threads = parseJson<Array<{ threadUid: string; messageCount: number }>>(
      await runCli([
        "discussions",
        "--db",
        dbPath,
        "--project",
        "Vault Collab",
        "--handoff-uid",
        published.handoffUid
      ])
    );
    const detail = parseJson<{
      messages: Array<{ sessionUid: string; agentUid: string | null; metadata: Record<string, unknown> }>;
    }>(await runCli(["discussion", "--db", dbPath, "--thread-uid", thread.threadUid]));

    expect(threads).toEqual([
      expect.objectContaining({
        threadUid: thread.threadUid,
        messageCount: 1
      })
    ]);
    expect(detail.messages).toEqual([
      expect.objectContaining({
        sessionUid: opencode.sessionUid,
        agentUid: implementer.agentUid,
        metadata: {
          source: "cli-test"
        }
      })
    ]);
    expect(JSON.stringify(agents)).not.toContain(claude.sessionToken);
    expect(JSON.stringify(threads)).not.toContain(opencode.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(claude.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(opencode.sessionToken);
  });

  it("rejects unknown commands without creating a destructive escape hatch", async () => {
    const result = await runCli(["clean", "--db", dbPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/unknown command/i);
  });
});
