import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { createCollabDatabase } from "../src/database/connection.js";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  it("prints a provider-neutral agent guide without requiring a database", async () => {
    const guide = parseJson<{
      title: string;
      clientType: string | null;
      project: string | null;
      projectKey: string | null;
      loop: string[];
      attentionItems: Record<string, string>;
      safetyRules: string[];
    }>(await runCli(["guide", "--client-type", "gemini", "--project", "Vault Collab"]));

    const loopText = guide.loop.join("\n");
    const safetyText = guide.safetyRules.join("\n");

    expect(guide).toMatchObject({
      title: "Vault Collab provider-neutral agent operating guide",
      clientType: "gemini",
      project: "Vault Collab",
      projectKey: "vault-collab"
    });
    expect(loopText).toMatch(/vault_collab_register_session|register/);
    expect(loopText).toMatch(/vault_collab_get_session_attention|attention/);
    expect(loopText).toMatch(/watch-attention/);
    expect(loopText).toMatch(/receive --wait|vault_collab_receive/);
    expect(loopText).toMatch(/pull|drain/i);
    expect(loopText).toMatch(/vault_collab_get_handoff_detail|handoff/);
    expect(loopText).toMatch(/coordinator/i);
    expect(loopText).toMatch(/managed/i);
    expect(loopText).toMatch(/worker/i);
    expect(guide.attentionItems).toHaveProperty("suggested_handoff");
    expect(safetyText).toMatch(/Do not auto-claim/i);
    expect(safetyText).toMatch(/Do not use vault_collab_list_inbox alone/i);
    expect(safetyText).toMatch(/manual coordinator/i);
    expect(safetyText).toMatch(/worker wakeable/i);
    expect(JSON.stringify(guide)).not.toContain("sessionToken");
  });

  it("runs the session and handoff smoke workflow through JSON commands", async () => {
    const codex = parseJson<{
      sessionUid: string;
      sessionToken: string;
      nextActions: Array<{ tool: string; args: { sessionUid: string; includeCurrentHandoffs: boolean } }>;
    }>(
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
    expect(codex.nextActions).toEqual([
      {
        tool: "vault_collab_get_session_attention",
        args: {
          sessionUid: codex.sessionUid,
          includeCurrentHandoffs: true
        },
        reason: "Discover pings, permission requests, suggested handoffs, claimed work, and available project handoffs for this active session."
      }
    ]);
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

    const handoffActions = parseJson<{
      handoff: { handoffUid: string; status: string };
      actingSessionUid: string;
      actions: Array<{ kind: string; enabled: boolean; toolName: string }>;
    }>(
      await runCli([
        "handoff-actions",
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

    expect(handoffActions).toMatchObject({
      handoff: {
        handoffUid: published.handoffUid,
        status: "claimed"
      },
      actingSessionUid: claude.sessionUid
    });
    expect(handoffActions.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "update",
          enabled: true,
          toolName: "vault_collab_update_handoff"
        }),
        expect.objectContaining({
          kind: "release",
          enabled: true,
          toolName: "vault_collab_release_handoff"
        })
      ])
    );
    expect(JSON.stringify(handoffActions)).not.toContain(claude.sessionToken);

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
        cwd,
        "--capability",
        "launchRequests=true"
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
        cwd,
        "--capability",
        "launchRequests=true"
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

  it("registers session delivery metadata from CLI flags", async () => {
    const session = parseJson<{
      delivery: {
        mode: string;
        wakeable: boolean;
        lastAckEventId: number | null;
        lastAckAt: string | null;
      };
    }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Managed Codex",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--delivery-mode",
        "managed_process",
        "--wakeable"
      ])
    );

    expect(session.delivery).toEqual({
      mode: "managed_process",
      wakeable: true,
      lastAckEventId: null,
      lastAckAt: null
    });
  });

  it("registers a first-class session role from CLI flags", async () => {
    const session = parseJson<{ role: string; agentRole: string | null }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Reviewer",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--role",
        "reviewer"
      ])
    );

    expect(session).toMatchObject({
      role: "reviewer",
      agentRole: null
    });
  });

  it("acknowledges attention through the CLI without leaking tokens", async () => {
    const session = parseJson<{
      sessionUid: string;
      sessionToken: string;
    }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Watched Codex",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--delivery-mode",
        "local_watch"
      ])
    );

    const acknowledged = parseJson<{
      delivery: {
        mode: string;
        wakeable: boolean;
        lastAckEventId: number | null;
        lastAckAt: string | null;
      };
    }>(
      await runCli([
        "attention-ack",
        "--db",
        dbPath,
        "--session-uid",
        session.sessionUid,
        "--session-token",
        session.sessionToken,
        "--latest-event-id",
        "42"
      ])
    );
    const events = parseJson<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await runCli(["events", "--db", dbPath, "--session-uid", session.sessionUid])
    );

    expect(acknowledged.delivery).toMatchObject({
      mode: "local_watch",
      wakeable: false,
      lastAckEventId: 42
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "session.registered",
      "session.attention_acknowledged"
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      latestEventId: 42
    });
    expect(JSON.stringify(acknowledged)).not.toContain(session.sessionToken);
    expect(JSON.stringify(events)).not.toContain(session.sessionToken);
  });

  it("renames and closes roster sessions through the CLI without leaking tokens", async () => {
    const admin = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Dashboard Admin",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--capability",
        "sessionAdmin=true"
      ])
    );
    const worker = parseJson<{ sessionUid: string; sessionToken: string }>(
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
        cwd
      ])
    );

    const renamed = parseJson<{ displayName: string; sessionToken?: string }>(
      await runCli([
        "session-rename",
        "--db",
        dbPath,
        "--session-uid",
        worker.sessionUid,
        "--session-token",
        worker.sessionToken,
        "--display-name",
        "Codex Receiver - terminal 2"
      ])
    );
    const closed = parseJson<{ status: string; statusDetail: string; sessionToken?: string }>(
      await runCli([
        "session-close",
        "--db",
        dbPath,
        "--target-session-uid",
        worker.sessionUid,
        "--actor-session-uid",
        admin.sessionUid,
        "--actor-session-token",
        admin.sessionToken,
        "--reason",
        "Closed from dashboard roster"
      ])
    );

    expect(renamed).toMatchObject({
      displayName: "Codex Receiver - terminal 2"
    });
    expect(closed).toMatchObject({
      status: "disconnected",
      statusDetail: "Closed from dashboard roster"
    });
    expect(renamed).not.toHaveProperty("sessionToken");
    expect(closed).not.toHaveProperty("sessionToken");
    expect(JSON.stringify({ renamed, closed })).not.toContain(worker.sessionToken);
    expect(JSON.stringify({ renamed, closed })).not.toContain(admin.sessionToken);
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
        cwd,
        "--capability",
        "launchRequests=true"
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

    const ping = parseJson<{
      event: { eventType: string; sessionUid: string };
      targetSession: { sessionUid: string; delivery: { mode: string; wakeable: boolean } };
      delivery: { mode: string; wakeable: boolean; delivered: boolean; nextStep: string };
    }>(
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
    const awaitingConfirmation = parseJson<{ status: string; progressNote: string }>(
      await runCli([
        "user-confirmation-request",
        "--db",
        dbPath,
        "--handoff-uid",
        handoff.handoffUid,
        "--session-uid",
        worker.sessionUid,
        "--session-token",
        worker.sessionToken,
        "--question",
        "Should I continue?"
      ])
    );
    await runCli([
      "update",
      "--db",
      dbPath,
      "--handoff-uid",
      handoff.handoffUid,
      "--session-uid",
      worker.sessionUid,
      "--session-token",
      worker.sessionToken,
      "--status",
      "in_progress",
      "--progress-note",
      "Resumed after user confirmation request"
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
      event: {
        eventType: "session.pinged",
        sessionUid: worker.sessionUid
      },
      targetSession: {
        sessionUid: worker.sessionUid,
        delivery: {
          mode: "manual_poll",
          wakeable: false
        }
      },
      delivery: {
        mode: "manual_poll",
        wakeable: false,
        delivered: false,
        nextStep: "Target session must poll attention manually or run a watcher."
      }
    });
    expect(JSON.stringify(ping)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(ping)).not.toContain(coordinator.sessionToken);
    const busyPing = parseJson<{ event: { eventType: string; sessionUid: string } }>(await runCli([
      "ping-session",
      "--db",
      dbPath,
      "--target-session-uid",
      worker.sessionUid,
      "--actor-session-uid",
      coordinator.sessionUid,
      "--message",
      "This should not interrupt an awaiting_user session."
    ]));
    expect(busyPing).toMatchObject({
      event: {
        eventType: "session.pinged",
        sessionUid: worker.sessionUid
      }
    });
    expect(awaitingSession).toMatchObject({
      status: "awaiting_user",
      statusDetail: "Allow filesystem write?"
    });
    expect(awaitingConfirmation).toMatchObject({
      status: "awaiting_user",
      progressNote: "Should I continue?"
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

  it("watch-attention notices a targeted idle handoff and returns a manual claim instruction", async () => {
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
        "Idle Worker",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd
      ])
    );

    const watchPromise = runCli([
      "watch-attention",
      "--db",
      dbPath,
      "--session-uid",
      worker.sessionUid,
      "--interval-ms",
      "20",
      "--timeout-ms",
      "1000"
    ]);
    await delay(40);
    const handoff = parseJson<{ handoffUid: string }>(
      await runCli([
        "publish",
        "--db",
        dbPath,
        "--short-prompt",
        "Targeted idle work",
        "--source-project",
        "Vault Collab",
        "--target-project",
        "Vault Collab",
        "--source-session-uid",
        coordinator.sessionUid,
        "--suggested-session-uid",
        worker.sessionUid
      ])
    );

    const watched = parseJson<{
      timedOut: boolean;
      attention: {
        session: { sessionUid: string; status: string };
        items: Array<{ kind: string; handoff: { handoffUid: string } | null }>;
      };
      recommendedActions: Array<{
        kind: string;
        handoffUid?: string;
        command?: string;
        reason: string;
      }>;
    }>(await watchPromise);

    expect(watched.timedOut).toBe(false);
    expect(watched.attention.session).toMatchObject({
      sessionUid: worker.sessionUid,
      status: "idle"
    });
    expect(
      watched.attention.items.find(
        (item) => item.kind === "suggested_handoff" && item.handoff?.handoffUid === handoff.handoffUid
      )
    ).toBeDefined();
    expect(watched.recommendedActions).toContainEqual(
      expect.objectContaining({
        kind: "claim_handoff",
        handoffUid: handoff.handoffUid,
        command: expect.stringContaining(`claim --db ${dbPath}`)
      })
    );
    expect(JSON.stringify(watched)).not.toContain(worker.sessionToken);
  });

  it("watch-attention does not auto-claim or interrupt a busy session", async () => {
    const coordinator = parseJson<{ sessionUid: string }>(
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
        "Busy Worker",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd
      ])
    );
    await runCli([
      "state",
      "--db",
      dbPath,
      "--session-uid",
      worker.sessionUid,
      "--session-token",
      worker.sessionToken,
      "--status",
      "working",
      "--detail",
      "Already handling work"
    ]);
    const handoff = parseJson<{ handoffUid: string }>(
      await runCli([
        "publish",
        "--db",
        dbPath,
        "--short-prompt",
        "Do not interrupt",
        "--source-project",
        "Vault Collab",
        "--target-project",
        "Vault Collab",
        "--source-session-uid",
        coordinator.sessionUid,
        "--suggested-session-uid",
        worker.sessionUid
      ])
    );

    const watched = parseJson<{
      timedOut: boolean;
      attention: { session: { status: string } };
      recommendedActions: Array<{ kind: string; handoffUid?: string }>;
    }>(
      await runCli([
        "watch-attention",
        "--db",
        dbPath,
        "--session-uid",
        worker.sessionUid,
        "--interval-ms",
        "20",
        "--timeout-ms",
        "200"
      ])
    );
    const refreshedHandoff = parseJson<{
      handoff: { status: string; claimedBySessionUid: string | null };
    }>(await runCli(["handoff", "--db", dbPath, "--handoff-uid", handoff.handoffUid]));
    const refreshedWorker = parseJson<Array<{ sessionUid: string; status: string }>>(
      await runCli(["sessions", "--db", dbPath, "--project", "Vault Collab"])
    ).find((session) => session.sessionUid === worker.sessionUid);

    expect(watched.timedOut).toBe(false);
    expect(watched.attention.session.status).toBe("working");
    expect(watched.recommendedActions).toContainEqual(
      expect.objectContaining({
        kind: "defer_claim_until_idle",
        handoffUid: handoff.handoffUid
      })
    );
    expect(refreshedHandoff.handoff).toMatchObject({
      status: "available",
      claimedBySessionUid: null
    });
    expect(refreshedWorker).toMatchObject({
      status: "working"
    });
  });

  it("receive-attention delivers through stdout and acknowledges managed attention", async () => {
    const worker = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Managed Receiver",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--delivery-mode",
        "managed_process",
        "--wakeable"
      ])
    );

    const receivePromise = runCli([
      "receive-attention",
      "--db",
      dbPath,
      "--session-uid",
      worker.sessionUid,
      "--session-token",
      worker.sessionToken,
      "--interval-ms",
      "20",
      "--timeout-ms",
      "1000"
    ]);
    await delay(40);
    const ping = parseJson<{ event: { eventId: number } }>(
      await runCli([
        "ping-session",
        "--db",
        dbPath,
        "--target-session-uid",
        worker.sessionUid,
        "--message",
        "Wake the managed receiver."
      ])
    );

    const received = parseJson<{
      timedOut: boolean;
      attempt: {
        status: string;
        toEventId: number;
        deliveredAt: string | null;
      } | null;
      deliveredMessage: string | null;
      session: {
        delivery: {
          lastAckEventId: number | null;
          lastAckAt: string | null;
        };
      };
    }>(await receivePromise);

    expect(received.timedOut).toBe(false);
    expect(received.attempt).toMatchObject({
      status: "delivered",
      toEventId: ping.event.eventId
    });
    expect(received.attempt?.deliveredAt).not.toBeNull();
    expect(received.deliveredMessage).toContain("session_ping");
    expect(received.deliveredMessage).toContain("Wake the managed receiver.");
    expect(received.session.delivery.lastAckEventId).toBe(ping.event.eventId);
    expect(received.session.delivery.lastAckAt).not.toBeNull();
    expect(JSON.stringify(received)).not.toContain(worker.sessionToken);

    const attempts = parseJson<
      Array<{
        attemptUid: string;
        sessionUid: string;
        status: string;
        toEventId: number;
        message: string | null;
      }>
    >(
      await runCli([
        "delivery-attempts",
        "--db",
        dbPath,
        "--session-uid",
        worker.sessionUid,
        "--status",
        "delivered"
      ])
    );

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attemptUid: received.attempt?.attemptUid,
      sessionUid: worker.sessionUid,
      status: "delivered",
      toEventId: ping.event.eventId,
      message: "Delivered to stdout adapter."
    });
    expect(JSON.stringify(attempts)).not.toContain(worker.sessionToken);
  });

  it("receives pull-based attention through the CLI and advances the cursor", async () => {
    const worker = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Pull Receiver",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd
      ])
    );

    const receivePromise = runCli([
      "receive",
      worker.sessionUid,
      "--db",
      dbPath,
      "--token",
      worker.sessionToken,
      "--wait",
      "--timeout",
      "1",
      "--interval-ms",
      "20",
      "--json"
    ]);
    await delay(40);
    const ping = parseJson<{ event: { eventId: number } }>(
      await runCli([
        "ping-session",
        "--db",
        dbPath,
        "--target-session-uid",
        worker.sessionUid,
        "--message",
        "Pull this from the CLI."
      ])
    );

    const received = parseJson<{
      fromEventId: number;
      toEventId: number;
      drained: boolean;
      items: Array<{ kind: string; event: { eventId: number } | null }>;
    }>(await receivePromise);
    const secondReceive = parseJson<{ items: unknown[] }>(
      await runCli([
        "receive",
        worker.sessionUid,
        "--db",
        dbPath,
        "--token",
        worker.sessionToken,
        "--json"
      ])
    );

    expect(received).toMatchObject({
      fromEventId: 0,
      toEventId: ping.event.eventId,
      drained: true
    });
    expect(received.items).toEqual([
      expect.objectContaining({
        kind: "session_ping",
        event: expect.objectContaining({
          eventId: ping.event.eventId
        })
      })
    ]);
    expect(secondReceive.items).toEqual([]);
    expect(JSON.stringify(received)).not.toContain(worker.sessionToken);
  });

  it("receive --wait --timeout returns promptly when no attention arrives", async () => {
    const worker = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Idle Pull Receiver",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd
      ])
    );
    const startedAt = Date.now();

    const received = parseJson<{ items: unknown[]; drained: boolean }>(
      await runCli([
        "receive",
        worker.sessionUid,
        "--db",
        dbPath,
        "--token",
        worker.sessionToken,
        "--wait",
        "--timeout",
        "1",
        "--interval-ms",
        "20",
        "--json"
      ])
    );

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(received).toMatchObject({
      items: [],
      drained: true
    });
  });

  it("sweeps expired handoff leases through the CLI", async () => {
    const worker = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Lease Owner",
        "--client-type",
        "codex",
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
        "Sweep from CLI",
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
    const db = createCollabDatabase(dbPath);
    db.prepare("UPDATE handoffs SET lease_expires_at = ? WHERE handoff_uid = ?").run(
      "1970-01-01T00:00:00.000Z",
      handoff.handoffUid
    );
    db.close();

    const swept = parseJson<{ released: string[]; count: number }>(
      await runCli(["sweep-leases", "--db", dbPath])
    );
    const leaseEvents = parseJson<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await runCli(["events", "--db", dbPath, "--event-type", "handoff.lease_expired"])
    );

    expect(swept).toEqual({
      released: [handoff.handoffUid],
      count: 1
    });
    expect(leaseEvents).toEqual([
      expect.objectContaining({
        eventType: "handoff.lease_expired",
        payload: expect.objectContaining({
          priorClaimedBySessionUid: worker.sessionUid,
          reason: "lease_expired"
        })
      })
    ]);
  });

  it("runs the launch-request broker lifecycle through flat JSON commands", async () => {
    const requester = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Operator",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--capability",
        "launchRequests=true"
      ])
    );
    const approver = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Approver",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--capability",
        "launchApproval=true"
      ])
    );
    const broker = parseJson<{ sessionUid: string; sessionToken: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Local Broker",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--capability",
        "launchBroker=true"
      ])
    );

    const request = parseJson<{ launchRequestUid: string; status: string }>(
      await runCli([
        "launch-create",
        "--db",
        dbPath,
        "--session-uid",
        requester.sessionUid,
        "--session-token",
        requester.sessionToken,
        "--provider",
        "codex",
        "--model",
        "gpt-5-codex",
        "--effort-level",
        "high",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--role",
        "implementer",
        "--initial-instructions",
        "Implement the broker foundation.",
        "--permission-mode",
        "workspace-write",
        "--command-preview",
        "codex --model gpt-5-codex",
        "--requested-capability",
        "filesystem-write",
        "--approval-policy-version",
        "cockpit-v2.0",
        "--metadata",
        "source=cli-test"
      ])
    );
    expect(request.status).toBe("requested");

    const launches = parseJson<Array<{ launchRequestUid: string }>>(
      await runCli([
        "launches",
        "--db",
        dbPath,
        "--project",
        "vault-collab",
        "--status",
        "requested"
      ])
    );
    expect(launches.map((launch) => launch.launchRequestUid)).toEqual([
      request.launchRequestUid
    ]);

    const requesterActions = parseJson<{
      actions: Array<{ kind: string; enabled: boolean; toolName: string }>;
    }>(
      await runCli([
        "launch-actions",
        "--db",
        dbPath,
        "--launch-request-uid",
        request.launchRequestUid,
        "--session-uid",
        requester.sessionUid,
        "--session-token",
        requester.sessionToken
      ])
    );
    const approverActions = parseJson<{
      actions: Array<{ kind: string; enabled: boolean; toolName: string }>;
    }>(
      await runCli([
        "launch-actions",
        "--db",
        dbPath,
        "--launch-request-uid",
        request.launchRequestUid,
        "--session-uid",
        approver.sessionUid,
        "--session-token",
        approver.sessionToken
      ])
    );

    expect(requesterActions.actions).toContainEqual(
      expect.objectContaining({
        kind: "cancel",
        enabled: true,
        toolName: "vault_collab_cancel_launch_request"
      })
    );
    expect(requesterActions.actions).toContainEqual(
      expect.objectContaining({
        kind: "approve",
        enabled: false
      })
    );
    expect(approverActions.actions).toContainEqual(
      expect.objectContaining({
        kind: "approve",
        enabled: true,
        toolName: "vault_collab_approve_launch_request"
      })
    );
    expect(JSON.stringify(approverActions)).not.toContain(approver.sessionToken);

    const denied = await runCli([
      "launch-approve",
      "--db",
      dbPath,
      "--launch-request-uid",
      request.launchRequestUid,
      "--session-uid",
      requester.sessionUid,
      "--session-token",
      requester.sessionToken,
      "--detail",
      "Requester should not self-approve."
    ]);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toMatch(/launch approval capability/i);
    expect(denied.stderr).not.toContain(requester.sessionToken);

    const approved = parseJson<{ status: string; approvedBySessionUid: string }>(
      await runCli([
        "launch-approve",
        "--db",
        dbPath,
        "--launch-request-uid",
        request.launchRequestUid,
        "--session-uid",
        approver.sessionUid,
        "--session-token",
        approver.sessionToken,
        "--detail",
        "Approved for broker pickup."
      ])
    );
    expect(approved).toMatchObject({
      status: "approved",
      approvedBySessionUid: approver.sessionUid
    });

    await runCli([
      "launch-mark-launching",
      "--db",
      dbPath,
      "--launch-request-uid",
      request.launchRequestUid,
      "--session-uid",
      broker.sessionUid,
      "--session-token",
      broker.sessionToken,
      "--detail",
      "Broker accepted request."
    ]);
    const launched = parseJson<{ sessionUid: string }>(
      await runCli([
        "register",
        "--db",
        dbPath,
        "--display-name",
        "Launched Codex",
        "--client-type",
        "codex",
        "--project",
        "Vault Collab",
        "--workspace-path",
        cwd,
        "--capability",
        `launchedBy=${request.launchRequestUid}`
      ])
    );
    const running = parseJson<{ status: string; launchedSessionUid: string }>(
      await runCli([
        "launch-mark-running",
        "--db",
        dbPath,
        "--launch-request-uid",
        request.launchRequestUid,
        "--session-uid",
        broker.sessionUid,
        "--session-token",
        broker.sessionToken,
        "--launched-session-uid",
        launched.sessionUid,
        "--detail",
        "Launched session registered."
      ])
    );
    const stopped = parseJson<{ status: string; completedAt: string | null; metadata: Record<string, unknown> }>(
      await runCli([
        "launch-stop",
        "--db",
        dbPath,
        "--launch-request-uid",
        request.launchRequestUid,
        "--session-uid",
        broker.sessionUid,
        "--session-token",
        broker.sessionToken,
        "--detail",
        "Dashboard stopped the managed worker.",
        "--exit-code",
        "0"
      ])
    );
    const got = parseJson<{ status: string; sessionToken?: string }>(
      await runCli([
        "launch",
        "--db",
        dbPath,
        "--launch-request-uid",
        request.launchRequestUid
      ])
    );
    const detail = parseJson<{
      launchRequest: { launchRequestUid: string; status: string };
      events: Array<{ eventType: string }>;
    }>(
      await runCli([
        "launch-detail",
        "--db",
        dbPath,
        "--launch-request-uid",
        request.launchRequestUid
      ])
    );

    expect(running).toMatchObject({
      status: "running",
      launchedSessionUid: launched.sessionUid
    });
    expect(stopped).toMatchObject({
      status: "stopped",
      completedAt: expect.any(String),
      metadata: {
        source: "cli-test",
        stopped: {
          detail: "Dashboard stopped the managed worker.",
          exitCode: 0,
          brokerSessionUid: broker.sessionUid
        }
      }
    });
    expect(got.status).toBe("stopped");
    expect(detail.launchRequest).toMatchObject({
      launchRequestUid: request.launchRequestUid,
      status: "stopped"
    });
    expect(detail.events.map((event) => event.eventType)).toEqual([
      "launch_request.requested",
      "launch_request.approved",
      "launch_request.launching",
      "launch_request.running",
      "launch_request.stopped"
    ]);
    expect(JSON.stringify(got)).not.toContain(approver.sessionToken);
    expect(JSON.stringify(got)).not.toContain(broker.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(approver.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(broker.sessionToken);
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
