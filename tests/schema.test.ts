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
        "launch_requests",
        "attention_delivery_attempts",
        "discussion_threads",
        "discussion_messages"
      ])
    );
    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        "idx_attention_delivery_attempts_session",
        "idx_attention_delivery_attempts_status"
      ])
    );
  });

  it("backfills persisted project routing keys for existing rows", () => {
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
        agent_uid TEXT,
        current_handoff_uid TEXT,
        session_token TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disconnected_at TEXT
      );

      CREATE TABLE agent_profiles (
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

      CREATE TABLE events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        handoff_uid TEXT,
        session_uid TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE discussion_threads (
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

      CREATE TABLE discussion_messages (
        message_uid TEXT PRIMARY KEY,
        thread_uid TEXT NOT NULL,
        session_uid TEXT,
        agent_uid TEXT,
        message_type TEXT NOT NULL,
        body TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      INSERT INTO sessions (
        session_uid,
        display_name,
        client_type,
        project,
        workspace_path,
        status,
        capabilities_json,
        session_token,
        last_heartbeat_at,
        created_at,
        updated_at
      )
      VALUES (
        'vc_sess_existing',
        'Existing Codex',
        'codex',
        'Vault Collab',
        'C:\\workspace\\vault-collab',
        'idle',
        '{}',
        'token',
        '2026-05-28T10:00:00.000Z',
        '2026-05-28T10:00:00.000Z',
        '2026-05-28T10:00:00.000Z'
      );

      INSERT INTO agent_profiles (
        agent_uid,
        stable_name,
        display_name,
        role,
        client_type,
        project,
        capabilities_json,
        status,
        created_at,
        updated_at
      )
      VALUES (
        'vc_agent_existing',
        'repo-coordinator',
        'Repo Coordinator',
        'coordinator',
        'codex',
        'Vault Collab',
        '{}',
        'active',
        '2026-05-28T10:00:00.000Z',
        '2026-05-28T10:00:00.000Z'
      );

      INSERT INTO handoffs (
        handoff_uid,
        short_prompt,
        source_project,
        target_project,
        related_projects_json,
        related_files_json,
        queue_key,
        labels_json,
        queue_position,
        status,
        priority,
        urgent,
        created_at,
        updated_at
      )
      VALUES (
        'vc_handoff_existing',
        'Existing handoff',
        'Vault Collab',
        'vault_collab',
        '[]',
        '[]',
        'default',
        '[]',
        1000,
        'available',
        'normal',
        0,
        '2026-05-28T10:00:00.000Z',
        '2026-05-28T10:00:00.000Z'
      );

      INSERT INTO discussion_threads (
        thread_uid,
        project,
        title,
        status,
        created_at,
        updated_at
      )
      VALUES (
        'vc_thread_existing',
        'Vault Collab',
        'Existing discussion',
        'open',
        '2026-05-28T10:00:00.000Z',
        '2026-05-28T10:00:00.000Z'
      );
    `);

    applySchema(db);

    expect(columnNames(db, "sessions")).toContain("project_key");
    expect(columnNames(db, "agent_profiles")).toContain("project_key");
    expect(columnNames(db, "handoffs")).toEqual(
      expect.arrayContaining(["source_project_key", "target_project_key"])
    );
    expect(columnNames(db, "discussion_threads")).toContain("project_key");

    expect(
      db.prepare("SELECT project_key FROM sessions WHERE session_uid = ?").get("vc_sess_existing")
    ).toEqual({ project_key: "vault-collab" });
    expect(
      db
        .prepare("SELECT project_key FROM agent_profiles WHERE agent_uid = ?")
        .get("vc_agent_existing")
    ).toEqual({ project_key: "vault-collab" });
    expect(
      db
        .prepare(
          "SELECT source_project_key, target_project_key FROM handoffs WHERE handoff_uid = ?"
        )
        .get("vc_handoff_existing")
    ).toEqual({
      source_project_key: "vault-collab",
      target_project_key: "vault-collab"
    });
    expect(
      db
        .prepare("SELECT project_key FROM discussion_threads WHERE thread_uid = ?")
        .get("vc_thread_existing")
    ).toEqual({ project_key: "vault-collab" });
  });

  it("creates the launch request broker table for existing databases", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        session_uid TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        client_type TEXT NOT NULL,
        project TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        session_token TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

    expect(columnNames(db, "launch_requests")).toEqual(
      expect.arrayContaining([
        "launch_request_uid",
        "project_key",
        "provider",
        "model",
        "workspace_path",
        "initial_instructions",
        "permission_mode",
        "status",
        "requested_by_session_uid",
        "approved_by_session_uid",
        "broker_session_uid",
        "launched_session_uid",
        "metadata_json"
      ])
    );
  });
});

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

function indexNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
      name: string;
    }>
  ).map((index) => index.name);
}
