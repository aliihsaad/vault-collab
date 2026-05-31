import { randomBytes, randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import { getLeaseTtlMs } from "../lease.js";
import { projectKey } from "../project-key.js";
import type { EventService } from "./event.service.js";
import type {
  ClientType,
  EventRecord,
  JsonRecord,
  PermissionRequestInput,
  PingSessionInput,
  PingSessionResult,
  RegisterSessionInput,
  RegisteredSession,
  SessionDeliveryMode,
  SessionFilters,
  SessionSnapshot,
  SessionStatus
} from "../types.js";

interface SessionRow {
  session_uid: string;
  display_name: string;
  client_type: ClientType;
  project: string;
  project_key: string;
  workspace_path: string;
  status: SessionStatus;
  status_detail: string | null;
  capabilities_json: string;
  agent_uid: string | null;
  agent_stable_name: string | null;
  agent_display_name: string | null;
  agent_role: string | null;
  current_handoff_uid: string | null;
  delivery_mode: SessionDeliveryMode;
  delivery_wakeable: number;
  delivery_last_ack_event_id: number | null;
  delivery_last_ack_at: string | null;
  session_token: string;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
  disconnected_at: string | null;
}

interface SessionOwnerRow {
  session_uid: string;
  session_token: string;
  capabilities_json: string;
}

const leasedHandoffStatuses = [
  "claimed",
  "in_progress",
  "blocked",
  "awaiting_user",
  "verification_needed"
] as const;

export class SessionService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly events: EventService,
    private readonly clock: () => Date = () => new Date()
  ) {}

  registerSession(input: RegisterSessionInput): RegisteredSession {
    const now = this.now();
    const sessionUid = `vc_sess_${randomUUID()}`;
    const sessionToken = randomBytes(32).toString("base64url");
    const deliveryMode = input.delivery?.mode ?? "manual_poll";
    const deliveryWakeable = input.delivery?.wakeable === true ? 1 : 0;

    this.db
      .prepare(
        `
        INSERT INTO sessions (
          session_uid,
          display_name,
          client_type,
          project,
          project_key,
          workspace_path,
          status,
          status_detail,
          capabilities_json,
          agent_uid,
          current_handoff_uid,
          delivery_mode,
          delivery_wakeable,
          delivery_last_ack_event_id,
          delivery_last_ack_at,
          session_token,
          last_heartbeat_at,
          created_at,
          updated_at,
          disconnected_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        sessionUid,
        input.displayName,
        input.clientType,
        input.project,
        projectKey(input.project),
        input.workspacePath,
        "idle",
        null,
        JSON.stringify(input.capabilities ?? {}),
        input.agentUid ?? null,
        null,
        deliveryMode,
        deliveryWakeable,
        null,
        null,
        sessionToken,
        now,
        now,
        now,
        null
      );

    this.events.recordEvent({
      eventType: "session.registered",
      sessionUid,
      payload: {
        clientType: input.clientType,
        project: input.project
      }
    });

    return this.requireSession(sessionUid);
  }

  heartbeatSession(sessionUid: string, sessionToken: string): RegisteredSession {
    return this.updateHeartbeat(sessionUid, sessionToken, true);
  }

  heartbeatSessionSilently(sessionUid: string, sessionToken: string): RegisteredSession {
    return this.updateHeartbeat(sessionUid, sessionToken, false);
  }

  acknowledgeAttention(
    sessionUid: string,
    sessionToken: string,
    latestEventId: number
  ): SessionSnapshot {
    this.assertOwnedSession(sessionUid, sessionToken);
    const acknowledgedAt = this.now();

    this.db
      .prepare(
        `
        UPDATE sessions
        SET delivery_last_ack_event_id = ?,
            delivery_last_ack_at = ?,
            updated_at = ?
        WHERE session_uid = ?
      `
      )
      .run(latestEventId, acknowledgedAt, acknowledgedAt, sessionUid);

    this.events.recordEvent({
      eventType: "session.attention_acknowledged",
      sessionUid,
      payload: {
        latestEventId,
        acknowledgedAt
      }
    });

    return this.requirePublicSession(sessionUid);
  }

  private updateHeartbeat(
    sessionUid: string,
    sessionToken: string,
    recordEvent: boolean
  ): RegisteredSession {
    this.assertOwnedSession(sessionUid, sessionToken);
    const now = this.now();
    this.db
      .prepare(
        `
        UPDATE sessions
        SET last_heartbeat_at = ?, updated_at = ?
        WHERE session_uid = ?
      `
      )
      .run(now, now, sessionUid);
    this.refreshClaimedHandoffLeases(sessionUid);

    if (recordEvent) {
      this.events.recordEvent({
        eventType: "session.heartbeat",
        sessionUid,
        payload: {}
      });
    }

    return this.requireSession(sessionUid);
  }

  updateSessionState(
    sessionUid: string,
    sessionToken: string,
    status: SessionStatus,
    detail: string | null = null
  ): RegisteredSession {
    this.assertOwnedSession(sessionUid, sessionToken);
    const now = this.now();
    this.db
      .prepare(
        `
        UPDATE sessions
        SET status = ?, status_detail = ?, updated_at = ?
        WHERE session_uid = ?
      `
      )
      .run(status, detail, now, sessionUid);

    this.events.recordEvent({
      eventType: "session.state_updated",
      sessionUid,
      payload: {
        status,
        detail
      }
    });

    return this.requireSession(sessionUid);
  }

  pingSession(targetSessionUid: string, input: PingSessionInput = {}): PingSessionResult {
    const target = this.findSessionRow(targetSessionUid);
    if (!target) {
      throw new Error(`Session not found: ${targetSessionUid}`);
    }

    if (target.status === "complete" || target.status === "disconnected") {
      throw new Error(`Cannot ping ${target.status} sessions`);
    }

    const createdAt = this.now();
    const event = this.events.recordEvent({
      eventType: "session.pinged",
      sessionUid: targetSessionUid,
      payload: {
        actorSessionUid: input.actorSessionUid ?? null,
        message: input.message ?? null,
        createdAt
      }
    });

    return {
      event,
      targetSession: this.mapPublicSession(target),
      delivery: this.pingDeliveryState(target)
    };
  }

  requestSessionPermission(
    sessionUid: string,
    sessionToken: string,
    input: PermissionRequestInput
  ): RegisteredSession {
    this.assertNonEmpty(input.question, "Permission question");
    this.assertOwnedSession(sessionUid, sessionToken);
    const now = this.now();

    this.db
      .prepare(
        `
        UPDATE sessions
        SET status = ?, status_detail = ?, updated_at = ?
        WHERE session_uid = ?
      `
      )
      .run("awaiting_user", input.question, now, sessionUid);

    this.events.recordEvent({
      eventType: "session.permission_requested",
      sessionUid,
      payload: {
        permissionRequest: this.permissionRequestPayload(input, now)
      }
    });

    return this.requireSession(sessionUid);
  }

  disconnectSession(sessionUid: string, sessionToken: string): RegisteredSession {
    this.assertOwnedSession(sessionUid, sessionToken);
    const now = this.now();
    this.db
      .prepare(
        `
        UPDATE sessions
        SET status = ?, status_detail = ?, updated_at = ?, disconnected_at = ?
        WHERE session_uid = ?
      `
      )
      .run("disconnected", null, now, now, sessionUid);
    this.expireClaimedHandoffLeases(sessionUid, now);

    this.events.recordEvent({
      eventType: "session.disconnected",
      sessionUid,
      payload: {}
    });

    return this.requireSession(sessionUid);
  }

  renameSession(sessionUid: string, sessionToken: string, displayName: string): SessionSnapshot {
    this.assertNonEmpty(displayName, "Session display name");
    const current = this.assertOwnedSession(sessionUid, sessionToken);
    const now = this.now();
    const trimmedDisplayName = displayName.trim();

    this.db
      .prepare(
        `
        UPDATE sessions
        SET display_name = ?, updated_at = ?
        WHERE session_uid = ?
      `
      )
      .run(trimmedDisplayName, now, sessionUid);

    this.events.recordEvent({
      eventType: "session.renamed",
      sessionUid,
      payload: {
        previousDisplayName: current.display_name,
        displayName: trimmedDisplayName
      }
    });

    return this.requirePublicSession(sessionUid);
  }

  closeSession(
    targetSessionUid: string,
    actorSessionUid: string,
    actorSessionToken: string,
    reason: string | null = null
  ): SessionSnapshot {
    const actor = this.assertOwnedSession(actorSessionUid, actorSessionToken);
    if (targetSessionUid !== actorSessionUid && !this.hasCapability(actor, "sessionAdmin")) {
      throw new Error("Session requires session admin capability");
    }

    const target = this.findSessionRow(targetSessionUid);
    if (!target) {
      throw new Error(`Session not found: ${targetSessionUid}`);
    }

    const now = this.now();
    const statusDetail = reason?.trim() ? reason.trim() : null;
    this.db
      .prepare(
        `
        UPDATE sessions
        SET status = ?,
            status_detail = ?,
            updated_at = ?,
            disconnected_at = ?
        WHERE session_uid = ?
      `
      )
      .run("disconnected", statusDetail, now, now, targetSessionUid);
    this.expireClaimedHandoffLeases(targetSessionUid, now);

    this.events.recordEvent({
      eventType: "session.disconnected",
      sessionUid: targetSessionUid,
      payload: {
        actorSessionUid,
        reason: statusDetail
      }
    });

    return this.requirePublicSession(targetSessionUid);
  }

  listSessions(filter: SessionFilters = {}): SessionSnapshot[] {
    this.disconnectStaleSessions();

    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.clientType) {
      clauses.push("sessions.client_type = ?");
      params.push(filter.clientType);
    }

    if (filter.project) {
      clauses.push("sessions.project_key = ?");
      params.push(projectKey(filter.project));
    }

    if (filter.status) {
      clauses.push("sessions.status = ?");
      params.push(filter.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
        ${this.sessionSelect()}
        FROM sessions
        LEFT JOIN agent_profiles ON agent_profiles.agent_uid = sessions.agent_uid
        ${where}
        ORDER BY sessions.created_at ASC, sessions.session_uid ASC
      `
      )
      .all(...params) as SessionRow[];

    return rows.map((row) => this.mapPublicSession(row));
  }

  getSession(sessionUid: string): SessionSnapshot | null {
    this.disconnectStaleSessions();

    const row = this.findSessionRow(sessionUid);
    return row ? this.mapPublicSession(row) : null;
  }

  getOwnedSession(sessionUid: string, sessionToken: string): SessionSnapshot {
    return this.mapPublicSession(this.assertOwnedSession(sessionUid, sessionToken));
  }

  private assertOwnedSession(sessionUid: string, sessionToken: string): SessionRow {
    const row = this.findSessionRow(sessionUid);
    if (!row) {
      throw new Error(`Session not found: ${sessionUid}`);
    }

    if (row.session_token !== sessionToken) {
      throw new Error("Invalid session token");
    }

    return row;
  }

  private hasCapability(session: SessionOwnerRow, capability: string): boolean {
    const capabilities = JSON.parse(session.capabilities_json) as Record<string, unknown>;
    return capabilities[capability] === true || capabilities.admin === true;
  }

  private assertNonEmpty(value: string, label: string): void {
    if (value.trim() === "") {
      throw new Error(`${label} cannot be empty`);
    }
  }

  private permissionRequestPayload(
    input: PermissionRequestInput,
    createdAt: string
  ): JsonRecord {
    return {
      question: input.question,
      requestedCapability: input.requestedCapability ?? null,
      commandPreview: input.commandPreview ?? null,
      source: input.source ?? "agent",
      createdAt
    };
  }

  private pingDeliveryState(row: SessionRow): PingSessionResult["delivery"] {
    if (row.delivery_mode === "manual_poll") {
      return {
        mode: row.delivery_mode,
        wakeable: row.delivery_wakeable === 1,
        delivered: false,
        nextStep: "Target session must poll attention manually or run a watcher."
      };
    }

    if (row.delivery_wakeable === 1) {
      return {
        mode: row.delivery_mode,
        wakeable: true,
        delivered: false,
        nextStep: "Await receiver acknowledgement."
      };
    }

    return {
      mode: row.delivery_mode,
      wakeable: false,
      delivered: false,
      nextStep: "Receiver is not verified; start a watcher or use a wakeable managed session."
    };
  }

  private refreshClaimedHandoffLeases(sessionUid: string): void {
    this.db
      .prepare(
        `
        UPDATE handoffs
        SET lease_expires_at = ?
        WHERE claimed_by_session_uid = ?
          AND status IN (${leasedHandoffStatuses.map(() => "?").join(", ")})
      `
      )
      .run(this.leaseExpiresAt(), sessionUid, ...leasedHandoffStatuses);
  }

  private expireClaimedHandoffLeases(sessionUid: string, expiresAt: string): void {
    this.db
      .prepare(
        `
        UPDATE handoffs
        SET lease_expires_at = ?
        WHERE claimed_by_session_uid = ?
          AND status IN (${leasedHandoffStatuses.map(() => "?").join(", ")})
      `
      )
      .run(expiresAt, sessionUid, ...leasedHandoffStatuses);
  }

  private leaseExpiresAt(): string {
    return new Date(this.clock().getTime() + getLeaseTtlMs()).toISOString();
  }

  private disconnectStaleSessions(): void {
    const now = this.now();
    const staleBefore = new Date(this.clock().getTime() - getLeaseTtlMs()).toISOString();
    const rows = this.db
      .prepare(
        `
        SELECT session_uid
        FROM sessions
        WHERE last_heartbeat_at < ?
          AND status NOT IN (?, ?)
      `
      )
      .all(staleBefore, "complete", "disconnected") as Array<{ session_uid: string }>;

    if (rows.length === 0) {
      return;
    }

    const disconnect = this.db.transaction(() => {
      const updateSession = this.db.prepare(
        `
        UPDATE sessions
        SET status = ?,
            status_detail = ?,
            updated_at = ?,
            disconnected_at = ?
        WHERE session_uid = ?
      `
      );

      for (const row of rows) {
        updateSession.run(
          "disconnected",
          "Disconnected after stale heartbeat.",
          now,
          now,
          row.session_uid
        );
        this.expireClaimedHandoffLeases(row.session_uid, now);
        this.events.recordEvent({
          eventType: "session.disconnected",
          sessionUid: row.session_uid,
          payload: {
            reason: "stale_heartbeat",
            staleBefore
          }
        });
      }
    });

    disconnect();
  }

  private requireSession(sessionUid: string): RegisteredSession {
    const row = this.findSessionRow(sessionUid);
    if (!row) {
      throw new Error(`Session not found: ${sessionUid}`);
    }

    return this.mapRegisteredSession(row);
  }

  private requirePublicSession(sessionUid: string): SessionSnapshot {
    const session = this.getSession(sessionUid);
    if (!session) {
      throw new Error(`Session not found: ${sessionUid}`);
    }

    return session;
  }

  private findSessionRow(sessionUid: string): SessionRow | undefined {
    return this.db
      .prepare(
        `
        ${this.sessionSelect()}
        FROM sessions
        LEFT JOIN agent_profiles ON agent_profiles.agent_uid = sessions.agent_uid
        WHERE sessions.session_uid = ?
      `
      )
      .get(sessionUid) as SessionRow | undefined;
  }

  private mapRegisteredSession(row: SessionRow): RegisteredSession {
    return {
      ...this.mapPublicSession(row),
      sessionToken: row.session_token
    };
  }

  private mapPublicSession(row: SessionRow): SessionSnapshot {
    return {
      sessionUid: row.session_uid,
      displayName: row.display_name,
      clientType: row.client_type,
      project: row.project,
      workspacePath: row.workspace_path,
      status: row.status,
      statusDetail: row.status_detail,
      capabilities: JSON.parse(row.capabilities_json) as JsonRecord,
      agentUid: row.agent_uid,
      agentName: row.agent_stable_name,
      agentDisplayName: row.agent_display_name,
      agentRole: row.agent_role,
      currentHandoffUid: row.current_handoff_uid,
      delivery: {
        mode: row.delivery_mode,
        wakeable: row.delivery_wakeable === 1,
        lastAckEventId: row.delivery_last_ack_event_id,
        lastAckAt: row.delivery_last_ack_at
      },
      lastHeartbeatAt: row.last_heartbeat_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      disconnectedAt: row.disconnected_at
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private sessionSelect(): string {
    return `
        SELECT
          sessions.session_uid,
          sessions.display_name,
          sessions.client_type,
          sessions.project,
          sessions.project_key,
          sessions.workspace_path,
          sessions.status,
          sessions.status_detail,
          sessions.capabilities_json,
          sessions.agent_uid,
          agent_profiles.stable_name AS agent_stable_name,
          agent_profiles.display_name AS agent_display_name,
          agent_profiles.role AS agent_role,
          sessions.current_handoff_uid,
          sessions.delivery_mode,
          sessions.delivery_wakeable,
          sessions.delivery_last_ack_event_id,
          sessions.delivery_last_ack_at,
          sessions.session_token,
          sessions.last_heartbeat_at,
          sessions.created_at,
          sessions.updated_at,
          sessions.disconnected_at
    `;
  }
}
