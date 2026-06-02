import { randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import { projectKey } from "../project-key.js";
import { roleProfileToDefinition } from "../role-profiles.js";
import type { EventService } from "./event.service.js";
import { resolveRoleProfileIdFromDb } from "./role-profile-resolution.js";
import type {
  AgentProfile,
  AgentProfileFilters,
  AgentProfileStatus,
  AgentRoleDefinition,
  BuiltInAgentRole,
  ClientType,
  JsonRecord,
  RoleLabelRoute,
  RoleProfile,
  UpsertAgentProfileInput
} from "../types.js";

interface AgentProfileRow {
  agent_uid: string;
  stable_name: string;
  display_name: string;
  role: string;
  role_profile_id: string | null;
  client_type: ClientType | null;
  project: string | null;
  project_key: string | null;
  description: string | null;
  capabilities_json: string;
  status: AgentProfileStatus;
  created_by_session_uid: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface RoleProfileRow {
  role_profile_id: RoleProfile["roleProfileId"];
  schema_version: RoleProfile["schemaVersion"];
  display_name: string;
  purpose: string;
  lifecycle_stage: RoleProfile["lifecycleStage"];
  default_mutation: RoleProfile["defaultMutation"];
  capability_set_json: string;
  tool_grants_json: string;
  trigger_labels_json: string;
  requires_evidence_json: string;
  output_contract_json: string;
  stop_conditions_json: string;
  confidence_gates_json: string;
  requires_roles_json: string;
  suggested_roles_json: string;
  suggested_next_roles_json: string;
  skills_json: string;
  status: RoleProfile["status"];
}

interface RoleProviderSupportRow {
  client_type: RoleProfile["providerSupport"][number]["clientType"];
  support_level: RoleProfile["providerSupport"][number]["supportLevel"];
  default_permission_mode: string | null;
  notes: string | null;
}

interface RoleLabelRouteRow {
  route_uid: string;
  label: string;
  role_profile_id: RoleLabelRoute["roleProfileId"];
  requirement_kind: RoleLabelRoute["requirementKind"];
  priority: number;
  evidence_required_json: string;
  blocks_completion: 0 | 1;
  created_at: string;
  updated_at: string;
}

export class AgentProfileService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly events: EventService,
    private readonly clock: () => Date = () => new Date()
  ) {}

  listRoleDefinitions(): AgentRoleDefinition[] {
    return this.listRoleProfiles().map((role) => roleProfileToDefinition(role));
  }

  listRoleProfiles(): RoleProfile[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM role_profiles
        WHERE status = 'active'
        ORDER BY sort_order ASC, role_profile_id ASC
      `
      )
      .all() as RoleProfileRow[];

    return rows.map((row) => this.mapRoleProfileRow(row));
  }

  resolveRoleProfileId(roleOrAlias: string | null | undefined): string | null {
    return resolveRoleProfileIdFromDb(this.db, roleOrAlias);
  }

  listRoleLabelRoutes(label?: string): RoleLabelRoute[] {
    const normalized = label?.trim().toLowerCase();
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM role_label_routes
        ${normalized ? "WHERE label = ?" : ""}
        ORDER BY priority ASC, label ASC, role_profile_id ASC
      `
      )
      .all(...(normalized ? [normalized] : [])) as RoleLabelRouteRow[];

    return rows.map((row) => ({
      routeUid: row.route_uid,
      label: row.label,
      roleProfileId: row.role_profile_id,
      requirementKind: row.requirement_kind,
      priority: row.priority,
      evidenceRequired: JSON.parse(row.evidence_required_json) as EvidenceArray,
      blocksCompletion: row.blocks_completion === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  upsertAgentProfile(input: UpsertAgentProfileInput): AgentProfile {
    const now = this.now();
    const existing = this.findByStableName(input.stableName);
    const role = input.role ?? ("implementer" satisfies BuiltInAgentRole);
    const roleProfileId = this.resolveRoleProfileId(input.roleProfileId ?? role);
    const status = input.status ?? "active";
    const archivedAt = status === "archived" ? now : null;
    const profileProjectKey = input.project ? projectKey(input.project) : null;

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE agent_profiles
          SET display_name = ?,
              role = ?,
              role_profile_id = ?,
              client_type = ?,
              project = ?,
              project_key = ?,
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
          roleProfileId,
          input.clientType ?? null,
          input.project ?? null,
          profileProjectKey,
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
          role_profile_id,
          client_type,
          project,
          project_key,
          description,
          capabilities_json,
          status,
          created_by_session_uid,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        agentUid,
        input.stableName,
        input.displayName,
        role,
        roleProfileId,
        input.clientType ?? null,
        input.project ?? null,
        profileProjectKey,
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

    if (filter.role) {
      clauses.push("role = ?");
      params.push(filter.role);
    }

    if (filter.project) {
      clauses.push("project_key = ?");
      params.push(projectKey(filter.project));
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
      roleProfileId: row.role_profile_id,
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

  private mapRoleProfileRow(row: RoleProfileRow): RoleProfile {
    return {
      roleProfileId: row.role_profile_id,
      schemaVersion: row.schema_version,
      displayName: row.display_name,
      purpose: row.purpose,
      lifecycleStage: row.lifecycle_stage,
      defaultMutation: row.default_mutation,
      capabilitySet: JSON.parse(row.capability_set_json) as RoleProfile["capabilitySet"],
      toolGrants: JSON.parse(row.tool_grants_json) as RoleProfile["toolGrants"],
      triggerLabels: JSON.parse(row.trigger_labels_json) as RoleProfile["triggerLabels"],
      requiresEvidence: JSON.parse(row.requires_evidence_json) as RoleProfile["requiresEvidence"],
      outputContract: JSON.parse(row.output_contract_json) as RoleProfile["outputContract"],
      stopConditions: JSON.parse(row.stop_conditions_json) as RoleProfile["stopConditions"],
      confidenceGates: JSON.parse(row.confidence_gates_json) as RoleProfile["confidenceGates"],
      requiresRoles: JSON.parse(row.requires_roles_json) as RoleProfile["requiresRoles"],
      suggestedRoles: JSON.parse(row.suggested_roles_json) as RoleProfile["suggestedRoles"],
      suggestedNextRoles: JSON.parse(row.suggested_next_roles_json) as RoleProfile["suggestedNextRoles"],
      skills: JSON.parse(row.skills_json) as RoleProfile["skills"],
      providerSupport: this.listProviderSupport(row.role_profile_id),
      status: row.status
    };
  }

  private listProviderSupport(roleProfileId: string): RoleProfile["providerSupport"] {
    const rows = this.db
      .prepare(
        `
        SELECT
          client_type,
          support_level,
          default_permission_mode,
          notes
        FROM role_provider_support
        WHERE role_profile_id = ?
        ORDER BY client_type ASC
      `
      )
      .all(roleProfileId) as RoleProviderSupportRow[];

    return rows.map((row) => ({
      clientType: row.client_type,
      supportLevel: row.support_level,
      defaultPermissionMode: row.default_permission_mode,
      notes: row.notes
    }));
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

type EvidenceArray = RoleLabelRoute["evidenceRequired"];
