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
  `);
}
