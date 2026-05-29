import { randomBytes, randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import type { EventService } from "./event.service.js";
import type {
  ClientType,
  EventRecord,
  JsonRecord,
  PermissionRequestInput,
  PingSessionInput,
  RegisterSessionInput,
  RegisteredSession,
  SessionFilters,
  SessionSnapshot,
  SessionStatus
} from "../types.js";

interface SessionRow {
  session_uid: string;
  display_name: string;
  client_type: ClientType;
  project: string;
  workspace_path: string;
  status: SessionStatus;
  status_detail: string | null;
  capabilities_json: string;
  agent_uid: string | null;
  agent_stable_name: string | null;
  agent_display_name: string | null;
  agent_role: string | null;
  current_handoff_uid: string | null;
  session_token: string;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
  disconnected_at: string | null;
}

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

    this.db
      .prepare(
        `
        INSERT INTO sessions (
          session_uid,
          display_name,
          client_type,
          project,
          workspace_path,
          status,
          status_detail,
          capabilities_json,
          agent_uid,
          current_handoff_uid,
          session_token,
          last_heartbeat_at,
          created_at,
          updated_at,
          disconnected_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        sessionUid,
        input.displayName,
        input.clientType,
        input.project,
        input.workspacePath,
        "idle",
        null,
        JSON.stringify(input.capabilities ?? {}),
        input.agentUid ?? null,
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

  pingSession(targetSessionUid: string, input: PingSessionInput = {}): EventRecord {
    if (!this.findSessionRow(targetSessionUid)) {
      throw new Error(`Session not found: ${targetSessionUid}`);
    }

    const createdAt = this.now();
    return this.events.recordEvent({
      eventType: "session.pinged",
      sessionUid: targetSessionUid,
      payload: {
        actorSessionUid: input.actorSessionUid ?? null,
        message: input.message ?? null,
        createdAt
      }
    });
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

    this.events.recordEvent({
      eventType: "session.disconnected",
      sessionUid,
      payload: {}
    });

    return this.requireSession(sessionUid);
  }

  listSessions(filter: SessionFilters = {}): SessionSnapshot[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.project) {
      clauses.push("sessions.project = ?");
      params.push(filter.project);
    }

    if (filter.clientType) {
      clauses.push("sessions.client_type = ?");
      params.push(filter.clientType);
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
    const row = this.findSessionRow(sessionUid);
    return row ? this.mapPublicSession(row) : null;
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

  private requireSession(sessionUid: string): RegisteredSession {
    const row = this.findSessionRow(sessionUid);
    if (!row) {
      throw new Error(`Session not found: ${sessionUid}`);
    }

    return this.mapRegisteredSession(row);
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
          sessions.workspace_path,
          sessions.status,
          sessions.status_detail,
          sessions.capabilities_json,
          sessions.agent_uid,
          agent_profiles.stable_name AS agent_stable_name,
          agent_profiles.display_name AS agent_display_name,
          agent_profiles.role AS agent_role,
          sessions.current_handoff_uid,
          sessions.session_token,
          sessions.last_heartbeat_at,
          sessions.created_at,
          sessions.updated_at,
          sessions.disconnected_at
    `;
  }
}
