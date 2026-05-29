import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { AgentProfileService } from "../src/services/agent-profile.service.js";
import { EventService } from "../src/services/event.service.js";
import { SessionService } from "../src/services/session.service.js";

const workspacePath = "C:\\workspace\\vault-collab";

describe("SessionService", () => {
  let db: CollabDatabase;
  let now: Date;
  let events: EventService;
  let agents: AgentProfileService;
  let service: SessionService;

  beforeEach(() => {
    now = new Date("2026-05-28T10:00:00.000Z");
    db = createCollabDatabase(":memory:");
    const clock = () => now;
    events = new EventService(db, clock);
    agents = new AgentProfileService(db, events, clock);
    service = new SessionService(db, events, clock);
  });

  afterEach(() => {
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
    expect(registered.capabilities).toEqual({
      handoffs: true,
      maxConcurrentHandoffs: 1
    });
    expect(registered.createdAt).toBe("2026-05-28T10:00:00.000Z");
    expect(registered.lastHeartbeatAt).toBe("2026-05-28T10:00:00.000Z");

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
      capabilities: {
        handoffs: true,
        maxConcurrentHandoffs: 1
      },
      disconnectedAt: null
    });
    expect(sessions[0]).not.toHaveProperty("sessionToken");
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
    expect(service.listSessions({ clientType: "other" })).toHaveLength(1);
    expect(service.listSessions({ project: "Missing" })).toEqual([]);
  });
});
