# Vault Collab v2 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-neutral agent profiles, role metadata, ordered handoff queues, and structured discussion threads/messages while preserving the existing Vault Collab session/handoff inbox behavior.

**Architecture:** Keep Phase 1 additive. Existing `sessions`, `handoffs`, and `events` remain the compatibility core; new columns/tables are read with safe defaults and exposed through DTOs, CLI commands, and MCP tools. No autonomous execution, no auto-claiming, and no active-session interruption are introduced.

**Tech Stack:** TypeScript, Node ESM, better-sqlite3, Zod, MCP SDK, Vitest.

---

## Current Worktree Constraint

The tree already contains verified uncommitted changes for selected handoff details:

- `src/services/handoff-detail.service.ts`
- `src/services/session.service.ts`
- `src/types.ts`
- `src/cli.ts`
- `src/mcp/tools.ts`
- `tests/cli.test.ts`
- `tests/mcp-tools.test.ts`
- `README.md`
- `docs/v1-plan.md`
- `docs/phase-4-vault-link.md`

Do not revert these. Phase 1 must build on top of them and keep `vault_collab_get_handoff_detail` and the `handoff` CLI command working.

## File Map

- Modify `src/database/schema.ts`
  - Add migration helpers so existing SQLite files receive new columns/tables.
  - Create `agent_profiles`, `discussion_threads`, and `discussion_messages`.
  - Add `sessions.agent_uid`.
  - Add `handoffs.queue_key`, `handoffs.labels_json`, `handoffs.queue_position`, and `handoffs.depends_on_handoff_uid`.

- Modify `src/types.ts`
  - Add role definitions, agent profile DTOs, discussion DTOs, and metadata inputs.
  - Extend `RegisterSessionInput`, `SessionSnapshot`, `PublishHandoffInput`, `HandoffRecord`, and `HandoffFilters`.

- Create `src/services/agent-profile.service.ts`
  - Upsert/list/get agent profiles.
  - Expose built-in role definitions plus custom role support.
  - Never store or return session tokens.

- Modify `src/services/session.service.ts`
  - Bind sessions to `agentUid`.
  - Public session snapshots include agent metadata when present.
  - Use qualified session columns in joined SQL and avoid `SELECT *` collisions.
  - Preserve existing registration behavior when `agentUid` is omitted.

- Modify `src/services/handoff.service.ts`
  - Persist queue labels/order/dependency on publish.
  - Assign default queue positions in increments of 1000 per target project and queue.
  - Preserve existing inbox filters and default ordering compatibility.
  - Add owner-token guarded handoff metadata updates for manual queue/label changes.

- Create `src/services/discussion.service.ts`
  - Create/list/read discussion threads.
  - Append messages with owner-token validation.
  - Keep messages append-only.

- Modify `src/services/handoff-detail.service.ts`
  - Include discussion thread summaries in handoff detail after discussion service exists.

- Modify `src/mcp/tools.ts`
  - Wire agent, role, handoff metadata, and discussion tools with explicit Zod schemas.
  - Keep lifecycle tools manual and owner-token checked.

- Modify `src/cli.ts`
  - Add flat JSON commands for roles, agents, handoff metadata, discussions, and messages.

- Add/modify tests:
  - `tests/schema.test.ts`
  - `tests/agent-profile.service.test.ts`
  - `tests/session.service.test.ts`
  - `tests/handoff.service.test.ts`
  - `tests/discussion.service.test.ts`
  - `tests/mcp-tools.test.ts`
  - `tests/cli.test.ts`

- Modify docs:
  - `README.md`
  - `docs/v1-plan.md`
  - `docs/phase-4-vault-link.md`

## Coordination Handoffs

Parallel code edits are not safe in the current single worktree because the independent features converge on the same central API files. Use Vault Collab for independent review handoffs instead:

- Plan/contract review handoff to the idle Vault Collab worker: read-only review of this plan, current dirty changes, and API surface before code progresses too far.
- Verification handoff after implementation reaches green: read-only QA of source, docs, CLI/MCP schema names, token leakage, and backward compatibility.
- The Vault dashboard implementation remains a later cross-project handoff after package DTO/API changes are complete.

## Task 1: Schema And Compatibility

**Files:**
- Modify: `src/database/schema.ts`
- Create: `tests/schema.test.ts`

- [ ] **Step 1: Write the failing schema compatibility tests**

Add `tests/schema.test.ts` with tests that:

```ts
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

    const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const handoffColumns = db.prepare("PRAGMA table_info(handoffs)").all() as Array<{ name: string }>;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;

    expect(sessionColumns.map((column) => column.name)).toContain("agent_uid");
    expect(handoffColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["queue_key", "labels_json", "queue_position", "depends_on_handoff_uid"])
    );
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(["agent_profiles", "discussion_threads", "discussion_messages"])
    );
  });
});
```

- [ ] **Step 2: Run the new test to verify RED**

Run: `npx vitest --run tests/schema.test.ts`

Expected: FAIL because v2 columns/tables are not created for an existing v1-shaped DB.

- [ ] **Step 3: Implement additive schema migration**

In `src/database/schema.ts`, keep `CREATE TABLE IF NOT EXISTS` and add helper logic:

```ts
function columnExists(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
```

Then add:

```sql
CREATE TABLE IF NOT EXISTS agent_profiles (...);
CREATE TABLE IF NOT EXISTS discussion_threads (...);
CREATE TABLE IF NOT EXISTS discussion_messages (...);
```

and after `db.exec(...)`:

```ts
addColumnIfMissing(db, "sessions", "agent_uid", "TEXT");
addColumnIfMissing(db, "handoffs", "queue_key", "TEXT NOT NULL DEFAULT 'default'");
addColumnIfMissing(db, "handoffs", "labels_json", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing(db, "handoffs", "queue_position", "INTEGER");
addColumnIfMissing(db, "handoffs", "depends_on_handoff_uid", "TEXT");
```

- [ ] **Step 4: Run schema test to verify GREEN**

Run: `npx vitest --run tests/schema.test.ts`

Expected: PASS.

## Task 2: Agent Profiles And Session Binding

**Files:**
- Modify: `src/types.ts`
- Create: `src/services/agent-profile.service.ts`
- Modify: `src/services/session.service.ts`
- Test: `tests/agent-profile.service.test.ts`
- Test: `tests/session.service.test.ts`

- [ ] **Step 1: Write failing agent profile tests**

Add tests for:

- Built-in role definitions are `coordinator`, `implementer`, `reviewer`, `sweeper`, `observer`.
- Upserting an agent by stable name creates `vc_agent_...`.
- Upserting the same stable name updates display name, role, capabilities, and timestamp.
- Listing agents never includes session tokens.

- [ ] **Step 2: Write failing session binding test**

In `tests/session.service.test.ts`, add a test that manually creates/upserts an agent profile, registers a session with `agentUid`, and expects public session snapshots to include:

```ts
{
  agentUid,
  agentName: "repo-coordinator",
  agentDisplayName: "Repo Coordinator",
  agentRole: "coordinator"
}
```

The same test must assert the session token is not present in `listSessions()`.

- [ ] **Step 3: Run focused RED tests**

Run: `npx vitest --run tests/agent-profile.service.test.ts tests/session.service.test.ts`

Expected: FAIL because service/types/session binding do not exist.

- [ ] **Step 4: Implement agent profile DTOs and service**

Add types:

```ts
export type BuiltInAgentRole = "coordinator" | "implementer" | "reviewer" | "sweeper" | "observer";
export type AgentProfileStatus = "active" | "archived";
```

Add a role definition constant and interfaces for `AgentProfile`, `UpsertAgentProfileInput`, and `AgentProfileFilters`.

Create `AgentProfileService` with:

- `listRoleDefinitions()`
- `upsertAgentProfile(input)`
- `listAgentProfiles(filter)`
- `getAgentProfile(agentUid)`

- [ ] **Step 5: Implement session binding**

Add `agentUid?: string | null` to `RegisterSessionInput`.

Modify `SessionService.registerSession()` insert to write `agent_uid`.

Modify `listSessions()` and `getSession()` to select from `sessions LEFT JOIN agent_profiles` and map `agentUid`, `agentName`, `agentDisplayName`, and `agentRole`.

When adding the join, qualify all session filters and selected columns:

```sql
sessions.project = ?
sessions.client_type = ?
sessions.status = ?
```

Do not use `SELECT *`, because both `sessions` and `agent_profiles` have `project` and `status` columns.

- [ ] **Step 6: Run focused GREEN tests**

Run: `npx vitest --run tests/agent-profile.service.test.ts tests/session.service.test.ts`

Expected: PASS.

## Task 3: Queue Metadata On Handoffs

**Files:**
- Modify: `src/types.ts`
- Modify: `src/services/handoff.service.ts`
- Test: `tests/handoff.service.test.ts`

- [ ] **Step 1: Write failing queue tests**

Add tests that publish three handoffs into the same target project:

- One with default queue metadata.
- One with labels `["qa", "phase-1"]` and queue key `phase-1`.
- One with explicit queue position `500`.

Assert public handoff records include:

```ts
queueKey: "phase-1",
labels: ["qa", "phase-1"],
queuePosition: 500,
dependsOnHandoffUid: null
```

Add a second test proving `listInbox({ targetProject, queueKey: "phase-1" })` filters and orders by urgent, queue position, created time, and handoff UID.

Add a third test proving `updateHandoffMetadata()` requires either the source session owner or the claimed session owner token.

- [ ] **Step 2: Run focused RED tests**

Run: `npx vitest --run tests/handoff.service.test.ts`

Expected: FAIL because queue metadata fields and updater do not exist.

- [ ] **Step 3: Implement queue metadata**

Add fields to `PublishHandoffInput`, `HandoffRecord`, and `HandoffFilters`.

In `publishHandoff()`, persist:

- `queueKey: input.queueKey ?? "default"`
- `labels: input.labels ?? []`
- `queuePosition: input.queuePosition ?? nextQueuePosition(targetProject, queueKey)`
- `dependsOnHandoffUid: input.dependsOnHandoffUid ?? null`

Sort inbox by:

```sql
ORDER BY urgent DESC,
         queue_key ASC,
         CASE WHEN queue_position IS NULL THEN 1 ELSE 0 END ASC,
         queue_position ASC,
         created_at ASC,
         handoff_uid ASC
```

Add `updateHandoffMetadata(handoffUid, sessionUid, sessionToken, metadata)`.

- [ ] **Step 4: Run focused GREEN tests**

Run: `npx vitest --run tests/handoff.service.test.ts`

Expected: PASS.

## Task 4: Discussion Threads And Messages

**Files:**
- Modify: `src/types.ts`
- Create: `src/services/discussion.service.ts`
- Modify: `src/services/handoff-detail.service.ts`
- Test: `tests/discussion.service.test.ts`

- [ ] **Step 1: Write failing discussion tests**

Add tests that:

- Create a discussion thread tied to a handoff and project.
- Append `proposal`, `concern`, and `decision` messages.
- Read the thread with messages in append order.
- List threads by project and handoff.
- Verify serialized thread output does not contain session tokens.
- Verify thread creation requires a valid session owner token when `createdBySessionUid` is recorded.
- Verify append requires a valid session owner token.

- [ ] **Step 2: Run focused RED tests**

Run: `npx vitest --run tests/discussion.service.test.ts`

Expected: FAIL because discussion service/types do not exist.

- [ ] **Step 3: Implement discussion service**

Create `DiscussionService` with:

- `createThread(input)`
- `addMessage(threadUid, sessionUid, sessionToken, input)`
- `listThreads(filter)`
- `getThread(threadUid)`

`createThread()` must require `createdBySessionUid` and `sessionToken`, validate the owner token, and then record `createdBySessionUid` on the thread. Do not allow a caller to forge a creator session without the token.

Use message types:

```ts
export type DiscussionMessageType = "note" | "question" | "proposal" | "concern" | "decision" | "system";
```

Record events:

- `discussion.thread_created`
- `discussion.message_added`

- [ ] **Step 4: Wire handoff detail summaries**

Extend `HandoffDetail` with `discussionThreads`.

`HandoffDetailService` should receive `DiscussionService` and include thread summaries for the handoff. If no discussions exist, return an empty array.

- [ ] **Step 5: Run focused GREEN tests**

Run: `npx vitest --run tests/discussion.service.test.ts`

Expected: PASS.

## Task 5: MCP Tools

**Files:**
- Modify: `src/mcp/tools.ts`
- Test: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Write failing MCP tool contract tests**

Extend the tool-name list to include:

```ts
"vault_collab_list_agent_roles",
"vault_collab_upsert_agent_profile",
"vault_collab_list_agent_profiles",
"vault_collab_update_handoff_metadata",
"vault_collab_create_discussion_thread",
"vault_collab_add_discussion_message",
"vault_collab_list_discussion_threads",
"vault_collab_get_discussion_thread"
```

Add lifecycle tests that create an agent, bind a session to it, publish ordered handoffs, create a thread, append a message, read the handoff detail, and assert no token leaks.

- [ ] **Step 2: Run focused RED tests**

Run: `npx vitest --run tests/mcp-tools.test.ts`

Expected: FAIL because MCP tools are not registered.

- [ ] **Step 3: Implement MCP schemas and handlers**

Add explicit Zod schemas. Avoid empty passthrough schemas.

Instantiate:

```ts
const agents = new AgentProfileService(db, events, options.clock);
const discussions = new DiscussionService(db, events, options.clock);
const handoffDetails = new HandoffDetailService(handoffs, events, sessions, discussions);
```

Wire each handler to service methods. Do not add any autonomous execution or auto-claim handler.

- [ ] **Step 4: Run focused GREEN tests**

Run: `npx vitest --run tests/mcp-tools.test.ts`

Expected: PASS.

## Task 6: CLI Commands

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Add a JSON workflow test covering:

- `roles`
- `agent-upsert`
- `agents`
- `register --agent-uid`
- `publish --queue-key --queue-position --label`
- `handoff-metadata`
- `discussion-create`
- `discussion-add-message`
- `discussions`
- `discussion`

Assert public output does not include session tokens except direct `register` output.

- [ ] **Step 2: Run focused RED tests**

Run: `npx vitest --run tests/cli.test.ts`

Expected: FAIL because commands/options are missing.

- [ ] **Step 3: Implement flat CLI commands**

Update command set and service wiring. Keep command names flat to match the existing parser:

- `roles`
- `agent-upsert`
- `agents`
- `handoff-metadata`
- `discussion-create`
- `discussion-add-message`
- `discussions`
- `discussion`

Use repeated `--label` for labels and `--metadata key=value` for discussion message metadata.

- [ ] **Step 4: Run focused GREEN tests**

Run: `npx vitest --run tests/cli.test.ts`

Expected: PASS.

## Task 7: Documentation And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/v1-plan.md`
- Modify: `docs/phase-4-vault-link.md`

- [ ] **Step 1: Update docs**

Document:

- Agent profiles and roles.
- Session binding.
- Ordered queues and labels.
- Discussion threads/messages.
- No autonomous execution and no auto-claiming.
- Backward compatibility with existing inbox reads.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run test:run
npm run build
npm run typecheck
git diff --check
```

Expected:

- All tests pass.
- Build exits 0.
- Typecheck exits 0.
- Diff check reports no whitespace errors. CRLF warnings from Git are acceptable if they match existing repo behavior and do not indicate whitespace errors.

- [ ] **Step 3: Publish QA handoff**

Save a Vault memory implementation summary with touched files, verification output, and known operational note that live MCP clients may need rebuild/restart to see new tools.

Publish a Vault Collab QA handoff to the idle worker with:

- Source project: `Vault Collab`
- Target project: `Vault Collab`
- Related files from this plan
- Full memory UID linked
- Prompt to verify token safety, backward compatibility, CLI/MCP contracts, and no autonomous execution path.

## Acceptance Checklist

- [ ] Existing session/handoff lifecycle tests still pass.
- [ ] Existing inbox reads still work for old DB shape.
- [ ] New agent profiles are durable and provider-neutral.
- [ ] Sessions can bind to agents but still work without agents.
- [ ] Role definitions are exposed as data, not hard-coded tool classes.
- [ ] Handoffs expose labels, queue key, queue position, and dependency.
- [ ] Discussions are append-only and token-safe.
- [ ] CLI and MCP expose the new contracts with explicit schemas.
- [ ] No auto-execution, no auto-claiming, and no active-session interruption were added.
