import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createCollabDatabase } from "../src/database/connection.js";
import { applySchema, seedRoleProfiles } from "../src/database/schema.js";

const expectedCoreRoleProfileIds = [
  "coordinator",
  "explorer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
  "qa-evaluator",
  "security-reviewer",
  "documentation-agent",
  "runtime-loop-operator",
  "release-agent",
  "pattern-mining-agent",
  "loop-resolver"
];

const expectedRoleSkillNames: Record<
  string,
  {
    primary: string[];
    secondary: string[];
  }
> = {
  coordinator: {
    primary: [
      "project-flow-ops",
      "plan-orchestrate",
      "team-builder",
      "parallel-execution-optimizer",
      "agent-sort",
      "council",
      "automation-audit-ops"
    ],
    secondary: [
      "dmux-workflows",
      "claude-devfleet",
      "enterprise-agent-ops",
      "unified-notifications-ops",
      "cost-tracking"
    ]
  },
  explorer: {
    primary: [
      "codebase-onboarding",
      "search-first",
      "research-ops",
      "deep-research",
      "iterative-retrieval",
      "workspace-surface-audit",
      "skill-scout"
    ],
    secondary: ["repo-scan", "exa-search", "documentation-lookup", "ecc-guide", "knowledge-ops"]
  },
  planner: {
    primary: [
      "plan-orchestrate",
      "prompt-optimizer",
      "recursive-decision-ledger",
      "context-budget",
      "token-budget-advisor",
      "tdd-workflow",
      "search-first"
    ],
    secondary: [
      "product-capability",
      "architecture-decision-records",
      "blueprint",
      "ralphinho-rfc-pipeline",
      "product-lens"
    ]
  },
  architect: {
    primary: [
      "agent-architecture-audit",
      "agent-harness-construction",
      "agentic-engineering",
      "workspace-surface-audit",
      "context-budget",
      "recursive-decision-ledger"
    ],
    secondary: [
      "architecture-decision-records",
      "api-design",
      "mcp-server-patterns",
      "deployment-patterns",
      "product-capability"
    ]
  },
  implementer: {
    primary: [
      "tdd-workflow",
      "gateguard",
      "terminal-ops",
      "verification-loop",
      "agentic-engineering",
      "search-first"
    ],
    secondary: [
      "coding-standards",
      "error-handling",
      "mcp-server-patterns",
      "git-workflow",
      "deployment-patterns"
    ]
  },
  reviewer: {
    primary: [
      "plankton-code-quality",
      "santa-method",
      "verification-loop",
      "agent-architecture-audit",
      "skill-comply",
      "ai-regression-testing"
    ],
    secondary: [
      "production-audit",
      "coding-standards",
      "error-handling",
      "browser-qa",
      "architecture-decision-records"
    ]
  },
  "qa-evaluator": {
    primary: [
      "eval-harness",
      "agent-eval",
      "ai-regression-testing",
      "verification-loop",
      "skill-comply",
      "santa-method",
      "tdd-workflow"
    ],
    secondary: [
      "e2e-testing",
      "browser-qa",
      "windows-desktop-e2e",
      "benchmark",
      "canary-watch"
    ]
  },
  "security-reviewer": {
    primary: [
      "security-review",
      "security-scan",
      "safety-guard",
      "gateguard",
      "agent-architecture-audit"
    ],
    secondary: [
      "mcp-server-patterns",
      "api-design",
      "deployment-patterns",
      "enterprise-agent-ops",
      "error-handling"
    ]
  },
  "documentation-agent": {
    primary: [
      "codebase-onboarding",
      "research-ops",
      "rules-distill",
      "prompt-optimizer",
      "skill-scout",
      "skill-stocktake"
    ],
    secondary: [
      "documentation-lookup",
      "knowledge-ops",
      "ecc-guide",
      "architecture-decision-records",
      "repo-scan"
    ]
  },
  "runtime-loop-operator": {
    primary: [
      "agent-introspection-debugging",
      "terminal-ops",
      "verification-loop",
      "context-budget",
      "strategic-compact",
      "safety-guard",
      "automation-audit-ops"
    ],
    secondary: [
      "continuous-agent-loop",
      "autonomous-loops",
      "autonomous-agent-harness",
      "canary-watch",
      "enterprise-agent-ops"
    ]
  },
  "release-agent": {
    primary: [
      "verification-loop",
      "safety-guard",
      "gateguard",
      "ai-regression-testing",
      "santa-method",
      "terminal-ops",
      "project-flow-ops"
    ],
    secondary: [
      "deployment-patterns",
      "canary-watch",
      "git-workflow",
      "github-ops",
      "production-audit",
      "cost-tracking"
    ]
  },
  "pattern-mining-agent": {
    primary: [
      "continuous-learning-v2",
      "rules-distill",
      "skill-stocktake",
      "skill-scout",
      "skill-comply",
      "recursive-decision-ledger",
      "research-ops",
      "agent-sort"
    ],
    secondary: [
      "knowledge-ops",
      "ck",
      "hookify-rules",
      "continuous-agent-loop",
      "repo-scan"
    ]
  },
  "loop-resolver": {
    primary: [
      "agent-introspection-debugging",
      "gateguard",
      "safety-guard",
      "verification-loop",
      "recursive-decision-ledger",
      "terminal-ops",
      "context-budget"
    ],
    secondary: [
      "autonomous-loops",
      "continuous-agent-loop",
      "canary-watch",
      "error-handling",
      "enterprise-agent-ops"
    ]
  }
};

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
    expect(sessionColumns.map((column) => column.name)).toContain("role_profile_id");
    expect(handoffColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "queue_key",
        "labels_json",
        "queue_position",
        "depends_on_handoff_uid",
        "suggested_role_profile_id",
        "typed_payload"
      ])
    );
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "agent_profiles",
        "launch_requests",
        "session_attention_cursors",
        "attention_delivery_attempts",
        "discussion_threads",
        "discussion_messages",
        "role_profiles",
        "role_provider_support",
        "role_label_routes",
        "role_profile_aliases",
        "handoff_templates"
      ])
    );
    expect(handoffColumns.find((column) => column.name === "typed_payload")).toMatchObject({
      notnull: 0
    });
    expect(columnNames(db, "agent_profiles")).toContain("role_profile_id");
    expect(columnNames(db, "launch_requests")).toContain("role_profile_id");
    expect(columnNames(db, "role_profiles")).toContain("skills_json");
    expect(columnNames(db, "session_attention_cursors")).toEqual([
      "session_uid",
      "stream",
      "latest_event_id",
      "acknowledged_at",
      "updated_at"
    ]);
    expect(columnNames(db, "handoff_templates")).toEqual(
      expect.arrayContaining([
        "template_uid",
        "schema_version",
        "template_key",
        "role_profile_id",
        "name",
        "handoff_type",
        "typed_payload_json",
        "labels_json"
      ])
    );
    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        "idx_session_attention_cursors_session",
        "idx_attention_delivery_attempts_session",
        "idx_attention_delivery_attempts_status",
        "idx_role_profiles_status",
        "idx_role_provider_support_client",
        "idx_role_label_routes_label",
        "idx_role_label_routes_unique_label_profile",
        "idx_handoff_templates_role",
        "idx_handoff_templates_template_key"
      ])
    );
  });

  it("backfills canonical role profile ids without rewriting legacy role labels", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        session_uid TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        client_type TEXT NOT NULL,
        project TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'implementer',
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        session_token TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_profiles (
        agent_uid TEXT PRIMARY KEY,
        stable_name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'implementer',
        client_type TEXT,
        project TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE launch_requests (
        launch_request_uid TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        project_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        role TEXT,
        initial_instructions TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by_session_uid TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE handoffs (
        handoff_uid TEXT PRIMARY KEY,
        short_prompt TEXT NOT NULL,
        source_project TEXT NOT NULL,
        target_project TEXT NOT NULL,
        related_projects_json TEXT NOT NULL,
        related_files_json TEXT NOT NULL,
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

      INSERT INTO sessions (
        session_uid,
        display_name,
        client_type,
        project,
        workspace_path,
        role,
        status,
        capabilities_json,
        session_token,
        last_heartbeat_at,
        created_at,
        updated_at
      )
      VALUES
        ('vc_sess_sweeper', 'Sweeper', 'codex', 'Vault Collab', 'C:\\workspace', 'sweeper', 'idle', '{}', 'token1', '2026-06-02T08:00:00.000Z', '2026-06-02T08:00:00.000Z', '2026-06-02T08:00:00.000Z'),
        ('vc_sess_observer', 'Observer', 'codex', 'Vault Collab', 'C:\\workspace', 'observer', 'idle', '{}', 'token2', '2026-06-02T08:00:00.000Z', '2026-06-02T08:00:00.000Z', '2026-06-02T08:00:00.000Z');

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
      VALUES
        ('vc_agent_observer', 'observer-agent', 'Observer Agent', 'observer', 'codex', 'Vault Collab', '{}', 'active', '2026-06-02T08:00:00.000Z', '2026-06-02T08:00:00.000Z');

      INSERT INTO launch_requests (
        launch_request_uid,
        project,
        project_key,
        provider,
        model,
        workspace_path,
        role,
        initial_instructions,
        permission_mode,
        status,
        requested_by_session_uid,
        created_at,
        updated_at
      )
      VALUES (
        'vc_launch_qa',
        'Vault Collab',
        'vault-collab',
        'codex',
        'gpt-5-codex',
        'C:\\workspace',
        'qa',
        'Verify the implementation.',
        'read-only',
        'requested',
        'vc_sess_sweeper',
        '2026-06-02T08:00:00.000Z',
        '2026-06-02T08:00:00.000Z'
      );
    `);

    applySchema(db);

    expect(
      db.prepare("SELECT role, role_profile_id FROM sessions WHERE session_uid = ?").get("vc_sess_sweeper")
    ).toEqual({ role: "sweeper", role_profile_id: "runtime-loop-operator" });
    expect(
      db.prepare("SELECT role, role_profile_id FROM sessions WHERE session_uid = ?").get("vc_sess_observer")
    ).toEqual({ role: "observer", role_profile_id: "reviewer" });
    expect(
      db.prepare("SELECT role, role_profile_id FROM agent_profiles WHERE agent_uid = ?").get("vc_agent_observer")
    ).toEqual({ role: "observer", role_profile_id: "reviewer" });
    expect(
      db.prepare("SELECT role, role_profile_id FROM launch_requests WHERE launch_request_uid = ?").get("vc_launch_qa")
    ).toEqual({ role: "qa", role_profile_id: "qa-evaluator" });
  });

  it("seeds the 13 built-in role profiles and advisory routes idempotently", () => {
    db = createCollabDatabase(":memory:");
    const clock = () => new Date("2026-06-02T08:30:00.000Z");

    db.prepare("UPDATE role_profiles SET display_name = ? WHERE role_profile_id = ?").run(
      "Outdated Implementer",
      "implementer"
    );
    seedRoleProfiles(db, clock);
    seedRoleProfiles(db, clock);

    const roleIds = (
      db.prepare("SELECT role_profile_id FROM role_profiles WHERE source = ? ORDER BY sort_order ASC").all(
        "built_in"
      ) as Array<{ role_profile_id: string }>
    ).map((row) => row.role_profile_id);
    const duplicateRoutes = db
      .prepare(
        `
        SELECT label, role_profile_id, COUNT(*) AS count
        FROM role_label_routes
        GROUP BY label, role_profile_id
        HAVING COUNT(*) > 1
      `
      )
      .all();

    expect(roleIds).toEqual(expectedCoreRoleProfileIds);
    expect(db.prepare("SELECT display_name FROM role_profiles WHERE role_profile_id = ?").get("implementer"))
      .toEqual({ display_name: "Implementer" });
    expect(duplicateRoutes).toEqual([]);
    expect(db.prepare("SELECT role_profile_id FROM role_profile_aliases WHERE alias = ?").get("observer"))
      .toEqual({ role_profile_id: "reviewer" });
    expect(db.prepare("SELECT role_profile_id FROM role_profile_aliases WHERE alias = ?").get("sweeper"))
      .toEqual({ role_profile_id: "runtime-loop-operator" });
    expect(db.prepare("SELECT role_profile_id FROM role_profile_aliases WHERE alias = ?").get("qa-reviewer"))
      .toEqual({ role_profile_id: "qa-evaluator" });
    expect(db.prepare("SELECT role_profile_id FROM role_profile_aliases WHERE alias = ?").get("investigator"))
      .toEqual({ role_profile_id: "explorer" });
    expect(db.prepare("SELECT role_profile_id FROM role_profile_aliases WHERE alias = ?").get("coder"))
      .toEqual({ role_profile_id: "implementer" });
    expect(db.prepare("SELECT role_profile_id FROM role_profile_aliases WHERE alias = ?").get("codex-agent"))
      .toEqual({ role_profile_id: "implementer" });
    expect(db.prepare("SELECT role_profile_id FROM role_label_routes WHERE label = ?").all("loop"))
      .toEqual([expect.objectContaining({ role_profile_id: "loop-resolver" })]);
  });

  it("seeds ECC primary and secondary skill references for every built-in role profile", () => {
    db = createCollabDatabase(":memory:");
    seedRoleProfiles(db, () => new Date("2026-06-02T08:30:00.000Z"));

    const rows = db
      .prepare("SELECT role_profile_id, skills_json FROM role_profiles WHERE source = ?")
      .all("built_in") as Array<{ role_profile_id: string; skills_json: string }>;

    expect(rows).toHaveLength(expectedCoreRoleProfileIds.length);

    for (const row of rows) {
      const expectedSkills = expectedRoleSkillNames[row.role_profile_id];
      const skills = JSON.parse(row.skills_json) as {
        primary: Array<{ skill: string; path: string; triggerCondition: string }>;
        secondary: Array<{ skill: string; path: string; triggerCondition: string }>;
      };

      expect(expectedSkills).toBeDefined();
      expect(skills.primary.map((skill) => skill.skill)).toEqual(expectedSkills.primary);
      expect(skills.secondary.map((skill) => skill.skill)).toEqual(expectedSkills.secondary);

      for (const skill of [...skills.primary, ...skills.secondary]) {
        expect(skill.path).toBe(`skills/${skill.skill}/SKILL.md`);
        expect(skill.triggerCondition).toMatch(/^Trigger (when|before|after|for) /);
      }
    }
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
