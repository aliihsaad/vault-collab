import { randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import type { EventService } from "./event.service.js";
import type {
  AgentProfile,
  AgentProfileFilters,
  AgentProfileStatus,
  AgentRoleDefinition,
  BuiltInAgentRole,
  ClientType,
  JsonRecord,
  UpsertAgentProfileInput
} from "../types.js";

interface AgentProfileRow {
  agent_uid: string;
  stable_name: string;
  display_name: string;
  role: string;
  client_type: ClientType | null;
  project: string | null;
  description: string | null;
  capabilities_json: string;
  status: AgentProfileStatus;
  created_by_session_uid: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

const builtInRoleDefinitions: AgentRoleDefinition[] = [
  {
    role: "coordinator",
    label: "Coordinator",
    description: "Routes work, tracks sequencing, and asks for user decisions."
  },
  {
    role: "implementer",
    label: "Implementer",
    description: "Builds scoped code changes and reports verification evidence."
  },
  {
    role: "reviewer",
    label: "Reviewer",
    description: "Checks contracts, safety, regressions, and missing tests."
  },
  {
    role: "sweeper",
    label: "Sweeper",
    description: "Finds loose ends, stale handoffs, and follow-up cleanup."
  },
  {
    role: "observer",
    label: "Observer",
    description: "Watches state without owning implementation work."
  }
];

export class AgentProfileService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly events: EventService,
    private readonly clock: () => Date = () => new Date()
  ) {}

  listRoleDefinitions(): AgentRoleDefinition[] {
    return builtInRoleDefinitions.map((role) => ({ ...role }));
  }

  upsertAgentProfile(input: UpsertAgentProfileInput): AgentProfile {
    const now = this.now();
    const existing = this.findByStableName(input.stableName);
    const role = input.role ?? ("implementer" satisfies BuiltInAgentRole);
    const status = input.status ?? "active";
    const archivedAt = status === "archived" ? now : null;

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE agent_profiles
          SET display_name = ?,
              role = ?,
              client_type = ?,
              project = ?,
              description = ?,
              capabilities_json = ?,
              status = ?,
              created_by_session_uid = ?,
              updated_at = ?,
              archived_at = ?
          WHERE agent_uid = ?
        `
        )
        .run(
          input.displayName,
          role,
          input.clientType ?? null,
          input.project ?? null,
          input.description ?? null,
          JSON.stringify(input.capabilities ?? {}),
          status,
          input.createdBySessionUid ?? existing.created_by_session_uid,
          now,
          archivedAt,
          existing.agent_uid
        );

      this.recordUpsertEvent(existing.agent_uid, input.createdBySessionUid ?? null);
      return this.requireAgentProfile(existing.agent_uid);
    }

    const agentUid = `vc_agent_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO agent_profiles (
          agent_uid,
          stable_name,
          display_name,
          role,
          client_type,
          project,
          description,
          capabilities_json,
          status,
          created_by_session_uid,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        agentUid,
        input.stableName,
        input.displayName,
        role,
        input.clientType ?? null,
        input.project ?? null,
        input.description ?? null,
        JSON.stringify(input.capabilities ?? {}),
        status,
        input.createdBySessionUid ?? null,
        now,
        now,
        archivedAt
      );

    this.recordUpsertEvent(agentUid, input.createdBySessionUid ?? null);
    return this.requireAgentProfile(agentUid);
  }

  listAgentProfiles(filter: AgentProfileFilters = {}): AgentProfile[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.project) {
      clauses.push("project = ?");
      params.push(filter.project);
    }

    if (filter.role) {
      clauses.push("role = ?");
      params.push(filter.role);
    }

    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM agent_profiles
        ${where}
        ORDER BY created_at ASC, stable_name ASC
      `
      )
      .all(...params) as AgentProfileRow[];

    return rows.map((row) => this.mapRow(row));
  }

  getAgentProfile(agentUid: string): AgentProfile | null {
    const row = this.findAgentProfileRow(agentUid);
    return row ? this.mapRow(row) : null;
  }

  private requireAgentProfile(agentUid: string): AgentProfile {
    const row = this.findAgentProfileRow(agentUid);
    if (!row) {
      throw new Error(`Agent profile not found: ${agentUid}`);
    }

    return this.mapRow(row);
  }

  private findByStableName(stableName: string): AgentProfileRow | undefined {
    return this.db
      .prepare("SELECT * FROM agent_profiles WHERE stable_name = ?")
      .get(stableName) as AgentProfileRow | undefined;
  }

  private findAgentProfileRow(agentUid: string): AgentProfileRow | undefined {
    return this.db
      .prepare("SELECT * FROM agent_profiles WHERE agent_uid = ?")
      .get(agentUid) as AgentProfileRow | undefined;
  }

  private recordUpsertEvent(agentUid: string, sessionUid: string | null): void {
    this.events.recordEvent({
      eventType: "agent_profile.upserted",
      sessionUid,
      payload: {
        agentUid
      }
    });
  }

  private mapRow(row: AgentProfileRow): AgentProfile {
    return {
      agentUid: row.agent_uid,
      stableName: row.stable_name,
      displayName: row.display_name,
      role: row.role,
      clientType: row.client_type,
      project: row.project,
      description: row.description,
      capabilities: JSON.parse(row.capabilities_json) as JsonRecord,
      status: row.status,
      createdBySessionUid: row.created_by_session_uid,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
