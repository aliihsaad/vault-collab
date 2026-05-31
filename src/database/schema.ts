import type Database from "better-sqlite3";
import { getLeaseTtlMs } from "../lease.js";
import { projectKey } from "../project-key.js";

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
  addColumnIfMissing(db, "sessions", "agent_uid", "TEXT");
  addColumnIfMissing(db, "sessions", "delivery_mode", "TEXT NOT NULL DEFAULT 'manual_poll'");
  addColumnIfMissing(db, "sessions", "delivery_wakeable", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "delivery_last_ack_event_id", "INTEGER");
  addColumnIfMissing(db, "sessions", "delivery_last_ack_at", "TEXT");
  addColumnIfMissing(db, "agent_profiles", "project_key", "TEXT");
  addColumnIfMissing(db, "launch_requests", "command_preview", "TEXT");
  addColumnIfMissing(db, "launch_requests", "requested_capabilities_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "launch_requests", "approval_policy_version", "TEXT");
  addColumnIfMissing(db, "launch_requests", "approval_snapshot_json", "TEXT");
  addColumnIfMissing(db, "handoffs", "source_project_key", "TEXT");
  addColumnIfMissing(db, "handoffs", "target_project_key", "TEXT");
  addColumnIfMissing(db, "handoffs", "queue_key", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "handoffs", "labels_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "handoffs", "queue_position", "INTEGER");
  addColumnIfMissing(db, "handoffs", "depends_on_handoff_uid", "TEXT");
  addColumnIfMissing(db, "handoffs", "lease_expires_at", "TEXT");
  addColumnIfMissing(db, "discussion_threads", "project_key", "TEXT");

  backfillProjectRoutingKeys(db);
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
