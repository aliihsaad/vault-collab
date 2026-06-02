import type Database from "better-sqlite3";
import { getLeaseTtlMs } from "../lease.js";
import { projectKey } from "../project-key.js";
import {
  builtInRoleLabelRoutes,
  builtInRoleProfileAliases,
  builtInRoleProfiles,
  labelRouteUid
} from "../role-profiles.js";
import type { CoreRoleProfileId } from "../types.js";

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_uid TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      client_type TEXT NOT NULL,
      project TEXT NOT NULL,
      project_key TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'implementer',
      status TEXT NOT NULL,
      status_detail TEXT,
      capabilities_json TEXT NOT NULL,
      agent_uid TEXT,
      current_handoff_uid TEXT,
      delivery_mode TEXT NOT NULL DEFAULT 'manual_poll',
      delivery_wakeable INTEGER NOT NULL DEFAULT 0,
      delivery_last_ack_event_id INTEGER,
      delivery_last_ack_at TEXT,
      session_token TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disconnected_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_client_type ON sessions(client_type);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

    CREATE TABLE IF NOT EXISTS agent_profiles (
      agent_uid TEXT PRIMARY KEY,
      stable_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'implementer',
      client_type TEXT,
      project TEXT,
      project_key TEXT,
      description TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_by_session_uid TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_profiles_project ON agent_profiles(project);
    CREATE INDEX IF NOT EXISTS idx_agent_profiles_role ON agent_profiles(role);
    CREATE INDEX IF NOT EXISTS idx_agent_profiles_status ON agent_profiles(status);

    CREATE TABLE IF NOT EXISTS role_profiles (
      role_profile_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL DEFAULT 'vault_collab.role_profile.v1',
      display_name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      lifecycle_stage TEXT NOT NULL,
      default_mutation TEXT NOT NULL,
      capability_set_json TEXT NOT NULL DEFAULT '[]',
      tool_grants_json TEXT NOT NULL DEFAULT '[]',
      trigger_labels_json TEXT NOT NULL DEFAULT '[]',
      requires_evidence_json TEXT NOT NULL DEFAULT '[]',
      output_contract_json TEXT NOT NULL DEFAULT '{}',
      stop_conditions_json TEXT NOT NULL DEFAULT '[]',
      confidence_gates_json TEXT NOT NULL DEFAULT '[]',
      requires_roles_json TEXT NOT NULL DEFAULT '[]',
      suggested_roles_json TEXT NOT NULL DEFAULT '[]',
      suggested_next_roles_json TEXT NOT NULL DEFAULT '[]',
      skills_json TEXT NOT NULL DEFAULT '{"primary":[],"secondary":[]}',
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'built_in',
      sort_order INTEGER NOT NULL DEFAULT 1000,
      is_overridden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS role_provider_support (
      role_profile_id TEXT NOT NULL,
      client_type TEXT NOT NULL,
      support_level TEXT NOT NULL,
      default_permission_mode TEXT,
      notes TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (role_profile_id, client_type)
    );

    CREATE TABLE IF NOT EXISTS role_label_routes (
      route_uid TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      role_profile_id TEXT NOT NULL,
      requirement_kind TEXT NOT NULL DEFAULT 'suggested',
      priority INTEGER NOT NULL DEFAULT 1000,
      evidence_required_json TEXT NOT NULL DEFAULT '[]',
      blocks_completion INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_profile_aliases (
      alias TEXT PRIMARY KEY,
      role_profile_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'legacy',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_role_profiles_status ON role_profiles(status);
    CREATE INDEX IF NOT EXISTS idx_role_profiles_lifecycle_stage ON role_profiles(lifecycle_stage);
    CREATE INDEX IF NOT EXISTS idx_role_provider_support_client ON role_provider_support(client_type);
    CREATE INDEX IF NOT EXISTS idx_role_label_routes_label ON role_label_routes(label);
    CREATE INDEX IF NOT EXISTS idx_role_label_routes_role ON role_label_routes(role_profile_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_role_label_routes_unique_label_profile
      ON role_label_routes(label, role_profile_id);

    CREATE TABLE IF NOT EXISTS launch_requests (
      launch_request_uid TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      project_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      effort_level TEXT,
      workspace_path TEXT NOT NULL,
      role TEXT,
      initial_instructions TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      command_preview TEXT,
      requested_capabilities_json TEXT NOT NULL DEFAULT '[]',
      approval_policy_version TEXT,
      approval_snapshot_json TEXT,
      status TEXT NOT NULL,
      status_detail TEXT,
      requested_by_session_uid TEXT NOT NULL,
      approved_by_session_uid TEXT,
      rejected_by_session_uid TEXT,
      broker_session_uid TEXT,
      launched_session_uid TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      rejected_at TEXT,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_launch_requests_project_key ON launch_requests(project_key);
    CREATE INDEX IF NOT EXISTS idx_launch_requests_status ON launch_requests(status);
    CREATE INDEX IF NOT EXISTS idx_launch_requests_provider ON launch_requests(provider);
    CREATE INDEX IF NOT EXISTS idx_launch_requests_requested_by
      ON launch_requests(requested_by_session_uid);

    CREATE TABLE IF NOT EXISTS handoffs (
      handoff_uid TEXT PRIMARY KEY,
      vault_memory_uid TEXT,
      short_prompt TEXT NOT NULL,
      source_project TEXT NOT NULL,
      source_project_key TEXT NOT NULL,
      target_project TEXT NOT NULL,
      target_project_key TEXT NOT NULL,
      related_projects_json TEXT NOT NULL,
      related_files_json TEXT NOT NULL,
      source_session_uid TEXT,
      suggested_session_uid TEXT,
      suggested_client_type TEXT,
      queue_key TEXT NOT NULL DEFAULT 'default',
      labels_json TEXT NOT NULL DEFAULT '[]',
      queue_position INTEGER,
      depends_on_handoff_uid TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      urgent INTEGER NOT NULL,
      claimed_by_session_uid TEXT,
      claim_token TEXT,
      lease_expires_at TEXT,
      progress_note TEXT,
      resolution_summary TEXT,
      reopen_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      stale_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_handoffs_target_project ON handoffs(target_project);
    CREATE INDEX IF NOT EXISTS idx_handoffs_source_project ON handoffs(source_project);
    CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status);
    CREATE INDEX IF NOT EXISTS idx_handoffs_claimed_by ON handoffs(claimed_by_session_uid);

    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      handoff_uid TEXT,
      session_uid TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_handoff_uid ON events(handoff_uid);
    CREATE INDEX IF NOT EXISTS idx_events_session_uid ON events(session_uid);

    CREATE TABLE IF NOT EXISTS attention_delivery_attempts (
      attempt_uid TEXT PRIMARY KEY,
      session_uid TEXT NOT NULL,
      from_event_id INTEGER NOT NULL,
      to_event_id INTEGER NOT NULL,
      delivery_mode TEXT NOT NULL,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      failed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attention_delivery_attempts_session
      ON attention_delivery_attempts(session_uid);
    CREATE INDEX IF NOT EXISTS idx_attention_delivery_attempts_status
      ON attention_delivery_attempts(status);

    CREATE TABLE IF NOT EXISTS discussion_threads (
      thread_uid TEXT PRIMARY KEY,
      handoff_uid TEXT,
      project TEXT NOT NULL,
      project_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by_session_uid TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_discussion_threads_project ON discussion_threads(project);
    CREATE INDEX IF NOT EXISTS idx_discussion_threads_handoff_uid ON discussion_threads(handoff_uid);
    CREATE INDEX IF NOT EXISTS idx_discussion_threads_status ON discussion_threads(status);

    CREATE TABLE IF NOT EXISTS discussion_messages (
      message_uid TEXT PRIMARY KEY,
      thread_uid TEXT NOT NULL,
      session_uid TEXT,
      agent_uid TEXT,
      message_type TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discussion_messages_thread_uid ON discussion_messages(thread_uid);
    CREATE INDEX IF NOT EXISTS idx_discussion_messages_session_uid ON discussion_messages(session_uid);
  `);

  addColumnIfMissing(db, "sessions", "project_key", "TEXT");
  addColumnIfMissing(db, "sessions", "role", "TEXT NOT NULL DEFAULT 'implementer'");
  addColumnIfMissing(db, "sessions", "role_profile_id", "TEXT");
  addColumnIfMissing(db, "sessions", "agent_uid", "TEXT");
  addColumnIfMissing(db, "sessions", "delivery_mode", "TEXT NOT NULL DEFAULT 'manual_poll'");
  addColumnIfMissing(db, "sessions", "delivery_wakeable", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "delivery_last_ack_event_id", "INTEGER");
  addColumnIfMissing(db, "sessions", "delivery_last_ack_at", "TEXT");
  addColumnIfMissing(db, "agent_profiles", "project_key", "TEXT");
  addColumnIfMissing(db, "agent_profiles", "role_profile_id", "TEXT");
  addColumnIfMissing(
    db,
    "role_profiles",
    "skills_json",
    `TEXT NOT NULL DEFAULT '{"primary":[],"secondary":[]}'`
  );
  addColumnIfMissing(db, "launch_requests", "command_preview", "TEXT");
  addColumnIfMissing(db, "launch_requests", "role_profile_id", "TEXT");
  addColumnIfMissing(db, "launch_requests", "requested_capabilities_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "launch_requests", "approval_policy_version", "TEXT");
  addColumnIfMissing(db, "launch_requests", "approval_snapshot_json", "TEXT");
  addColumnIfMissing(db, "handoffs", "source_project_key", "TEXT");
  addColumnIfMissing(db, "handoffs", "target_project_key", "TEXT");
  addColumnIfMissing(db, "handoffs", "queue_key", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "handoffs", "labels_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "handoffs", "queue_position", "INTEGER");
  addColumnIfMissing(db, "handoffs", "depends_on_handoff_uid", "TEXT");
  addColumnIfMissing(db, "handoffs", "suggested_role_profile_id", "TEXT");
  addColumnIfMissing(db, "handoffs", "lease_expires_at", "TEXT");
  addColumnIfMissing(db, "discussion_threads", "project_key", "TEXT");

  backfillProjectRoutingKeys(db);
  backfillRoleProfileIds(db);
  backfillClaimedHandoffLeases(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project_key ON sessions(project_key);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_uid ON sessions(agent_uid);
    CREATE INDEX IF NOT EXISTS idx_agent_profiles_project_key ON agent_profiles(project_key);
    CREATE INDEX IF NOT EXISTS idx_handoffs_target_project_key ON handoffs(target_project_key);
    CREATE INDEX IF NOT EXISTS idx_handoffs_source_project_key ON handoffs(source_project_key);
    CREATE INDEX IF NOT EXISTS idx_discussion_threads_project_key ON discussion_threads(project_key);
    CREATE INDEX IF NOT EXISTS idx_handoffs_queue ON handoffs(target_project, queue_key, queue_position);
    CREATE INDEX IF NOT EXISTS idx_handoffs_queue_project_key
      ON handoffs(target_project_key, queue_key, queue_position);
    CREATE INDEX IF NOT EXISTS idx_handoffs_lease_expires
      ON handoffs(lease_expires_at)
      WHERE lease_expires_at IS NOT NULL;
  `);
}

export function seedRoleProfiles(
  db: Database.Database,
  clock: () => Date = () => new Date()
): void {
  const now = clock().toISOString();
  const insertProfile = db.prepare(
    `
    INSERT INTO role_profiles (
      role_profile_id,
      schema_version,
      display_name,
      purpose,
      lifecycle_stage,
      default_mutation,
      capability_set_json,
      tool_grants_json,
      trigger_labels_json,
      requires_evidence_json,
      output_contract_json,
      stop_conditions_json,
      confidence_gates_json,
      requires_roles_json,
      suggested_roles_json,
      suggested_next_roles_json,
      skills_json,
      status,
      source,
      sort_order,
      is_overridden,
      created_at,
      updated_at,
      archived_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'built_in', ?, 0, ?, ?, NULL)
    ON CONFLICT(role_profile_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      display_name = excluded.display_name,
      purpose = excluded.purpose,
      lifecycle_stage = excluded.lifecycle_stage,
      default_mutation = excluded.default_mutation,
      capability_set_json = excluded.capability_set_json,
      tool_grants_json = excluded.tool_grants_json,
      trigger_labels_json = excluded.trigger_labels_json,
      requires_evidence_json = excluded.requires_evidence_json,
      output_contract_json = excluded.output_contract_json,
      stop_conditions_json = excluded.stop_conditions_json,
      confidence_gates_json = excluded.confidence_gates_json,
      requires_roles_json = excluded.requires_roles_json,
      suggested_roles_json = excluded.suggested_roles_json,
      suggested_next_roles_json = excluded.suggested_next_roles_json,
      skills_json = excluded.skills_json,
      status = excluded.status,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at,
      archived_at = excluded.archived_at
    WHERE role_profiles.source = 'built_in'
      AND role_profiles.is_overridden = 0
  `
  );
  const insertProviderSupport = db.prepare(
    `
    INSERT INTO role_provider_support (
      role_profile_id,
      client_type,
      support_level,
      default_permission_mode,
      notes,
      capabilities_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(role_profile_id, client_type) DO UPDATE SET
      support_level = excluded.support_level,
      default_permission_mode = excluded.default_permission_mode,
      notes = excluded.notes,
      capabilities_json = excluded.capabilities_json,
      updated_at = excluded.updated_at
  `
  );
  const insertAlias = db.prepare(
    `
    INSERT INTO role_profile_aliases (
      alias,
      role_profile_id,
      source,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(alias) DO UPDATE SET
      role_profile_id = excluded.role_profile_id,
      source = excluded.source,
      updated_at = excluded.updated_at
  `
  );
  const insertRoute = db.prepare(
    `
    INSERT INTO role_label_routes (
      route_uid,
      label,
      role_profile_id,
      requirement_kind,
      priority,
      evidence_required_json,
      blocks_completion,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(label, role_profile_id) DO UPDATE SET
      route_uid = excluded.route_uid,
      requirement_kind = excluded.requirement_kind,
      priority = excluded.priority,
      evidence_required_json = excluded.evidence_required_json,
      blocks_completion = excluded.blocks_completion,
      updated_at = excluded.updated_at
  `
  );

  const seed = db.transaction(() => {
    for (const [index, profile] of builtInRoleProfiles.entries()) {
      insertProfile.run(
        profile.roleProfileId,
        profile.schemaVersion,
        profile.displayName,
        profile.purpose,
        profile.lifecycleStage,
        profile.defaultMutation,
        JSON.stringify(profile.capabilitySet),
        JSON.stringify(profile.toolGrants),
        JSON.stringify(profile.triggerLabels),
        JSON.stringify(profile.requiresEvidence),
        JSON.stringify(profile.outputContract),
        JSON.stringify(profile.stopConditions),
        JSON.stringify(profile.confidenceGates),
        JSON.stringify(profile.requiresRoles),
        JSON.stringify(profile.suggestedRoles),
        JSON.stringify(profile.suggestedNextRoles),
        JSON.stringify(profile.skills),
        profile.status,
        (index + 1) * 100,
        now,
        now
      );

      for (const providerSupport of profile.providerSupport) {
        insertProviderSupport.run(
          profile.roleProfileId,
          providerSupport.clientType,
          providerSupport.supportLevel,
          providerSupport.defaultPermissionMode ?? null,
          providerSupport.notes ?? null,
          JSON.stringify(profile.capabilitySet),
          now,
          now
        );
      }
    }

    for (const alias of builtInRoleProfileAliases) {
      insertAlias.run(alias.alias.toLowerCase(), alias.roleProfileId, alias.source, now, now);
    }

    for (const route of builtInRoleLabelRoutes) {
      insertRoute.run(
        labelRouteUid(route.label, route.roleProfileId),
        route.label.toLowerCase(),
        route.roleProfileId,
        route.requirementKind,
        route.priority,
        JSON.stringify(route.evidenceRequired ?? []),
        route.blocksCompletion === true ? 1 : 0,
        now,
        now
      );
    }
  });

  seed();
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (row) => row.name === column
  );
}

function backfillProjectRoutingKeys(db: Database.Database): void {
  backfillProjectKeyColumn(db, "sessions", "project", "project_key");
  backfillProjectKeyColumn(db, "agent_profiles", "project", "project_key");
  backfillProjectKeyColumn(db, "handoffs", "source_project", "source_project_key");
  backfillProjectKeyColumn(db, "handoffs", "target_project", "target_project_key");
  backfillProjectKeyColumn(db, "discussion_threads", "project", "project_key");
}

function backfillClaimedHandoffLeases(db: Database.Database): void {
  const leaseExpiresAt = new Date(Date.now() + getLeaseTtlMs()).toISOString();
  db.prepare(
    `
    UPDATE handoffs
    SET lease_expires_at = ?
    WHERE lease_expires_at IS NULL
      AND status IN ('claimed', 'in_progress', 'blocked', 'awaiting_user', 'verification_needed')
  `
  ).run(leaseExpiresAt);
}

function backfillRoleProfileIds(db: Database.Database): void {
  backfillRoleProfileColumn(db, "sessions");
  backfillRoleProfileColumn(db, "agent_profiles");
  backfillRoleProfileColumn(db, "launch_requests");
}

function backfillRoleProfileColumn(db: Database.Database, table: string): void {
  if (!columnExists(db, table, "role") || !columnExists(db, table, "role_profile_id")) {
    return;
  }

  const rows = db
    .prepare(
      `
      SELECT rowid AS rowid, role AS role
      FROM ${table}
      WHERE role_profile_id IS NULL
        AND role IS NOT NULL
        AND role <> ''
    `
    )
    .all() as Array<{ rowid: number; role: string | null }>;
  const update = db.prepare(`UPDATE ${table} SET role_profile_id = ? WHERE rowid = ?`);
  const backfill = db.transaction(() => {
    for (const row of rows) {
      const roleProfileId = legacyRoleToProfileId(row.role);
      if (roleProfileId) {
        update.run(roleProfileId, row.rowid);
      }
    }
  });

  backfill();
}

function legacyRoleToProfileId(role: string | null): CoreRoleProfileId | null {
  switch (role?.trim().toLowerCase()) {
    case "coordinator":
      return "coordinator";
    case "explorer":
      return "explorer";
    case "planner":
      return "planner";
    case "architect":
      return "architect";
    case "implementer":
      return "implementer";
    case "reviewer":
    case "observer":
      return "reviewer";
    case "qa":
    case "qa-evaluator":
      return "qa-evaluator";
    case "security":
    case "security-reviewer":
      return "security-reviewer";
    case "docs":
    case "documentation-agent":
      return "documentation-agent";
    case "sweeper":
    case "runtime-agent":
    case "runtime-loop-operator":
      return "runtime-loop-operator";
    case "release-agent":
      return "release-agent";
    case "pattern-miner":
    case "pattern-mining-agent":
      return "pattern-mining-agent";
    case "loop-resolver":
      return "loop-resolver";
    default:
      return null;
  }
}

function backfillProjectKeyColumn(
  db: Database.Database,
  table: string,
  sourceColumn: string,
  keyColumn: string
): void {
  const rows = db
    .prepare(
      `
      SELECT rowid AS rowid, ${sourceColumn} AS project
      FROM ${table}
      WHERE ${keyColumn} IS NULL OR ${keyColumn} = ''
    `
    )
    .all() as Array<{ rowid: number; project: string | null }>;

  const update = db.prepare(`UPDATE ${table} SET ${keyColumn} = ? WHERE rowid = ?`);
  const backfill = db.transaction(() => {
    for (const row of rows) {
      update.run(row.project === null ? null : projectKey(row.project), row.rowid);
    }
  });

  backfill();
}
