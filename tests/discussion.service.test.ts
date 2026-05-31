import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { AgentProfileService } from "../src/services/agent-profile.service.js";
import { DiscussionService } from "../src/services/discussion.service.js";
import { EventService } from "../src/services/event.service.js";
import { HandoffService } from "../src/services/handoff.service.js";
import { LaunchRequestService } from "../src/services/launch-request.service.js";
import { SessionService } from "../src/services/session.service.js";
import type { HandoffRecord, RegisteredSession } from "../src/types.js";

const workspacePath = "C:\\workspace\\vault-collab";

describe("DiscussionService", () => {
  let db: CollabDatabase;
  let now: Date;
  let events: EventService;
  let sessions: SessionService;
  let handoffs: HandoffService;
  let discussions: DiscussionService;
  let codex: RegisteredSession;
  let claude: RegisteredSession;
  let handoff: HandoffRecord;

  beforeEach(() => {
    now = new Date("2026-05-29T13:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    events = new EventService(db, clock);
    const agents = new AgentProfileService(db, events, clock);
    const launchRequests = new LaunchRequestService(db, events, clock);
    sessions = new SessionService(db, events, launchRequests, clock);
    handoffs = new HandoffService(db, events, clock);
    discussions = new DiscussionService(db, events, clock);

    const codexAgent = agents.upsertAgentProfile({
      stableName: "codex-implementer",
      displayName: "Codex Implementer",
      role: "implementer",
      clientType: "codex",
      project: "Vault Collab"
    });
    codex = sessions.registerSession({
      displayName: "Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        handoffs: true
      },
      agentUid: codexAgent.agentUid
    });
    claude = sessions.registerSession({
      displayName: "Claude Code",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        review: true
      }
    });
    handoff = handoffs.publishHandoff({
      shortPrompt: "Discuss this handoff",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: codex.sessionUid
    });
  });

  afterEach(() => {
    db.close();
  });

  it("creates threads and appends messages with owner-token validation", () => {
    expect(() =>
      discussions.createThread({
        project: "Vault Collab",
        handoffUid: handoff.handoffUid,
        title: "Phase 1 design disagreement",
        createdBySessionUid: codex.sessionUid,
        sessionToken: "wrong-token"
      })
    ).toThrow(/invalid session token/i);
    expect(discussions.listThreads({ project: "Vault Collab" })).toEqual([]);
    expect(() =>
      discussions.createThread({
        project: "Other Project",
        handoffUid: handoff.handoffUid,
        title: "Wrong project",
        createdBySessionUid: codex.sessionUid,
        sessionToken: codex.sessionToken
      })
    ).toThrow(/handoff target project/i);
    expect(() =>
      discussions.createThread({
        project: "Vault Collab",
        handoffUid: handoff.handoffUid,
        title: "   ",
        createdBySessionUid: codex.sessionUid,
        sessionToken: codex.sessionToken
      })
    ).toThrow(/title/i);

    const thread = discussions.createThread({
      project: "Vault Collab",
      handoffUid: handoff.handoffUid,
      title: "Phase 1 design disagreement",
      createdBySessionUid: codex.sessionUid,
      sessionToken: codex.sessionToken
    });

    expect(thread).toMatchObject({
      handoffUid: handoff.handoffUid,
      project: "Vault Collab",
      title: "Phase 1 design disagreement",
      status: "open",
      createdBySessionUid: codex.sessionUid,
      messageCount: 0,
      lastMessageAt: null
    });
    expect(thread.threadUid).toMatch(/^vc_thread_/);

    expect(() =>
      discussions.addMessage(thread.threadUid, claude.sessionUid, "wrong-token", {
        messageType: "concern",
        body: "This should not be accepted."
      })
    ).toThrow(/invalid session token/i);
    expect(() =>
      discussions.addMessage(thread.threadUid, claude.sessionUid, claude.sessionToken, {
        messageType: "concern",
        body: "   "
      })
    ).toThrow(/body/i);

    now = new Date("2026-05-29T13:01:00.000Z");
    discussions.addMessage(thread.threadUid, codex.sessionUid, codex.sessionToken, {
      messageType: "proposal",
      body: "Use append-only discussion messages.",
      metadata: {
        confidence: "high"
      }
    });
    now = new Date("2026-05-29T13:02:00.000Z");
    discussions.addMessage(thread.threadUid, claude.sessionUid, claude.sessionToken, {
      messageType: "concern",
      body: "Make sure Claude Code sessions are represented too."
    });
    now = new Date("2026-05-29T13:03:00.000Z");
    discussions.addMessage(thread.threadUid, codex.sessionUid, codex.sessionToken, {
      messageType: "decision",
      body: "Keep client type provider-neutral."
    });

    const detail = discussions.getThread(thread.threadUid);

    expect(detail).toMatchObject({
      threadUid: thread.threadUid,
      messageCount: 3,
      lastMessageAt: "2026-05-29T13:03:00.000Z"
    });
    expect(detail?.messages.map((message) => message.messageType)).toEqual([
      "proposal",
      "concern",
      "decision"
    ]);
    expect(detail?.messages[0]).toMatchObject({
      sessionUid: codex.sessionUid,
      agentUid: codex.agentUid,
      metadata: {
        confidence: "high"
      }
    });
    expect(detail?.messages[1]).toMatchObject({
      sessionUid: claude.sessionUid,
      agentUid: null
    });
    expect(JSON.stringify(detail)).not.toContain(codex.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(claude.sessionToken);

    const listed = discussions.listThreads({
      project: "Vault Collab",
      handoffUid: handoff.handoffUid
    });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      threadUid: thread.threadUid,
      messageCount: 3,
      lastMessageAt: "2026-05-29T13:03:00.000Z"
    });
    expect(discussions.listThreads({ project: "vault-collab" })).toHaveLength(1);
  });

  it("accepts handoff-linked thread creation when the project label differs", () => {
    const thread = discussions.createThread({
      project: "vault-collab",
      handoffUid: handoff.handoffUid,
      title: "Alias project discussion",
      createdBySessionUid: codex.sessionUid,
      sessionToken: codex.sessionToken
    });

    expect(thread).toMatchObject({
      handoffUid: handoff.handoffUid,
      project: "vault-collab"
    });
    expect(discussions.listThreads({ project: "Vault Collab" })).toHaveLength(1);
  });

  it("routes discussion threads by persisted project key instead of mutable display label", () => {
    const thread = discussions.createThread({
      project: "Vault Collab",
      title: "Project-key routed thread",
      createdBySessionUid: codex.sessionUid,
      sessionToken: codex.sessionToken
    });

    db.prepare("UPDATE discussion_threads SET project = ? WHERE thread_uid = ?").run(
      "Renamed Display Label",
      thread.threadUid
    );

    expect(discussions.listThreads({ project: "vault-collab" })[0]?.threadUid).toBe(
      thread.threadUid
    );
  });

  it("keeps append order deterministic when messages share a timestamp", () => {
    const thread = discussions.createThread({
      project: "Vault Collab",
      handoffUid: handoff.handoffUid,
      title: "Same timestamp messages",
      createdBySessionUid: codex.sessionUid,
      sessionToken: codex.sessionToken
    });

    discussions.addMessage(thread.threadUid, codex.sessionUid, codex.sessionToken, {
      messageType: "proposal",
      body: "First"
    });
    discussions.addMessage(thread.threadUid, claude.sessionUid, claude.sessionToken, {
      messageType: "concern",
      body: "Second"
    });
    discussions.addMessage(thread.threadUid, codex.sessionUid, codex.sessionToken, {
      messageType: "decision",
      body: "Third"
    });

    expect(discussions.getThread(thread.threadUid)?.messages.map((message) => message.body)).toEqual([
      "First",
      "Second",
      "Third"
    ]);
  });
});
