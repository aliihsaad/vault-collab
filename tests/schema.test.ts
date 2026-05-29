import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/database/schema.js";

describe("Vault Collab schema migrations", () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("adds v2 columns to an existing v1-shaped database", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
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

      CREATE TABLE handoffs (
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

      CREATE TABLE events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        handoff_uid TEXT,
        session_uid TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    applySchema(db);

    const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    const handoffColumns = db.prepare("PRAGMA table_info(handoffs)").all() as Array<{
      name: string;
    }>;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;

    expect(sessionColumns.map((column) => column.name)).toContain("agent_uid");
    expect(handoffColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "queue_key",
        "labels_json",
        "queue_position",
        "depends_on_handoff_uid"
      ])
    );
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "agent_profiles",
        "discussion_threads",
        "discussion_messages"
      ])
    );
  });
});
