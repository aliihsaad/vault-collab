import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { AttentionReceiverService, type ReceiverAdapter } from "../src/services/attention-receiver.service.js";
import { AttentionService } from "../src/services/attention.service.js";
import { DiscussionService } from "../src/services/discussion.service.js";
import { EventService } from "../src/services/event.service.js";
import { HandoffService } from "../src/services/handoff.service.js";
import { LaunchRequestService } from "../src/services/launch-request.service.js";
import { SessionService } from "../src/services/session.service.js";
import type { AttentionDeliveryBatch, RegisteredSession, SessionSnapshot } from "../src/types.js";

const workspacePath = "C:\\workspace\\vault-collab";

describe("AttentionReceiverService", () => {
  let db: CollabDatabase;
  let now: Date;
  let events: EventService;
  let sessions: SessionService;
  let attention: AttentionService;
  let receiver: AttentionReceiverService;
  let deliveredBatches: AttentionDeliveryBatch[];

  beforeEach(() => {
    now = new Date("2026-05-30T15:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    events = new EventService(db, clock);
    const launchRequests = new LaunchRequestService(db, events, clock);
    sessions = new SessionService(db, events, launchRequests, clock);
    const handoffs = new HandoffService(db, events, clock);
    const discussions = new DiscussionService(db, events, clock);
    attention = new AttentionService(db, sessions, handoffs, discussions, events, launchRequests);
    deliveredBatches = [];
    receiver = new AttentionReceiverService(
      db,
      sessions,
      attention,
      fakeAdapter({
        deliver: async (batch) => {
          deliveredBatches.push(batch);
          return {
            delivered: true,
            message: "Delivered to fake adapter."
          };
        }
      }),
      clock
    );
  });

  afterEach(() => {
    db.close();
  });

  it("delivers managed attention through the adapter and acknowledges the latest event", async () => {
    const managed = registerManagedSession();
    const ping = sessions.pingSession(managed.sessionUid, {
      message: "Check managed work."
    });
    now = new Date("2026-05-30T15:00:05.000Z");

    const attempt = await receiver.deliverOnce(managed.sessionUid, managed.sessionToken);

    expect(attempt).toMatchObject({
      sessionUid: managed.sessionUid,
      fromEventId: 0,
      toEventId: ping.event.eventId,
      deliveryMode: "managed_process",
      adapter: "fake",
      status: "delivered",
      message: "Delivered to fake adapter.",
      createdAt: "2026-05-30T15:00:05.000Z",
      deliveredAt: "2026-05-30T15:00:05.000Z",
      failedAt: null
    });
    expect(deliveredBatches).toHaveLength(1);
    expect(deliveredBatches[0]).toMatchObject({
      session: {
        sessionUid: managed.sessionUid
      },
      fromEventId: 0,
      toEventId: ping.event.eventId
    });
    expect(deliveredBatches[0].message).toContain("session_ping");
    expect(deliveredBatches[0].message).toContain("Check managed work.");
    expect(sessions.getSession(managed.sessionUid)?.delivery).toMatchObject({
      lastAckEventId: ping.event.eventId,
      lastAckAt: "2026-05-30T15:00:05.000Z"
    });
    expect(JSON.stringify(attempt)).not.toContain(managed.sessionToken);
    expect(JSON.stringify(deliveredBatches)).not.toContain(managed.sessionToken);
    expect(listAttempts()).toContainEqual(
      expect.objectContaining({
        attempt_uid: attempt.attemptUid,
        session_uid: managed.sessionUid,
        status: "delivered",
        message: "Delivered to fake adapter."
      })
    );
  });

  it("skips manual polling sessions without acknowledging attention", async () => {
    const manual = sessions.registerSession({
      displayName: "Manual Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    sessions.pingSession(manual.sessionUid, {
      message: "Manual target should poll."
    });

    const attempt = await receiver.deliverOnce(manual.sessionUid, manual.sessionToken);

    expect(attempt).toMatchObject({
      sessionUid: manual.sessionUid,
      deliveryMode: "manual_poll",
      adapter: "fake",
      status: "failed",
      message: "Session delivery is not wakeable; target must poll attention manually or run a watcher.",
      deliveredAt: null
    });
    expect(deliveredBatches).toHaveLength(0);
    expect(sessions.getSession(manual.sessionUid)?.delivery.lastAckEventId).toBeNull();
    expect(listAttempts()).toContainEqual(
      expect.objectContaining({
        attempt_uid: attempt.attemptUid,
        session_uid: manual.sessionUid,
        status: "failed",
        message: "Session delivery is not wakeable; target must poll attention manually or run a watcher."
      })
    );
  });

  it("does not acknowledge attention when the adapter fails", async () => {
    const managed = registerManagedSession();
    const ping = sessions.pingSession(managed.sessionUid, {
      message: "This delivery should fail."
    });
    receiver = new AttentionReceiverService(
      db,
      sessions,
      attention,
      fakeAdapter({
        deliver: async () => ({
          delivered: false,
          message: "Adapter write failed."
        })
      }),
      () => now
    );

    const attempt = await receiver.deliverOnce(managed.sessionUid, managed.sessionToken);

    expect(attempt).toMatchObject({
      sessionUid: managed.sessionUid,
      fromEventId: 0,
      toEventId: ping.event.eventId,
      deliveryMode: "managed_process",
      adapter: "fake",
      status: "failed",
      message: "Adapter write failed.",
      deliveredAt: null,
      failedAt: "2026-05-30T15:00:00.000Z"
    });
    expect(sessions.getSession(managed.sessionUid)?.delivery.lastAckEventId).toBeNull();
    expect(listAttempts()).toContainEqual(
      expect.objectContaining({
        attempt_uid: attempt.attemptUid,
        session_uid: managed.sessionUid,
        status: "failed",
        message: "Adapter write failed."
      })
    );
  });

  it("lists delivery attempts by session and status without exposing tokens", async () => {
    const managed = registerManagedSession();
    sessions.pingSession(managed.sessionUid, {
      message: "First delivery."
    });
    const delivered = await receiver.deliverOnce(managed.sessionUid, managed.sessionToken);
    sessions.pingSession(managed.sessionUid, {
      message: "Second delivery fails."
    });
    receiver = new AttentionReceiverService(
      db,
      sessions,
      attention,
      fakeAdapter({
        deliver: async () => ({
          delivered: false,
          message: "Adapter write failed."
        })
      }),
      () => now
    );
    const failed = await receiver.deliverOnce(managed.sessionUid, managed.sessionToken);

    expect(receiver.listDeliveryAttempts({ sessionUid: managed.sessionUid })).toEqual([
      delivered,
      failed
    ]);
    expect(receiver.listDeliveryAttempts({ sessionUid: managed.sessionUid, status: "failed" })).toEqual([
      failed
    ]);
    expect(JSON.stringify(receiver.listDeliveryAttempts({ sessionUid: managed.sessionUid }))).not.toContain(
      managed.sessionToken
    );
  });

  function registerManagedSession(): RegisteredSession {
    return sessions.registerSession({
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
  }

  function listAttempts(): Array<{
    attempt_uid: string;
    session_uid: string;
    status: string;
    message: string | null;
  }> {
    return db
      .prepare(
        "SELECT attempt_uid, session_uid, status, message FROM attention_delivery_attempts ORDER BY created_at ASC"
      )
      .all() as Array<{
      attempt_uid: string;
      session_uid: string;
      status: string;
      message: string | null;
    }>;
  }
});

function fakeAdapter(input: {
  canDeliver?: (session: SessionSnapshot) => boolean;
  deliver: ReceiverAdapter["deliver"];
}): ReceiverAdapter {
  return {
    name: "fake",
    canDeliver: input.canDeliver ?? (() => true),
    deliver: input.deliver
  };
}
