import type Database from "better-sqlite3";

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_uid TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      client_type TEXT NOT NULL,
      project TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL,
      status_detail TEXT,
      capabilities_json TEXT NOT NULL,
      agent_uid TEXT,
      current_handoff_uid TEXT,
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

    CREATE TABLE IF NOT EXISTS handoffs (
      handoff_uid TEXT PRIMARY KEY,
      vault_memory_uid TEXT,
      short_prompt TEXT NOT NULL,
      source_project TEXT NOT NULL,
      target_project TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS discussion_threads (
      thread_uid TEXT PRIMARY KEY,
      handoff_uid TEXT,
      project TEXT NOT NULL,
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

  addColumnIfMissing(db, "sessions", "agent_uid", "TEXT");
  addColumnIfMissing(db, "handoffs", "queue_key", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "handoffs", "labels_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "handoffs", "queue_position", "INTEGER");
  addColumnIfMissing(db, "handoffs", "depends_on_handoff_uid", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_uid ON sessions(agent_uid);
    CREATE INDEX IF NOT EXISTS idx_handoffs_queue ON handoffs(target_project, queue_key, queue_position);
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
