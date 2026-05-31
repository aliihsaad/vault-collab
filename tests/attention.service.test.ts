import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { AttentionService } from "../src/services/attention.service.js";
import { DiscussionService } from "../src/services/discussion.service.js";
import { EventService } from "../src/services/event.service.js";
import { HandoffService } from "../src/services/handoff.service.js";
import { LaunchRequestService } from "../src/services/launch-request.service.js";
import { SessionService } from "../src/services/session.service.js";
import type { RegisteredSession } from "../src/types.js";

const workspacePath = "C:\\workspace\\vault-collab";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AttentionService", () => {
  let db: CollabDatabase;
  let now: Date;
  let events: EventService;
  let sessions: SessionService;
  let handoffs: HandoffService;
  let launchRequests: LaunchRequestService;
  let discussions: DiscussionService;
  let attention: AttentionService;
  let coordinator: RegisteredSession;
  let worker: RegisteredSession;

  beforeEach(() => {
    now = new Date("2026-05-29T14:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    events = new EventService(db, clock);
    launchRequests = new LaunchRequestService(db, events, clock);
    sessions = new SessionService(db, events, launchRequests, clock);
    handoffs = new HandoffService(db, events, clock);
    discussions = new DiscussionService(db, events, clock);
    attention = new AttentionService(db, sessions, handoffs, discussions, events, launchRequests);

    coordinator = sessions.registerSession({
      displayName: "Coordinator",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        launchRequests: true
      }
    });
    worker = sessions.registerSession({
      displayName: "Worker",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      role: "reviewer",
      capabilities: {}
    });
  });

  afterEach(() => {
    db.close();
  });

  it("builds a token-safe attention feed for an active agent session", () => {
    const projectHandoff = handoffs.publishHandoff({
      shortPrompt: "Available project work",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    const suggestedHandoff = handoffs.publishHandoff({
      shortPrompt: "Suggested work",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      suggestedSessionUid: worker.sessionUid
    });
    const claimedHandoff = handoffs.publishHandoff({
      shortPrompt: "Claimed work",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: coordinator.sessionUid
    });

    now = new Date("2026-05-29T14:01:00.000Z");
    sessions.pingSession(worker.sessionUid, {
      actorSessionUid: coordinator.sessionUid,
      message: "Check the discussion."
    });
    handoffs.claimHandoff(claimedHandoff.handoffUid, worker.sessionUid, worker.sessionToken);
    sessions.requestSessionPermission(worker.sessionUid, worker.sessionToken, {
      question: "Allow local file read?",
      requestedCapability: "filesystem-read",
      source: "claude-code"
    });
    handoffs.requestHandoffPermission(
      claimedHandoff.handoffUid,
      worker.sessionUid,
      worker.sessionToken,
      {
        question: "Allow npm build?",
        requestedCapability: "build",
        commandPreview: "npm run build",
        source: "claude-code"
      }
    );
    const thread = discussions.createThread({
      project: "Vault Collab",
      handoffUid: claimedHandoff.handoffUid,
      title: "Review thread",
      createdBySessionUid: coordinator.sessionUid,
      sessionToken: coordinator.sessionToken
    });
    discussions.addMessage(thread.threadUid, coordinator.sessionUid, coordinator.sessionToken, {
      messageType: "question",
      body: "Can you take a look?"
    });

    const feed = attention.getSessionAttention(worker.sessionUid);

    expect(feed.session.sessionUid).toBe(worker.sessionUid);
    expect(feed.session.role).toBe("reviewer");
    expect(feed.latestEventId).toBeGreaterThan(0);
    expect(feed.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "session_ping",
        "session_permission",
        "handoff_permission",
        "discussion_message",
        "suggested_handoff",
        "claimed_handoff",
        "available_handoff"
      ])
    );
    expect(
      feed.items.find(
        (item) => item.kind === "available_handoff" && item.handoff?.handoffUid === projectHandoff.handoffUid
      )
    ).toBeDefined();
    expect(
      feed.items.find(
        (item) => item.kind === "suggested_handoff" && item.handoff?.handoffUid === suggestedHandoff.handoffUid
      )
    ).toBeDefined();
    expect(
      feed.items.find(
        (item) => item.kind === "claimed_handoff" && item.handoff?.handoffUid === claimedHandoff.handoffUid
      )
    ).toBeDefined();
    expect(JSON.stringify(feed)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(feed)).not.toContain(coordinator.sessionToken);
  });

  it("uses event cursors for new ping and discussion attention", () => {
    sessions.pingSession(worker.sessionUid, {
      actorSessionUid: coordinator.sessionUid,
      message: "First ping"
    });
    const firstFeed = attention.getSessionAttention(worker.sessionUid);
    const cursor = firstFeed.latestEventId;

    now = new Date("2026-05-29T14:02:00.000Z");
    sessions.pingSession(worker.sessionUid, {
      actorSessionUid: coordinator.sessionUid,
      message: "Second ping"
    });

    const feed = attention.getSessionAttention(worker.sessionUid, {
      sinceEventId: cursor,
      includeCurrentHandoffs: false
    });

    expect(feed.sinceEventId).toBe(cursor);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      kind: "session_ping",
      event: {
        payload: {
          message: "Second ping"
        }
      }
    });
  });

  it("surfaces non-interrupting pings while a session is working", () => {
    sessions.updateSessionState(
      worker.sessionUid,
      worker.sessionToken,
      "working",
      "Implementing an active handoff"
    );
    const cursor = attention.getSessionAttention(worker.sessionUid).latestEventId;

    now = new Date("2026-05-29T14:02:30.000Z");
    sessions.pingSession(worker.sessionUid, {
      actorSessionUid: coordinator.sessionUid,
      message: "Operator note while working."
    });

    const feed = attention.getSessionAttention(worker.sessionUid, {
      sinceEventId: cursor,
      includeCurrentHandoffs: false
    });

    expect(feed.session).toMatchObject({
      sessionUid: worker.sessionUid,
      status: "working",
      statusDetail: "Implementing an active handoff"
    });
    expect(feed.items).toEqual([
      expect.objectContaining({
        kind: "session_ping",
        event: expect.objectContaining({
          payload: expect.objectContaining({
            message: "Operator note while working."
          })
        })
      })
    ]);
  });

  it("makes suggested handoffs claimed by another session explicit", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Targeted QA work",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      suggestedSessionUid: worker.sessionUid
    });

    handoffs.claimHandoff(handoff.handoffUid, coordinator.sessionUid, coordinator.sessionToken);

    const feed = attention.getSessionAttention(worker.sessionUid);

    expect(
      feed.items.find(
        (item) =>
          item.kind === "claimed_by_other_handoff" &&
          item.handoff?.handoffUid === handoff.handoffUid &&
          item.handoff.claimedBySessionUid === coordinator.sessionUid
      )
    ).toBeDefined();
    expect(
      feed.items.find(
        (item) =>
          item.kind === "suggested_handoff" && item.handoff?.handoffUid === handoff.handoffUid
      )
    ).toBeUndefined();
  });

  it("surfaces session-targeted handoffs when the project label differs", () => {
    const lowercaseWorker = sessions.registerSession({
      displayName: "Lowercase Worker",
      clientType: "claude-code",
      project: "vault-collab",
      workspacePath,
      capabilities: {}
    });
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Suggested despite project label drift",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      suggestedSessionUid: lowercaseWorker.sessionUid
    });
    const thread = discussions.createThread({
      project: "Vault Collab",
      handoffUid: handoff.handoffUid,
      title: "Project label drift",
      createdBySessionUid: coordinator.sessionUid,
      sessionToken: coordinator.sessionToken
    });
    discussions.addMessage(thread.threadUid, coordinator.sessionUid, coordinator.sessionToken, {
      messageType: "question",
      body: "Can the lowercase project worker see this?"
    });

    const feed = attention.getSessionAttention(lowercaseWorker.sessionUid);

    expect(
      feed.items.find(
        (item) => item.kind === "suggested_handoff" && item.handoff?.handoffUid === handoff.handoffUid
      )
    ).toBeDefined();
    expect(
      feed.items.find(
        (item) => item.kind === "discussion_message" && item.handoff?.handoffUid === handoff.handoffUid
      )
    ).toBeDefined();
  });

  it("surfaces available handoffs by persisted project key when labels drift", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Available despite label drift",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });

    db.prepare("UPDATE handoffs SET target_project = ? WHERE handoff_uid = ?").run(
      "Renamed Target Label",
      handoff.handoffUid
    );

    const feed = attention.getSessionAttention(worker.sessionUid);

    expect(
      feed.items.find(
        (item) => item.kind === "available_handoff" && item.handoff?.handoffUid === handoff.handoffUid
      )
    ).toBeDefined();
  });

  it("surfaces project launch requests in active-session attention", () => {
    const launchRequest = launchRequests.createLaunchRequest({
      requestedBySessionUid: coordinator.sessionUid,
      sessionToken: coordinator.sessionToken,
      provider: "codex",
      model: "gpt-5-codex",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      initialInstructions: "Implement the launch broker.",
      permissionMode: "workspace-write"
    });

    const feed = attention.getSessionAttention(worker.sessionUid);
    const launchItems = feed.items.filter(
      (item) =>
        item.kind === "launch_request" &&
        item.launchRequest?.launchRequestUid === launchRequest.launchRequestUid
    );

    expect(launchItems).toHaveLength(1);
    expect(JSON.stringify(feed)).not.toContain(coordinator.sessionToken);
  });

  it("lazily sweeps expired handoff leases before building attention", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Expired attention claim",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, coordinator.sessionUid, coordinator.sessionToken);
    db.prepare("UPDATE handoffs SET lease_expires_at = ? WHERE handoff_uid = ?").run(
      "1970-01-01T00:00:00.000Z",
      handoff.handoffUid
    );

    const feed = attention.getSessionAttention(worker.sessionUid);

    expect(handoffs.getHandoff(handoff.handoffUid)).toMatchObject({
      status: "available",
      claimedBySessionUid: null
    });
    expect(feed.items).toContainEqual(
      expect.objectContaining({
        kind: "available_handoff",
        handoff: expect.objectContaining({
          handoffUid: handoff.handoffUid,
          status: "available"
        })
      })
    );
  });

  it("receives new attention once and advances the session cursor", () => {
    const ping = sessions.pingSession(worker.sessionUid, {
      actorSessionUid: coordinator.sessionUid,
      message: "Pull this ping."
    });

    const received = attention.receiveOnce(worker.sessionUid, worker.sessionToken, {
      includeCurrentHandoffs: false
    });
    const secondReceive = attention.receiveOnce(worker.sessionUid, worker.sessionToken, {
      includeCurrentHandoffs: false
    });

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
    expect(sessions.getSession(worker.sessionUid)?.delivery.lastAckEventId).toBe(
      ping.event.eventId
    );
    expect(secondReceive).toMatchObject({
      fromEventId: ping.event.eventId,
      items: [],
      drained: true
    });
    expect(secondReceive.toEventId).toBeGreaterThanOrEqual(ping.event.eventId);
  });

  it("can receive without advancing the cursor", () => {
    sessions.pingSession(worker.sessionUid, {
      actorSessionUid: coordinator.sessionUid,
      message: "Leave this unread."
    });

    const received = attention.receiveOnce(worker.sessionUid, worker.sessionToken, {
      includeCurrentHandoffs: false,
      advanceCursor: false
    });
    const repeated = attention.receiveOnce(worker.sessionUid, worker.sessionToken, {
      includeCurrentHandoffs: false,
      advanceCursor: false
    });

    expect(received.items).toHaveLength(1);
    expect(repeated.items).toHaveLength(1);
    expect(sessions.getSession(worker.sessionUid)?.delivery.lastAckEventId).toBeNull();
  });

  it("waits for attention inserted during the polling window", async () => {
    const receivedPromise = attention.waitForAttention(worker.sessionUid, worker.sessionToken, {
      includeCurrentHandoffs: false,
      timeoutMs: 500,
      pollIntervalMs: 20
    });

    await delay(40);
    const ping = sessions.pingSession(worker.sessionUid, {
      actorSessionUid: coordinator.sessionUid,
      message: "Arrived while waiting."
    });

    const received = await receivedPromise;

    expect(received.toEventId).toBe(ping.event.eventId);
    expect(received.items).toEqual([
      expect.objectContaining({
        kind: "session_ping"
      })
    ]);
    expect(sessions.getSession(worker.sessionUid)?.delivery.lastAckEventId).toBe(
      ping.event.eventId
    );
  });

  it("waits only until timeout and returns an empty drained result when idle", async () => {
    const startedAt = Date.now();

    const received = await attention.waitForAttention(worker.sessionUid, worker.sessionToken, {
      includeCurrentHandoffs: false,
      timeoutMs: 60,
      pollIntervalMs: 20
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(received).toMatchObject({
      items: [],
      drained: true
    });
  });

  it("requires the owner token even when no attention is waiting", () => {
    expect(() =>
      attention.receiveOnce(worker.sessionUid, "wrong-token", {
        includeCurrentHandoffs: false
      })
    ).toThrow(/invalid session token/i);
  });
});
