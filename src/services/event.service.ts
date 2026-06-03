import type { CollabDatabase } from "../database/connection.js";
import { assertTokenSafePayload, eventTypeRegistry } from "../event-registry.js";
import type { EventRecord, JsonRecord } from "../types.js";

interface EventRow {
  event_id: number;
  handoff_uid: string | null;
  session_uid: string | null;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface RecordEventInput {
  eventType: string;
  payload?: JsonRecord;
  handoffUid?: string | null;
  sessionUid?: string | null;
}

interface ListEventsFilter {
  handoffUid?: string;
  sessionUid?: string;
  eventType?: string;
}

export class EventService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  recordEvent(input: RecordEventInput): EventRecord {
    const createdAt = this.clock().toISOString();
    const payload = input.payload ?? {};
    assertTokenSafePayload(payload);
    const result = this.db
      .prepare(
        `
        INSERT INTO events (handoff_uid, session_uid, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(
        input.handoffUid ?? null,
        input.sessionUid ?? null,
        input.eventType,
        JSON.stringify(payload),
        createdAt
      );

    return {
      eventId: Number(result.lastInsertRowid),
      handoffUid: input.handoffUid ?? null,
      sessionUid: input.sessionUid ?? null,
      eventType: input.eventType,
      payload,
      createdAt
    };
  }

  listEventTypes(): typeof eventTypeRegistry {
    return eventTypeRegistry;
  }

  listEvents(filter: ListEventsFilter = {}): EventRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.handoffUid) {
      clauses.push("handoff_uid = ?");
      params.push(filter.handoffUid);
    }

    if (filter.sessionUid) {
      clauses.push("session_uid = ?");
      params.push(filter.sessionUid);
    }

    if (filter.eventType) {
      clauses.push("event_type = ?");
      params.push(filter.eventType);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
        SELECT event_id, handoff_uid, session_uid, event_type, payload_json, created_at
        FROM events
        ${where}
        ORDER BY event_id ASC
      `
      )
      .all(...params) as EventRow[];

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: EventRow): EventRecord {
    return {
      eventId: row.event_id,
      handoffUid: row.handoff_uid,
      sessionUid: row.session_uid,
      eventType: row.event_type,
      payload: JSON.parse(row.payload_json) as JsonRecord,
      createdAt: row.created_at
    };
  }
}
