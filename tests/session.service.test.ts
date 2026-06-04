import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { AgentProfileService } from "../src/services/agent-profile.service.js";
import { EventService } from "../src/services/event.service.js";
import { HandoffService } from "../src/services/handoff.service.js";
import { LaunchRequestService } from "../src/services/launch-request.service.js";
import { SessionService } from "../src/services/session.service.js";

const workspacePath = "C:\\workspace\\vault-collab";
const adapterSecret = "phase-7-adapter-secret";

function validSessionSnapshot(
  sessionUid: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: "vault_collab.session.v1",
    adapterId: "codex-local:test",
    sessionUid,
    project: "Vault Collab",
    workspace: {
      path: workspacePath,
      projectKey: "vault-collab"
    },
    state: "working",
    context: {
      model: "gpt-5-codex",
      provider: "codex",
      tokensUsed: 86000,
      tokensRemaining: 14000,
      compactionRisk: "medium"
    },
    active_handoffs: [
      {
        handoffUid: "vc_handoff_phase_7",
        status: "in_progress",
        progressNote: "Implementing report_session.",
        claimedAt: "2026-06-04T09:52:45.000Z"
      }
    ],
    progress: {
      currentTask: "Implement Phase 7",
      percentComplete: 40,
      blockers: []
    },
    cost: {
      estimatedUSD: 1.25,
      tokensTotal: 100000
    },
    risk: {
      level: "low",
      reasons: []
    },
    tool_grants: [
      {
        toolName: "vault_collab_report_session",
        scope: "coordination_write",
        grantedAt: "2026-06-04T09:52:45.000Z"
      }
    ],
    capabilities: {
      canMutateHandoffs: false,
      canPublishHandoffs: false,
      canSendMessages: true,
      adapterType: "adapter_backed"
    },
    sync_cursor: {
      lastEventId: 5772,
      lastHeartbeatAt: "2026-06-04T09:52:45.000Z"
    },
    ...overrides
  };
}

function deriveAdapterToken(secret: string, sessionUid: string, adapterId: string): string {
  return createHmac("sha256", secret)
    .update(`${sessionUid}\0${adapterId}`)
    .digest("base64url");
}

describe("SessionService", () => {
  let db: CollabDatabase;
  let now: Date;
  let events: EventService;
  let agents: AgentProfileService;
  let service: SessionService;
  let handoffs: HandoffService;

  beforeEach(() => {
    now = new Date("2026-05-28T10:00:00.000Z");
    db = createCollabDatabase(":memory:");
    const clock = () => now;
    events = new EventService(db, clock);
    agents = new AgentProfileService(db, events, clock);
    const launchRequests = new LaunchRequestService(db, events, clock);
    service = new SessionService(db, events, launchRequests, clock);
    handoffs = new HandoffService(db, events, clock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
  });

  it("registers a provider-neutral session and exposes it without leaking its token", () => {
    const registered = service.registerSession({
      displayName: "Codex terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        handoffs: true,
        maxConcurrentHandoffs: 1
      }
    });

    expect(registered.sessionUid).toMatch(/^vc_sess_/);
    expect(registered.sessionToken).toHaveLength(43);
    expect(registered.status).toBe("idle");
    expect(registered.capabilities).toMatchObject({
      edit_files: true,
      handoffs: true,
      maxConcurrentHandoffs: 1,
      read_files: true,
      run_tests: true,
      search_files: true,
      shell_commands: true,
      vault_collab_write: true,
      vault_memory_write: true
    });
    expect(registered.createdAt).toBe("2026-05-28T10:00:00.000Z");
    expect(registered.lastHeartbeatAt).toBe("2026-05-28T10:00:00.000Z");
    expect(registered).toMatchObject({
      adapterType: "native",
      lastSnapshot: null,
      snapshotReportedAt: null
    });

    const sessions = service.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionUid: registered.sessionUid,
      displayName: "Codex terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      status: "idle",
      statusDetail: null,
      role: "implementer",
      capabilities: {
        handoffs: true,
        maxConcurrentHandoffs: 1
      },
      disconnectedAt: null
    });
    expect(sessions[0]).toMatchObject({
      adapterType: "native",
      lastSnapshot: null,
      snapshotReportedAt: null
    });
    expect(sessions[0]).not.toHaveProperty("sessionToken");
  });

  it("round-trips a first-class custom session role", () => {
    const registered = service.registerSession({
      displayName: "Reviewer terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "reviewer",
      capabilities: {}
    });

    expect(registered.role).toBe("reviewer");
    expect(registered.roleProfileId).toBe("reviewer");
    expect(service.listSessions()[0]).toMatchObject({
      sessionUid: registered.sessionUid,
      role: "reviewer",
      roleProfileId: "reviewer"
    });
  });

  it("persists canonical role profile ids at session registration time", () => {
    const qaSession = service.registerSession({
      displayName: "QA terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "qa",
      capabilities: {}
    });
    const customSession = service.registerSession({
      displayName: "Custom terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "bespoke-runtime-role",
      capabilities: {}
    });

    expect(qaSession).toMatchObject({
      role: "qa",
      roleProfileId: "qa-evaluator"
    });
    expect(customSession).toMatchObject({
      role: "bespoke-runtime-role",
      roleProfileId: null
    });
    expect(service.listSessions({ project: "Vault Collab" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionUid: qaSession.sessionUid,
          roleProfileId: "qa-evaluator"
        }),
        expect.objectContaining({
          sessionUid: customSession.sessionUid,
          roleProfileId: null
        })
      ])
    );
    expect(db.prepare("SELECT role, role_profile_id FROM sessions WHERE session_uid = ?").get(qaSession.sessionUid))
      .toEqual({ role: "qa", role_profile_id: "qa-evaluator" });
  });

  it("rejects non-canonical explicit role profile ids with valid options", () => {
    expect(() =>
      service.registerSession({
        displayName: "Alias QA terminal",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath,
        role: "qa",
        roleProfileId: "qa-reviewer",
        capabilities: {}
      })
    ).toThrow(
      /Session roleProfileId must be one of the canonical role profile IDs: coordinator, explorer, planner, architect, implementer, reviewer, qa-evaluator, security-reviewer, documentation-agent, runtime-loop-operator, release-agent, pattern-mining-agent, loop-resolver/
    );

    const canonical = service.registerSession({
      displayName: "Canonical QA terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "qa",
      roleProfileId: "qa-evaluator",
      capabilities: {}
    });

    expect(canonical.roleProfileId).toBe("qa-evaluator");
  });

  it("still resolves common aliases from the session role label", () => {
    const qaReviewer = service.registerSession({
      displayName: "QA reviewer terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "qa-reviewer",
      capabilities: {}
    });
    const investigator = service.registerSession({
      displayName: "Investigator terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "investigator",
      capabilities: {}
    });
    const coder = service.registerSession({
      displayName: "Coder terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "coder",
      capabilities: {}
    });

    expect(qaReviewer.roleProfileId).toBe("qa-evaluator");
    expect(investigator.roleProfileId).toBe("explorer");
    expect(coder.roleProfileId).toBe("implementer");
  });

  it("defaults manually registered sessions to manual polling delivery", () => {
    const registered = service.registerSession({
      displayName: "Manual Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });

    expect(registered.delivery).toEqual({
      mode: "manual_poll",
      wakeable: false,
      lastAckEventId: null,
      lastAckAt: null
    });
    expect(service.listSessions()[0]?.delivery).toEqual({
      mode: "manual_poll",
      wakeable: false,
      lastAckEventId: null,
      lastAckAt: null
    });
  });

  it("persists declared managed process delivery metadata", () => {
    const registered = service.registerSession({
      displayName: "Managed Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {},
      delivery: {
        mode: "managed_process",
        wakeable: true
      }
    });

    expect(service.getSession(registered.sessionUid)?.delivery).toEqual({
      mode: "managed_process",
      wakeable: true,
      lastAckEventId: null,
      lastAckAt: null
    });
  });

  it("binds a session to a durable agent profile without leaking its token", () => {
    const agent = agents.upsertAgentProfile({
      stableName: "repo-coordinator",
      displayName: "Repo Coordinator",
      role: "coordinator",
      clientType: "codex",
      project: "Vault Collab",
      capabilities: {
        handoffs: true
      }
    });

    const registered = service.registerSession({
      displayName: "Codex terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        handoffs: true
      },
      agentUid: agent.agentUid
    });

    const sessions = service.listSessions();

    expect(registered).toMatchObject({
      agentUid: agent.agentUid,
      agentName: "repo-coordinator",
      agentDisplayName: "Repo Coordinator",
      agentRole: "coordinator"
    });
    expect(sessions[0]).toMatchObject({
      sessionUid: registered.sessionUid,
      agentUid: agent.agentUid,
      agentName: "repo-coordinator",
      agentDisplayName: "Repo Coordinator",
      agentRole: "coordinator"
    });
    expect(sessions[0]).not.toHaveProperty("sessionToken");
  });

  it("records heartbeats only when the caller presents the owning token", () => {
    const registered = service.registerSession({
      displayName: "Claude Code",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    now = new Date("2026-05-28T10:00:30.000Z");

    const heartbeat = service.heartbeatSession(registered.sessionUid, registered.sessionToken);

    expect(heartbeat.lastHeartbeatAt).toBe("2026-05-28T10:00:30.000Z");
    expect(service.listSessions()[0].lastHeartbeatAt).toBe("2026-05-28T10:00:30.000Z");
    expect(() => service.heartbeatSession(registered.sessionUid, "wrong-token")).toThrow(
      /invalid session token/i
    );
  });

  it("refreshes leases of claimed handoffs on heartbeat", () => {
    const registered = service.registerSession({
      displayName: "Claude Code",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Heartbeat lease",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, registered.sessionUid, registered.sessionToken);
    const firstLease = handoffs.getHandoff(handoff.handoffUid)?.leaseExpiresAt;

    now = new Date("2026-05-28T10:01:00.000Z");
    service.heartbeatSession(registered.sessionUid, registered.sessionToken);

    const secondLease = handoffs.getHandoff(handoff.handoffUid)?.leaseExpiresAt;
    expect(new Date(secondLease!).getTime()).toBeGreaterThan(
      new Date(firstLease!).getTime()
    );
  });

  it("can update heartbeat silently without recording an event", () => {
    const registered = service.registerSession({
      displayName: "Claude Code",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    now = new Date("2026-05-28T10:00:30.000Z");

    const heartbeat = service.heartbeatSessionSilently(
      registered.sessionUid,
      registered.sessionToken
    );

    expect(heartbeat.lastHeartbeatAt).toBe("2026-05-28T10:00:30.000Z");
    expect(service.listSessions()[0].lastHeartbeatAt).toBe("2026-05-28T10:00:30.000Z");

    const events = db
      .prepare("SELECT event_type FROM events WHERE session_uid = ? ORDER BY created_at ASC")
      .all(registered.sessionUid) as Array<{ event_type: string }>;

    expect(events.map((event) => event.event_type)).toEqual(["session.registered"]);
  });

  it("acknowledges attention with the owning session token", () => {
    const registered = service.registerSession({
      displayName: "Watched Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {},
      delivery: {
        mode: "local_watch",
        wakeable: false
      }
    });
    now = new Date("2026-05-28T10:00:45.000Z");

    const acknowledged = service.acknowledgeAttention(
      registered.sessionUid,
      registered.sessionToken,
      42
    );

    expect(acknowledged.delivery).toEqual({
      mode: "local_watch",
      wakeable: false,
      lastAckEventId: 42,
      lastAckAt: "2026-05-28T10:00:45.000Z"
    });
    expect(acknowledged.updatedAt).toBe("2026-05-28T10:00:45.000Z");
    expect(() =>
      service.acknowledgeAttention(registered.sessionUid, "wrong-token", 43)
    ).toThrow(/invalid session token/i);

    const events = db
      .prepare(
        "SELECT event_type, payload_json FROM events WHERE session_uid = ? ORDER BY event_id ASC"
      )
      .all(registered.sessionUid) as Array<{ event_type: string; payload_json: string }>;

    expect(events.map((event) => event.event_type)).toEqual([
      "session.registered",
      "session.attention_acknowledged"
    ]);
    expect(JSON.parse(events[1].payload_json)).toEqual({
      latestEventId: 42,
      acknowledgedAt: "2026-05-28T10:00:45.000Z"
    });
    expect(JSON.stringify(events)).not.toContain(registered.sessionToken);
  });

  it("updates session state with status detail for the owning session", () => {
    const registered = service.registerSession({
      displayName: "Claude Desktop",
      clientType: "claude-desktop",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    now = new Date("2026-05-28T10:01:00.000Z");

    const updated = service.updateSessionState(
      registered.sessionUid,
      registered.sessionToken,
      "working",
      "Implementing session service"
    );

    expect(updated.status).toBe("working");
    expect(updated.statusDetail).toBe("Implementing session service");
    expect(updated.updatedAt).toBe("2026-05-28T10:01:00.000Z");
    expect(service.listSessions({ status: "working" })).toHaveLength(1);
    expect(() =>
      service.updateSessionState(registered.sessionUid, "wrong-token", "blocked", "not owner")
    ).toThrow(/invalid session token/i);
  });

  it("records soft session pings without changing session state", () => {
    const actor = service.registerSession({
      displayName: "Coordinator",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const target = service.registerSession({
      displayName: "Idle worker",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    now = new Date("2026-05-28T10:01:30.000Z");

    const result = service.pingSession(target.sessionUid, {
      actorSessionUid: actor.sessionUid,
      message: "Please check the inbox when active."
    });

    expect(result.event).toMatchObject({
      eventType: "session.pinged",
      sessionUid: target.sessionUid,
      payload: {
        actorSessionUid: actor.sessionUid,
        message: "Please check the inbox when active.",
        createdAt: "2026-05-28T10:01:30.000Z"
      }
    });
    expect(result.targetSession).toMatchObject({
      sessionUid: target.sessionUid,
      delivery: {
        mode: "manual_poll",
        wakeable: false,
        lastAckEventId: null,
        lastAckAt: null
      }
    });
    expect(result.delivery).toEqual({
      mode: "manual_poll",
      wakeable: false,
      delivered: false,
      nextStep: "Target session must poll attention manually or run a watcher."
    });
    expect(service.getSession(target.sessionUid)).toMatchObject({
      status: "idle",
      statusDetail: null
    });
    expect(events.listEvents({ sessionUid: target.sessionUid, eventType: "session.pinged" })).toEqual([
      result.event
    ]);
    expect(JSON.stringify(result)).not.toContain(target.sessionToken);
    expect(JSON.stringify(result)).not.toContain(actor.sessionToken);
    expect(() => service.pingSession("vc_sess_missing", {})).toThrow(/session not found/i);
  });

  it("reports managed ping delivery as pending receiver acknowledgement", () => {
    const target = service.registerSession({
      displayName: "Managed worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {},
      delivery: {
        mode: "managed_process",
        wakeable: true
      }
    });

    const result = service.pingSession(target.sessionUid, {
      message: "Please check the inbox."
    });

    expect(result.delivery).toEqual({
      mode: "managed_process",
      wakeable: true,
      delivered: false,
      nextStep: "Await receiver acknowledgement."
    });
    expect(result.targetSession.delivery).toMatchObject({
      mode: "managed_process",
      wakeable: true
    });
    expect(JSON.stringify(result)).not.toContain(target.sessionToken);
  });

  it("records soft pings for active working sessions without interrupting state", () => {
    const target = service.registerSession({
      displayName: "Busy worker",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    service.updateSessionState(
      target.sessionUid,
      target.sessionToken,
      "working",
      "Already handling a handoff"
    );

    const result = service.pingSession(target.sessionUid, {
      message: "Please check another handoff."
    });

    expect(result.event).toMatchObject({
      eventType: "session.pinged",
      sessionUid: target.sessionUid,
      payload: {
        message: "Please check another handoff."
      }
    });
    expect(service.getSession(target.sessionUid)).toMatchObject({
      status: "working",
      statusDetail: "Already handling a handoff"
    });
  });

  it("does not ping terminal sessions", () => {
    const target = service.registerSession({
      displayName: "Closed worker",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    service.updateSessionState(target.sessionUid, target.sessionToken, "complete", "Done.");

    expect(() =>
      service.pingSession(target.sessionUid, {
        message: "This should not target closed sessions."
      })
    ).toThrow(/cannot ping complete sessions/i);
    expect(events.listEvents({ sessionUid: target.sessionUid, eventType: "session.pinged" })).toEqual([]);
  });

  it("marks a session as awaiting user permission with a token-safe event", () => {
    const registered = service.registerSession({
      displayName: "Codex terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    now = new Date("2026-05-28T10:01:45.000Z");

    const awaitingPermission = service.requestSessionPermission(
      registered.sessionUid,
      registered.sessionToken,
      {
        question: "Allow network access for git push?",
        requestedCapability: "network",
        commandPreview: "git push origin main",
        source: "codex"
      }
    );

    expect(awaitingPermission).toMatchObject({
      status: "awaiting_user",
      statusDetail: "Allow network access for git push?",
      updatedAt: "2026-05-28T10:01:45.000Z"
    });
    const permissionEvent = events.listEvents({
      sessionUid: registered.sessionUid,
      eventType: "session.permission_requested"
    })[0];
    expect(permissionEvent).toMatchObject({
      eventType: "session.permission_requested",
      sessionUid: registered.sessionUid,
      payload: {
        permissionRequest: {
          question: "Allow network access for git push?",
          requestedCapability: "network",
          commandPreview: "git push origin main",
          source: "codex",
          createdAt: "2026-05-28T10:01:45.000Z"
        }
      }
    });
    expect(JSON.stringify(permissionEvent)).not.toContain(registered.sessionToken);
    expect(() =>
      service.requestSessionPermission(registered.sessionUid, "wrong-token", {
        question: "Should fail."
      })
    ).toThrow(/invalid session token/i);
  });

  it("emits cost warnings without requiring context metrics", () => {
    const registered = service.registerSession({
      displayName: "Cost reporter",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    now = new Date("2026-05-28T10:01:50.000Z");

    const report = service.reportRuntimeMetrics(registered.sessionUid, registered.sessionToken, {
      costUsd: 21,
      costThresholdUsd: 20
    });

    expect(report.emittedEvents.map((event) => event.eventType)).toEqual([
      "cost.threshold_warning"
    ]);
    expect(report.emittedEvents[0]).toMatchObject({
      sessionUid: registered.sessionUid,
      payload: {
        project: "Vault Collab",
        costUsd: 21,
        thresholdUsd: 20
      }
    });
    expect(JSON.stringify(report)).not.toContain(registered.sessionToken);
  });

  it("stores a session snapshot without changing canonical lifecycle state", () => {
    const registered = service.registerSession({
      displayName: "Snapshot worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    service.updateSessionState(
      registered.sessionUid,
      registered.sessionToken,
      "blocked",
      "Canonical lifecycle remains blocked."
    );
    now = new Date("2026-05-28T10:01:55.000Z");

    const report = service.reportSession({
      sessionUid: registered.sessionUid,
      sessionToken: registered.sessionToken,
      snapshot: validSessionSnapshot(registered.sessionUid)
    });

    expect(report.session).toMatchObject({
      sessionUid: registered.sessionUid,
      status: "blocked",
      statusDetail: "Canonical lifecycle remains blocked.",
      adapterType: "adapter_backed",
      snapshotReportedAt: "2026-05-28T10:01:55.000Z",
      lastHeartbeatAt: "2026-05-28T10:01:55.000Z",
      lastSnapshot: {
        state: "working",
        progress: {
          currentTask: "Implement Phase 7",
          percentComplete: 40
        }
      }
    });
    expect(report.snapshot).toMatchObject({
      sessionUid: registered.sessionUid,
      capabilities: {
        adapterType: "adapter_backed"
      }
    });
    expect(report.emittedEvents.map((event) => event.eventType)).toEqual([
      "session.snapshot_reported"
    ]);
    expect(report.emittedEvents[0].payload).toMatchObject({
      schemaVersion: "vault_collab.session.v1",
      adapterId: "codex-local:test",
      adapterType: "adapter_backed",
      project: "Vault Collab",
      state: "working",
      riskLevel: "low",
      activeHandoffCount: 1,
      progressPercent: 40,
      snapshotReportedAt: "2026-05-28T10:01:55.000Z",
      payloadKeys: expect.arrayContaining(["schemaVersion", "adapterId", "risk"])
    });
    expect(report.emittedEvents[0].payload).not.toHaveProperty("snapshot");
    expect(JSON.stringify(report)).not.toContain(registered.sessionToken);

    const row = db
      .prepare(
        `
        SELECT adapter_type, snapshot_reported_at, last_snapshot_json
        FROM sessions
        WHERE session_uid = ?
      `
      )
      .get(registered.sessionUid) as {
      adapter_type: string;
      snapshot_reported_at: string;
      last_snapshot_json: string;
    };

    expect(row.adapter_type).toBe("adapter_backed");
    expect(row.snapshot_reported_at).toBe("2026-05-28T10:01:55.000Z");
    expect(JSON.parse(row.last_snapshot_json)).toMatchObject({
      sessionUid: registered.sessionUid,
      state: "working"
    });
  });

  it("accepts HMAC adapter tokens only for reportSession", () => {
    vi.stubEnv("VAULT_COLLAB_ADAPTER_TOKEN_SECRET", adapterSecret);
    const registered = service.registerSession({
      displayName: "Adapter backed worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const snapshot = validSessionSnapshot(registered.sessionUid);
    const token = deriveAdapterToken(adapterSecret, registered.sessionUid, "codex-local:test");
    now = new Date("2026-05-28T10:01:56.000Z");

    const report = service.reportSession({
      sessionUid: registered.sessionUid,
      adapterToken: token,
      snapshot
    });

    expect(report.session).toMatchObject({
      adapterType: "adapter_backed",
      snapshotReportedAt: "2026-05-28T10:01:56.000Z"
    });
    expect(() =>
      service.reportSession({
        sessionUid: registered.sessionUid,
        adapterToken: "wrong-token",
        snapshot
      })
    ).toThrow(/invalid adapter token/i);
    expect(() =>
      service.updateSessionState(registered.sessionUid, token, "working", "must not work")
    ).toThrow(/invalid session token/i);
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("normalizes instruction-backed mutation hints to false", () => {
    const registered = service.registerSession({
      displayName: "Instruction backed worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });

    const report = service.reportSession({
      sessionUid: registered.sessionUid,
      sessionToken: registered.sessionToken,
      snapshot: validSessionSnapshot(registered.sessionUid, {
        adapterId: "tmux:pane-1",
        capabilities: {
          canMutateHandoffs: true,
          canPublishHandoffs: true,
          canSendMessages: true,
          adapterType: "instruction_backed"
        }
      })
    });

    expect(report.snapshot.capabilities).toEqual({
      canMutateHandoffs: false,
      canPublishHandoffs: false,
      canSendMessages: false,
      adapterType: "instruction_backed"
    });
    expect(report.session.lastSnapshot?.capabilities).toEqual(report.snapshot.capabilities);
  });

  it("emits a separate critical risk attention event", () => {
    const registered = service.registerSession({
      displayName: "Risk reporter",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });

    const report = service.reportSession({
      sessionUid: registered.sessionUid,
      sessionToken: registered.sessionToken,
      snapshot: validSessionSnapshot(registered.sessionUid, {
        risk: {
          level: "critical",
          reasons: ["Context compaction is imminent."]
        }
      })
    });

    expect(report.emittedEvents.map((event) => event.eventType)).toEqual([
      "session.snapshot_reported",
      "risk.critical_reported"
    ]);
    expect(report.emittedEvents[1].payload).toMatchObject({
      project: "Vault Collab",
      adapterId: "codex-local:test",
      adapterType: "adapter_backed",
      riskLevel: "critical",
      reasons: ["Context compaction is imminent."]
    });
    expect(report.emittedEvents[1].payload).not.toHaveProperty("snapshot");
    expect(JSON.stringify(report.emittedEvents)).not.toContain(registered.sessionToken);
  });

  it("disconnects sessions without deleting them", () => {
    const registered = service.registerSession({
      displayName: "Octogent",
      clientType: "octogent",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    now = new Date("2026-05-28T10:02:00.000Z");

    const disconnected = service.disconnectSession(registered.sessionUid, registered.sessionToken);

    expect(disconnected.status).toBe("disconnected");
    expect(disconnected.disconnectedAt).toBe("2026-05-28T10:02:00.000Z");
    expect(service.listSessions({ status: "disconnected" })).toHaveLength(1);
    expect(service.listSessions()[0]).toMatchObject({
      sessionUid: registered.sessionUid,
      status: "disconnected",
      disconnectedAt: "2026-05-28T10:02:00.000Z"
    });
  });

  it("expires claimed handoff leases immediately when a session disconnects", () => {
    const registered = service.registerSession({
      displayName: "Octogent",
      clientType: "octogent",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Disconnect lease",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, registered.sessionUid, registered.sessionToken);

    now = new Date("2026-05-28T10:02:00.000Z");
    service.disconnectSession(registered.sessionUid, registered.sessionToken);

    expect(handoffs.getHandoff(handoff.handoffUid)?.leaseExpiresAt).toBe(
      "2026-05-28T10:02:00.000Z"
    );
  });

  it("renames a session with the owning session token", () => {
    const registered = service.registerSession({
      displayName: "Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    now = new Date("2026-05-28T10:02:30.000Z");

    const renamed = service.renameSession(
      registered.sessionUid,
      registered.sessionToken,
      "Codex Receiver - terminal 2"
    );

    expect(renamed).toMatchObject({
      sessionUid: registered.sessionUid,
      displayName: "Codex Receiver - terminal 2",
      updatedAt: "2026-05-28T10:02:30.000Z"
    });
    expect(renamed).not.toHaveProperty("sessionToken");
    expect(service.listSessions()[0]).toMatchObject({
      displayName: "Codex Receiver - terminal 2"
    });
    expect(() =>
      service.renameSession(registered.sessionUid, "wrong-token", "Bad rename")
    ).toThrow(/invalid session token/i);
    expect(() =>
      service.renameSession(registered.sessionUid, registered.sessionToken, "  ")
    ).toThrow(/session display name cannot be empty/i);

    const renameEvent = events.listEvents({
      sessionUid: registered.sessionUid,
      eventType: "session.renamed"
    })[0];
    expect(renameEvent).toMatchObject({
      eventType: "session.renamed",
      payload: {
        previousDisplayName: "Codex",
        displayName: "Codex Receiver - terminal 2"
      }
    });
    expect(JSON.stringify(renameEvent)).not.toContain(registered.sessionToken);
  });

  it("lets a session admin close stale roster sessions without the target token", () => {
    const admin = service.registerSession({
      displayName: "Dashboard Admin",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        sessionAdmin: true
      }
    });
    const stale = service.registerSession({
      displayName: "Old idle terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const outsider = service.registerSession({
      displayName: "Regular operator",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    now = new Date("2026-05-28T10:02:45.000Z");

    const closed = service.closeSession(
      stale.sessionUid,
      admin.sessionUid,
      admin.sessionToken,
      "Closed from dashboard roster"
    );

    expect(closed).toMatchObject({
      sessionUid: stale.sessionUid,
      status: "disconnected",
      statusDetail: "Closed from dashboard roster",
      disconnectedAt: "2026-05-28T10:02:45.000Z"
    });
    expect(closed).not.toHaveProperty("sessionToken");
    expect(() =>
      service.closeSession(stale.sessionUid, outsider.sessionUid, outsider.sessionToken, "Nope")
    ).toThrow(/session requires session admin capability/i);
    expect(events.listEvents({ sessionUid: stale.sessionUid, eventType: "session.disconnected" })[0])
      .toMatchObject({
        payload: {
          actorSessionUid: admin.sessionUid,
          reason: "Closed from dashboard roster"
        }
      });
    expect(JSON.stringify(closed)).not.toContain(stale.sessionToken);
    expect(JSON.stringify(closed)).not.toContain(admin.sessionToken);
  });

  it("lets a coordinator role-profile session close a foreign complete session", () => {
    const coordinator = service.registerSession({
      displayName: "Coordinator",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      roleProfileId: "coordinator",
      capabilities: {}
    });
    const target = service.registerSession({
      displayName: "Completed worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    service.updateSessionState(target.sessionUid, target.sessionToken, "complete", "Done.");
    now = new Date("2026-05-28T10:02:50.000Z");

    const closed = service.closeSession(
      target.sessionUid,
      coordinator.sessionUid,
      coordinator.sessionToken,
      "Coordinator roster sweep"
    );

    expect(closed).toMatchObject({
      sessionUid: target.sessionUid,
      status: "disconnected",
      statusDetail: "Coordinator roster sweep",
      disconnectedAt: "2026-05-28T10:02:50.000Z"
    });
    expect(closed).not.toHaveProperty("sessionToken");
    expect(events.listEvents({ sessionUid: target.sessionUid, eventType: "session.disconnected" })[0])
      .toMatchObject({
        payload: {
          actorSessionUid: coordinator.sessionUid,
          reason: "Coordinator roster sweep"
        }
      });
    expect(JSON.stringify(closed)).not.toContain(target.sessionToken);
    expect(JSON.stringify(closed)).not.toContain(coordinator.sessionToken);
  });

  it("lets a session admin purge complete, disconnected, and stale roster ghosts", () => {
    const admin = service.registerSession({
      displayName: "Dashboard Admin",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        sessionAdmin: true
      }
    });
    const completed = service.registerSession({
      displayName: "Completed worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const disconnected = service.registerSession({
      displayName: "Disconnected worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const stale = service.registerSession({
      displayName: "Stale worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const active = service.registerSession({
      displayName: "Active worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });

    service.updateSessionState(completed.sessionUid, completed.sessionToken, "complete", "Done.");
    service.disconnectSession(disconnected.sessionUid, disconnected.sessionToken);
    db.prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE session_uid = ?").run(
      "2026-05-28T09:00:00.000Z",
      stale.sessionUid
    );
    db.prepare(
      `
      INSERT INTO session_attention_cursors (
        session_uid,
        stream,
        latest_event_id,
        acknowledged_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
    `
    ).run(completed.sessionUid, "default", 42, now.toISOString(), now.toISOString());
    db.prepare(
      `
      INSERT INTO session_attention_cursors (
        session_uid,
        stream,
        latest_event_id,
        acknowledged_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
    `
    ).run(active.sessionUid, "default", 43, now.toISOString(), now.toISOString());
    db.prepare(
      `
      INSERT INTO attention_delivery_attempts (
        attempt_uid,
        session_uid,
        from_event_id,
        to_event_id,
        delivery_mode,
        adapter,
        status,
        message,
        created_at,
        delivered_at,
        failed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      "attempt-completed",
      completed.sessionUid,
      1,
      2,
      "manual_poll",
      "dashboard",
      "delivered",
      null,
      now.toISOString(),
      now.toISOString(),
      null
    );
    db.prepare(
      `
      INSERT INTO attention_delivery_attempts (
        attempt_uid,
        session_uid,
        from_event_id,
        to_event_id,
        delivery_mode,
        adapter,
        status,
        message,
        created_at,
        delivered_at,
        failed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      "attempt-disconnected",
      disconnected.sessionUid,
      3,
      4,
      "manual_poll",
      "dashboard",
      "failed",
      null,
      now.toISOString(),
      null,
      now.toISOString()
    );

    now = new Date("2026-05-28T10:03:00.000Z");
    const result = service.cleanupSessions(admin.sessionUid, admin.sessionToken);

    expect(result).toMatchObject({
      actorSessionUid: admin.sessionUid,
      statuses: ["complete", "disconnected"],
      deletedSessionCount: 3,
      deletedCursorCount: 1,
      deletedDeliveryAttemptCount: 2
    });
    expect(result.deletedSessionUids).toEqual(
      expect.arrayContaining([completed.sessionUid, disconnected.sessionUid, stale.sessionUid])
    );
    expect(service.listSessions().map((session) => session.sessionUid)).toEqual(
      expect.arrayContaining([admin.sessionUid, active.sessionUid])
    );
    expect(service.listSessions().map((session) => session.sessionUid)).not.toEqual(
      expect.arrayContaining([completed.sessionUid, disconnected.sessionUid, stale.sessionUid])
    );
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM session_attention_cursors").get()
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM attention_delivery_attempts").get()
    ).toEqual({ count: 0 });
    expect(events.listEvents({ sessionUid: admin.sessionUid, eventType: "session.cleanup" })[0])
      .toMatchObject({
        payload: {
          actorSessionUid: admin.sessionUid,
          deletedSessionCount: 3,
          deletedCursorCount: 1,
          deletedDeliveryAttemptCount: 2
        }
      });
    expect(JSON.stringify(result)).not.toContain(admin.sessionToken);
    expect(JSON.stringify(result)).not.toContain(completed.sessionToken);
  });

  it("keeps non-admin sessions denied from purging roster ghosts", () => {
    const operator = service.registerSession({
      displayName: "Regular operator",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const disconnected = service.registerSession({
      displayName: "Disconnected worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    service.disconnectSession(disconnected.sessionUid, disconnected.sessionToken);

    expect(() =>
      service.cleanupSessions(operator.sessionUid, operator.sessionToken)
    ).toThrow(/session cleanup requires session admin capability/i);
    expect(service.listSessions({ status: "disconnected" })).toHaveLength(1);
  });

  it("keeps implementer role-profile sessions denied from closing foreign disconnected sessions", () => {
    const implementer = service.registerSession({
      displayName: "Implementer",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      roleProfileId: "implementer",
      capabilities: {}
    });
    const target = service.registerSession({
      displayName: "Disconnected worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    service.disconnectSession(target.sessionUid, target.sessionToken);

    expect(() =>
      service.closeSession(
        target.sessionUid,
        implementer.sessionUid,
        implementer.sessionToken,
        "Implementer roster sweep"
      )
    ).toThrow(/session requires session admin capability/i);
  });

  it("lists sessions by project and client type", () => {
    service.registerSession({
      displayName: "Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    service.registerSession({
      displayName: "Future client",
      clientType: "other",
      project: "Other Project",
      workspacePath: "C:\\tmp\\other-project",
      capabilities: {
        clientName: "future-mcp"
      }
    });

    expect(service.listSessions({ project: "Vault Collab" })).toHaveLength(1);
    expect(service.listSessions({ project: "vault-collab" })).toHaveLength(1);
    expect(service.listSessions({ clientType: "other" })).toHaveLength(1);
    expect(service.listSessions({ project: "Missing" })).toEqual([]);
  });

  it("marks stale heartbeat sessions disconnected during roster reads", () => {
    const registered = service.registerSession({
      displayName: "Stale worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Stale worker claim",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, registered.sessionUid, registered.sessionToken);
    db.prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE session_uid = ?").run(
      "2026-05-28T09:00:00.000Z",
      registered.sessionUid
    );

    const idleSessions = service.listSessions({ status: "idle" });
    const disconnected = service.getSession(registered.sessionUid);

    expect(idleSessions).toEqual([]);
    expect(disconnected).toMatchObject({
      sessionUid: registered.sessionUid,
      status: "disconnected",
      disconnectedAt: "2026-05-28T10:00:00.000Z"
    });
    expect(handoffs.getHandoff(handoff.handoffUid)?.leaseExpiresAt).toBe(
      "2026-05-28T10:00:00.000Z"
    );
  });

  it("routes sessions by persisted project key instead of mutable display label", () => {
    const registered = service.registerSession({
      displayName: "Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });

    db.prepare("UPDATE sessions SET project = ? WHERE session_uid = ?").run(
      "Renamed Display Label",
      registered.sessionUid
    );

    expect(service.listSessions({ project: "vault-collab" })[0]?.sessionUid).toBe(
      registered.sessionUid
    );
  });
});
