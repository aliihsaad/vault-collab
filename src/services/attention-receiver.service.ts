/**
 * @deprecated Superseded by the pull-based receive model (`vault_collab_receive`
 * and CLI `receive --wait`). Keep this service functional until The Vault
 * dashboard fully migrates away from host-owned push/wake delivery.
 */
import { randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import type { AttentionService } from "./attention.service.js";
import type { SessionService } from "./session.service.js";
import type {
  AttentionDeliveryAdapterResult,
  AttentionDeliveryAttempt,
  AttentionDeliveryAttemptFilters,
  AttentionDeliveryAttemptStatus,
  AttentionDeliveryBatch,
  SessionDeliveryMode,
  SessionSnapshot
} from "../types.js";

interface AttentionDeliveryAttemptRow {
  attempt_uid: string;
  session_uid: string;
  from_event_id: number;
  to_event_id: number;
  delivery_mode: SessionDeliveryMode;
  adapter: string;
  status: AttentionDeliveryAttemptStatus;
  message: string | null;
  created_at: string;
  delivered_at: string | null;
  failed_at: string | null;
}

export interface ReceiverAdapter {
  name: string;
  canDeliver(session: SessionSnapshot): boolean;
  deliver(batch: AttentionDeliveryBatch): Promise<AttentionDeliveryAdapterResult>;
}

export class AttentionReceiverService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly sessions: SessionService,
    private readonly attention: AttentionService,
    private readonly adapter: ReceiverAdapter,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async deliverOnce(sessionUid: string, sessionToken: string): Promise<AttentionDeliveryAttempt> {
    const session = this.sessions.getSession(sessionUid);
    if (!session) {
      throw new Error(`Session not found: ${sessionUid}`);
    }

    const fromEventId = session.delivery.lastAckEventId ?? 0;
    const feed = this.attention.getSessionAttention(sessionUid, {
      sinceEventId: fromEventId,
      includeCurrentHandoffs: true
    });
    const createdAt = this.now();

    if (feed.items.length === 0) {
      return this.recordAttempt(this.failedAttempt(
        session,
        fromEventId,
        feed.latestEventId,
        "No attention to deliver.",
        createdAt
      ));
    }

    if (session.delivery.mode === "manual_poll" || !session.delivery.wakeable) {
      return this.recordAttempt(this.failedAttempt(
        session,
        fromEventId,
        feed.latestEventId,
        "Session delivery is not wakeable; target must poll attention manually or run a watcher.",
        createdAt
      ));
    }

    if (!this.adapter.canDeliver(session)) {
      return this.recordAttempt(this.failedAttempt(
        session,
        fromEventId,
        feed.latestEventId,
        `Adapter ${this.adapter.name} cannot deliver to this session.`,
        createdAt
      ));
    }

    const batch: AttentionDeliveryBatch = {
      session,
      fromEventId,
      toEventId: feed.latestEventId,
      items: feed.items,
      message: this.composeMessage(feed.items)
    };
    const result = await this.adapter.deliver(batch);
    const finishedAt = this.now();

    if (!result.delivered) {
      return this.recordAttempt(this.failedAttempt(
        session,
        fromEventId,
        feed.latestEventId,
        result.message ?? "Adapter delivery failed.",
        finishedAt
      ));
    }

    this.sessions.acknowledgeAttention(sessionUid, sessionToken, feed.latestEventId);

    return this.recordAttempt({
      attemptUid: this.attemptUid(),
      sessionUid,
      fromEventId,
      toEventId: feed.latestEventId,
      deliveryMode: session.delivery.mode,
      adapter: this.adapter.name,
      status: "delivered",
      message: result.message ?? null,
      createdAt,
      deliveredAt: finishedAt,
      failedAt: null
    });
  }

  listDeliveryAttempts(
    filters: AttentionDeliveryAttemptFilters = {}
  ): AttentionDeliveryAttempt[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filters.sessionUid) {
      clauses.push("session_uid = ?");
      params.push(filters.sessionUid);
    }

    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM attention_delivery_attempts
        ${where}
        ORDER BY created_at ASC, rowid ASC
      `
      )
      .all(...params) as AttentionDeliveryAttemptRow[];

    return rows.map((row) => this.mapAttempt(row));
  }

  private failedAttempt(
    session: SessionSnapshot,
    fromEventId: number,
    toEventId: number,
    message: string,
    at: string
  ): AttentionDeliveryAttempt {
    return {
      attemptUid: this.attemptUid(),
      sessionUid: session.sessionUid,
      fromEventId,
      toEventId,
      deliveryMode: session.delivery.mode,
      adapter: this.adapter.name,
      status: "failed",
      message,
      createdAt: at,
      deliveredAt: null,
      failedAt: at
    };
  }

  private composeMessage(items: AttentionDeliveryBatch["items"]): string {
    const lines = ["Vault Collab attention:"];
    for (const item of items) {
      const fragments: string[] = [item.kind];
      if (item.event?.payload.message && typeof item.event.payload.message === "string") {
        fragments.push(item.event.payload.message);
      } else if (item.handoff) {
        fragments.push(`${item.handoff.handoffUid}: ${item.handoff.shortPrompt}`);
      } else if (item.launchRequest) {
        fragments.push(`${item.launchRequest.launchRequestUid}: ${item.launchRequest.model}`);
      }
      lines.push(`- ${fragments.join(" - ")}`);
    }
    lines.push("Inspect attention before acting. Do not auto-claim unless appropriate.");
    return lines.join("\n");
  }

  private recordAttempt(attempt: AttentionDeliveryAttempt): AttentionDeliveryAttempt {
    this.db
      .prepare(
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
      )
      .run(
        attempt.attemptUid,
        attempt.sessionUid,
        attempt.fromEventId,
        attempt.toEventId,
        attempt.deliveryMode,
        attempt.adapter,
        attempt.status,
        attempt.message,
        attempt.createdAt,
        attempt.deliveredAt,
        attempt.failedAt
      );

    return attempt;
  }

  private mapAttempt(row: AttentionDeliveryAttemptRow): AttentionDeliveryAttempt {
    return {
      attemptUid: row.attempt_uid,
      sessionUid: row.session_uid,
      fromEventId: row.from_event_id,
      toEventId: row.to_event_id,
      deliveryMode: row.delivery_mode,
      adapter: row.adapter,
      status: row.status,
      message: row.message,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      failedAt: row.failed_at
    };
  }

  private attemptUid(): string {
    return `vc_delivery_${randomUUID()}`;
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
