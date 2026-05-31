# Vault Collab Robustness Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Vault Collab's coordination layer against three concrete failure modes: stale "ghost" claims after session crashes, untraceable multi-agent flows during incident review, and silent history rewrites by buggy migrations or careless dev tooling. Capture deferred design records for two The Vault-side robustness items so a future session can pick them up without re-deriving context.

**Architecture:** Vault Collab remains the durable shared control plane. Phase 1 lands entirely in this repo: lease lifecycle, trace_id in event payloads, and a SQLite append-only trigger on the events table. Phase 2 (provider prompt-readiness) and Phase 3 (deferred-delivery queue) are The Vault-side and gated on the managed-worker smoke proving the receiver path end-to-end. Phase 2/3 are captured here as design records, not executable tasks.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, Vault Collab CLI/MCP, Vitest. No new runtime dependencies for Phase 1.

**Origin:** Off-plan robustness ideas raised by Claude in discussion `vc_thread_7cb4c160` after the contract-clarification slice (`376f66a`) landed. Codex triaged the ideas in `vc_msg_a8fc9126` and ordered execution as Handoff A (lease) → Handoff B (trace_id + append-only) → Handoff C (prompt-readiness + deferred queue, deferred). This plan consolidates Handoffs A and B into a single phase because they share repo, tests, and review surface, and treats Handoff C as a deferred design record.

---

## Execution Gate

**Do not start this plan until The Vault installed build can launch a managed Codex worker and acknowledge a dashboard ping.**

Current blocker (as of 2026-05-30): `vc_launch_4e9ac627` failed with `Failed to load native module: conpty.node, checked: build/Release, build/Debug, prebuilds/win32-x64: Could not dynamically require "./prebuilds/win32-x64//conpty.node". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately`. Until the installed The Vault app launches a managed worker end-to-end and the worker receives + acknowledges a dashboard ping, this robustness phase is parked. Phase 2 robustness must not become an excuse to defer fixing the packaging failure.

Gate clears when:
- `vc_launch_*.status === 'running'` for at least one managed Codex worker launched from the installed app;
- the worker's `attention.lastAckEventId` advances after a dashboard ping;
- `attention_delivery_attempts` shows at least one `delivered` row for that worker.

---

## Product Contract

The robustness layer must satisfy five invariants:

1. **No silent ghost claims.** A claimed handoff whose owning session has stopped heartbeating or whose lease has expired must auto-release within bounded time and emit an audit event recording the prior claimer and reason.
2. **Trace continuity.** Every event caused by an originating action (publish, ping, launch-create) carries the same `traceId` through the lifecycle (claim, update, resolve, discussion, child handoffs).
3. **Audit immutability.** The `events` table accepts INSERTs only. UPDATE and DELETE fail at the database level, not at the convention level.
4. **Backward compatibility.** Existing handoffs with `leaseExpiresAt = NULL` must continue to behave correctly (never auto-expire spuriously) until they are touched by a claim or update.
5. **Provider neutrality.** Phase 2 (prompt-readiness) and Phase 3 (deferred queue) must remain in The Vault, not Vault Collab. Vault Collab stays a durable control plane, not a process broker.

---

## Phase Gates

- **Phase 1 (Items 1, 4, 5):** Vault Collab side. Independent of The Vault. Can land before the PTY runtime branch is pushed.
- **Phase 2 (Item 2 — provider prompt-readiness):** The Vault side. **Gated on managed-worker smoke green**, i.e. the existing local ConPTY runtime proves launch → ping → ack works against a real Codex worker. Design recorded below; do not begin until the gate clears.
- **Phase 3 (Item 3 — deferred-delivery queue):** The Vault side. **Gated on Phase 2 stable**, because the queue's flush trigger depends on prompt-readiness detection. Design recorded below.

---

## File Structure

### Phase 1 (Vault Collab repo) — executable now

- Modify: `src/services/handoff.service.ts`
  - Set `leaseExpiresAt` on `claimHandoff` and refresh on `updateHandoff`.
  - Add `sweepExpiredLeases()` returning the count of releases.
  - Inject `traceId` into all event payloads emitted from handoff lifecycle.
- Modify: `src/services/session.service.ts`
  - Refresh leases of all claimed handoffs on `heartbeatSession`.
  - On `session-disconnect`, expire that session's claimed handoff leases immediately (`leaseExpiresAt = now`).
- Modify: `src/services/event.service.ts` (or wherever events are written)
  - Add `getOrCreateTrace(handoffUid?)` helper.
  - Inject `traceId` into every event payload at write time.
- Modify: `src/database/schema.ts`
  - Add `LEASE_TTL_MS` constant (default 300_000 ms = 5 min), configurable via `VAULT_COLLAB_LEASE_TTL_MS` env var.
  - Add migration that adds `events_no_update` and `events_no_delete` triggers.
  - Backfill `leaseExpiresAt` for existing claimed handoffs (`COALESCE(leaseExpiresAt, claimedAt + LEASE_TTL_MS)`).
- Modify: `src/cli.ts`
  - Add `sweep-leases --db <path>` command.
  - Extend `list-events` with `--trace <id>` filter.
- Modify: `src/mcp/tools.ts`
  - Add `vault_collab_sweep_expired_handoffs` admin/diagnostic tool.
  - Extend `vault_collab_list_events` schema with `traceId` filter.
- Modify: `src/types.ts`
  - Document `Event.payload.traceId` field.
  - Document `LEASE_TTL_MS` env override.
- Test: `tests/handoff.service.test.ts`
  - Lease set on claim, refreshed on update, expired by sweep.
- Test: `tests/session.service.test.ts`
  - Heartbeat refreshes claimed-handoff leases.
  - Session disconnect cascades to immediate lease expiry.
- Test: `tests/event.service.test.ts` (create if missing)
  - traceId generated on root events; inherited by child events sharing a handoff or `dependsOnHandoffUid`.
- Test: `tests/database.test.ts` (create if missing)
  - UPDATE/DELETE on events raises trigger error.
  - INSERT still succeeds.
  - `__MAINTENANCE_ONLY_withEventsTriggersDisabled` helper allows scoped maintenance writes.
- Test: `tests/cli.test.ts`
  - `sweep-leases` and `list-events --trace` invocations produce expected output.
- Modify: `docs/v1-plan.md` and `docs/agent-guide.ts` (if relevant)
  - Document lease lifecycle, trace_id, append-only invariant.

### Phase 2 (The Vault repo) — deferred design record

- Create (later): `packages/desktop/electron/provider-readiness.ts`
  - Per-provider regex tables for ready/not-ready markers.
  - Sliding-window decision algorithm over PTY output buffer.
- Modify (later): `packages/desktop/electron/vault-collab-managed-workers.ts`
  - Replace time-based idle gate with provider-readiness check, falling back to the existing gate when no marker matches.
- Test (later): `packages/desktop/electron/provider-readiness.test.ts`
  - Snapshot fixtures of real PTY output captured during smoke runs.

### Phase 3 (The Vault repo) — deferred design record

- Create (later): `packages/desktop/electron/delivery-queue.ts`
  - Per-worker queue with bounded length, coalescing flush.
- Create (later): SQLite mirror table `pending_deliveries` for restart recovery.
- Test (later): `packages/desktop/electron/delivery-queue.test.ts`
  - Simulated ping burst during fake-busy window → single coalesced flush on idle.

---

## Task 1: Lease Lifecycle — Set On Claim, Refresh On Update

**Files:**
- Modify: `src/services/handoff.service.ts`
- Modify: `src/database/schema.ts`
- Modify: `src/types.ts`
- Test: `tests/handoff.service.test.ts`

- [ ] **Step 1: Add `LEASE_TTL_MS` constant**

In `src/database/schema.ts` (or a new `src/lease.ts`):

```ts
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export function getLeaseTtlMs(): number {
  const env = process.env.VAULT_COLLAB_LEASE_TTL_MS;
  if (!env) return DEFAULT_LEASE_TTL_MS;
  const parsed = Number.parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LEASE_TTL_MS;
  return parsed;
}
```

- [ ] **Step 2: Add failing tests**

In `tests/handoff.service.test.ts`:

```ts
it("sets leaseExpiresAt to claim time plus LEASE_TTL on claim", () => {
  const handoff = handoffs.publishHandoff({ /* … */ });
  const before = Date.now();
  const claimed = handoffs.claimHandoff({ handoffUid: handoff.handoffUid, sessionUid, sessionToken });
  const after = Date.now();
  expect(claimed.leaseExpiresAt).not.toBeNull();
  const leaseMs = new Date(claimed.leaseExpiresAt!).getTime();
  expect(leaseMs).toBeGreaterThanOrEqual(before + getLeaseTtlMs() - 100);
  expect(leaseMs).toBeLessThanOrEqual(after + getLeaseTtlMs() + 100);
});

it("refreshes leaseExpiresAt on update_handoff", async () => {
  const handoff = handoffs.publishHandoff({ /* … */ });
  const claimed = handoffs.claimHandoff({ /* … */ });
  const firstLease = new Date(claimed.leaseExpiresAt!).getTime();

  await new Promise((r) => setTimeout(r, 50));
  const updated = handoffs.updateHandoff({ handoffUid: handoff.handoffUid, sessionUid, sessionToken, status: "in_progress", progressNote: "Working." });

  const secondLease = new Date(updated.leaseExpiresAt!).getTime();
  expect(secondLease).toBeGreaterThan(firstLease);
});
```

- [ ] **Step 3: Implement claim-time lease**

In `claimHandoff`, set `leaseExpiresAt = new Date(Date.now() + getLeaseTtlMs()).toISOString()` in the UPDATE.

- [ ] **Step 4: Implement update-time lease refresh**

In `updateHandoff`, include `leaseExpiresAt = new Date(Date.now() + getLeaseTtlMs()).toISOString()` in the SET clause whenever the caller is the current claimer.

- [ ] **Step 5: Add backfill migration**

Add a migration that runs once:

```sql
UPDATE handoffs
SET leaseExpiresAt = ?
WHERE leaseExpiresAt IS NULL
  AND status IN ('claimed','in_progress','blocked','awaiting_user','verification_needed');
```

Pass `now + LEASE_TTL_MS` (not `claimedAt + LEASE_TTL_MS`). Reason: a `claimedAt` that is far in the past would cause legitimate long-running claims to be released immediately after upgrade, surprising their owners. Using `now + LEASE_TTL_MS` gives every existing claim a fresh lease window starting at upgrade time; subsequent heartbeats and updates then refresh normally. The downside is that an upgrade resets the effective lease clock for everyone, which is acceptable as a one-time cost. Document this behavior in the migration comment so it isn't mistaken for a bug later.

- [ ] **Step 6: Run tests**

```bash
npm run build
npm run test:run -- tests/handoff.service.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/handoff.service.ts src/database/schema.ts src/types.ts tests/handoff.service.test.ts
git commit -m "Set and refresh handoff lease on claim and update"
```

---

## Task 2: Lease Refresh Via Session Heartbeat And Disconnect Cascade

**Files:**
- Modify: `src/services/session.service.ts`
- Test: `tests/session.service.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
it("refreshes leases of claimed handoffs on heartbeat", async () => {
  const session = sessions.registerSession({ /* … */ });
  const handoff = handoffs.publishHandoff({ /* … */ });
  const claimed = handoffs.claimHandoff({ handoffUid: handoff.handoffUid, sessionUid: session.sessionUid, sessionToken: session.sessionToken });
  const firstLease = new Date(claimed.leaseExpiresAt!).getTime();

  await new Promise((r) => setTimeout(r, 50));
  sessions.heartbeatSession({ sessionUid: session.sessionUid, sessionToken: session.sessionToken });

  const reloaded = handoffs.getHandoff(handoff.handoffUid);
  const secondLease = new Date(reloaded.leaseExpiresAt!).getTime();
  expect(secondLease).toBeGreaterThan(firstLease);
});

it("expires claimed handoff leases immediately when session disconnects", () => {
  const session = sessions.registerSession({ /* … */ });
  const handoff = handoffs.publishHandoff({ /* … */ });
  handoffs.claimHandoff({ handoffUid: handoff.handoffUid, sessionUid: session.sessionUid, sessionToken: session.sessionToken });

  sessions.disconnectSession({ sessionUid: session.sessionUid, sessionToken: session.sessionToken });

  const reloaded = handoffs.getHandoff(handoff.handoffUid);
  expect(new Date(reloaded.leaseExpiresAt!).getTime()).toBeLessThanOrEqual(Date.now() + 10);
});
```

- [ ] **Step 2: Implement heartbeat refresh**

In `heartbeatSession`, after the session UPDATE, run:

```sql
UPDATE handoffs
SET leaseExpiresAt = ?
WHERE claimedBySessionUid = ?
  AND status IN ('claimed','in_progress','blocked','awaiting_user','verification_needed');
```

with `? = new Date(Date.now() + getLeaseTtlMs()).toISOString()` and the session uid.

- [ ] **Step 3: Implement disconnect cascade**

In `disconnectSession` (and wherever lazy disconnect detection lives — e.g., `markSessionDisconnectedIfStale`), set `leaseExpiresAt = new Date(Date.now()).toISOString()` for all claimed handoffs of the disconnecting session. The sweep in Task 3 will then transition them.

- [ ] **Step 4: Run tests**

```bash
npm run test:run -- tests/session.service.test.ts tests/handoff.service.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/session.service.ts tests/session.service.test.ts
git commit -m "Refresh handoff leases on heartbeat and expire on disconnect"
```

---

## Task 3: Lease Expiry Sweep With Audit Event

**Files:**
- Modify: `src/services/handoff.service.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/handoff.service.test.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("sweeps expired leases atomically and emits lease_expired event", () => {
  const session = sessions.registerSession({ /* … */ });
  const handoff = handoffs.publishHandoff({ /* … */ });
  handoffs.claimHandoff({ handoffUid: handoff.handoffUid, sessionUid: session.sessionUid, sessionToken: session.sessionToken });

  // Force lease into the past.
  db.exec(`UPDATE handoffs SET leaseExpiresAt = '1970-01-01T00:00:00.000Z' WHERE handoffUid = '${handoff.handoffUid}'`);

  const released = handoffs.sweepExpiredLeases();
  expect(released).toEqual([handoff.handoffUid]);

  const reloaded = handoffs.getHandoff(handoff.handoffUid);
  expect(reloaded.status).toBe("available");
  expect(reloaded.claimedBySessionUid).toBeNull();
  expect(reloaded.leaseExpiresAt).toBeNull();

  const events = handoffs.listEvents({ handoffUid: handoff.handoffUid });
  const leaseEvent = events.find((e) => e.eventType === "handoff.lease_expired");
  expect(leaseEvent).toBeDefined();
  expect(leaseEvent!.payload.priorClaimedBySessionUid).toBe(session.sessionUid);
  expect(leaseEvent!.payload.reason).toBe("lease_expired");
});

it("is idempotent: a second sweep releases nothing", () => {
  // … first sweep releases 1, second sweep releases 0.
});
```

- [ ] **Step 2: Implement `sweepExpiredLeases()`**

In `handoff.service.ts`:

```ts
sweepExpiredLeases(): string[] {
  const now = new Date().toISOString();
  const tx = this.db.transaction(() => {
    const rows = this.db.prepare(`
      SELECT handoffUid, claimedBySessionUid
      FROM handoffs
      WHERE leaseExpiresAt IS NOT NULL
        AND leaseExpiresAt <= ?
        AND status IN ('claimed','in_progress','blocked','awaiting_user','verification_needed')
    `).all(now) as Array<{ handoffUid: string; claimedBySessionUid: string }>;

    if (rows.length === 0) return [];

    this.db.prepare(`
      UPDATE handoffs
      SET status = 'available',
          claimedBySessionUid = NULL,
          leaseExpiresAt = NULL,
          updatedAt = ?
      WHERE handoffUid = ?
    `).run(now, /* per row */);

    for (const row of rows) {
      this.emitEvent({
        handoffUid: row.handoffUid,
        sessionUid: null,
        eventType: "handoff.lease_expired",
        payload: {
          priorClaimedBySessionUid: row.claimedBySessionUid,
          reason: "lease_expired",
          sweptAt: now,
        },
      });
    }
    return rows.map((r) => r.handoffUid);
  });
  return tx();
}
```

Single transaction ensures atomicity. Multiple concurrent sweepers each see disjoint rows because the SELECT-then-UPDATE is in a transaction with SQLite's BEGIN IMMEDIATE.

- [ ] **Step 3: Invoke sweep lazily on read paths**

In `listInbox` and `getSessionAttention`, call `sweepExpiredLeases()` before the main query. Cost is one extra SELECT scan per inbox read; with leaseExpiresAt indexed, this is cheap.

Add an index:

```sql
CREATE INDEX IF NOT EXISTS handoffs_lease_expires_idx
  ON handoffs(leaseExpiresAt)
  WHERE leaseExpiresAt IS NOT NULL;
```

- [ ] **Step 4: Add CLI command**

```ts
// src/cli.ts
yargs.command("sweep-leases", "Release handoffs whose lease expired", {
  db: { type: "string", demandOption: true },
}, async (args) => {
  const handoffs = openHandoffService(args.db);
  const released = handoffs.sweepExpiredLeases();
  console.log(JSON.stringify({ released, count: released.length }));
});
```

- [ ] **Step 5: Add MCP tool**

```ts
// src/mcp/tools.ts
{
  name: "vault_collab_sweep_expired_handoffs",
  description: "Diagnostic: release handoffs whose lease expired and emit handoff.lease_expired events.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: () => ({ released: handoffs.sweepExpiredLeases() }),
}
```

- [ ] **Step 6: Surface lease-expired events for dashboards/debugging**

The dashboard and operators need to see which handoffs were swept and why. Extend the existing `list-events` filter (introduced for trace_id in Task 4) to also accept `--event-type <type>` so callers can run:

```bash
node dist/cli.js list-events --db /path/to/db --event-type handoff.lease_expired
node dist/cli.js list-events --db /path/to/db --event-type handoff.lease_expired --handoff <handoffUid>
```

Add the same `eventType` filter to the MCP tool `vault_collab_list_events` input schema. No new tool; same surface. Test:

```ts
it("filters events by eventType", () => {
  // … sweep an expired handoff, then …
  const events = handoffs.listEvents({ eventType: "handoff.lease_expired" });
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((e) => e.eventType === "handoff.lease_expired")).toBe(true);
});
```

- [ ] **Step 7: Run tests**

```bash
npm run build
npm run test:run -- tests/handoff.service.test.ts tests/cli.test.ts tests/mcp-tools.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/services/handoff.service.ts src/cli.ts src/mcp/tools.ts tests/
git commit -m "Sweep expired handoff leases with audit event"
```

---

## Task 4: trace_id In Event Payloads

**Files:**
- Modify: `src/services/event.service.ts` (or wherever events are written; create if it doesn't exist as a single module)
- Modify: `src/services/handoff.service.ts`
- Modify: `src/services/session.service.ts`
- Modify: `src/services/launch-request.service.ts`
- Modify: `src/services/discussion.service.ts`
- Modify: `src/types.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/event.service.test.ts` (create)
- Test: `tests/handoff.service.test.ts`

- [ ] **Step 1: Add trace helpers**

In `src/services/event.service.ts` (or `src/trace.ts`):

```ts
import { randomUUID } from "node:crypto";

export function generateTraceId(): string {
  return `vc_trace_${randomUUID()}`;
}

export function getOrCreateTrace(db: CollabDatabase, handoffUid?: string | null): string {
  if (handoffUid) {
    const row = db.prepare(`
      SELECT payload FROM events
      WHERE handoffUid = ?
      ORDER BY eventId ASC
      LIMIT 1
    `).get(handoffUid) as { payload: string } | undefined;
    if (row) {
      try {
        const parsed = JSON.parse(row.payload);
        if (typeof parsed.traceId === "string") return parsed.traceId;
      } catch {
        /* fall through */
      }
    }
  }
  return generateTraceId();
}
```

- [ ] **Step 2: Add failing tests**

```ts
describe("trace_id propagation", () => {
  it("generates a traceId on publishHandoff and records it in the event payload", () => {
    const handoff = handoffs.publishHandoff({ /* … */ });
    const events = handoffs.listEvents({ handoffUid: handoff.handoffUid });
    const publishEvent = events.find((e) => e.eventType === "handoff.published");
    expect(typeof publishEvent!.payload.traceId).toBe("string");
    expect(publishEvent!.payload.traceId).toMatch(/^vc_trace_/);
  });

  it("inherits the same traceId on claim, update, and resolve", () => {
    const handoff = handoffs.publishHandoff({ /* … */ });
    const publishTrace = handoffs.listEvents({ handoffUid: handoff.handoffUid })[0].payload.traceId;

    handoffs.claimHandoff({ /* … */ });
    handoffs.updateHandoff({ /* … */, status: "in_progress" });
    handoffs.resolveHandoff({ /* … */ });

    const events = handoffs.listEvents({ handoffUid: handoff.handoffUid });
    for (const e of events) {
      expect(e.payload.traceId).toBe(publishTrace);
    }
  });

  it("child handoff with dependsOnHandoffUid inherits parent traceId", () => {
    const parent = handoffs.publishHandoff({ /* … */ });
    const parentTrace = handoffs.listEvents({ handoffUid: parent.handoffUid })[0].payload.traceId;
    const child = handoffs.publishHandoff({ /* … */, dependsOnHandoffUid: parent.handoffUid });
    const childTrace = handoffs.listEvents({ handoffUid: child.handoffUid })[0].payload.traceId;
    expect(childTrace).toBe(parentTrace);
  });

  it("discussion message on a handoff inherits the handoff traceId", () => {
    const handoff = handoffs.publishHandoff({ /* … */ });
    const trace = handoffs.listEvents({ handoffUid: handoff.handoffUid })[0].payload.traceId;
    const thread = discussions.createThread({ handoffUid: handoff.handoffUid, /* … */ });
    discussions.addMessage({ threadUid: thread.threadUid, /* … */ });
    const events = handoffs.listEvents({ handoffUid: handoff.handoffUid });
    const msgEvent = events.find((e) => e.eventType === "discussion.message_added");
    expect(msgEvent!.payload.traceId).toBe(trace);
  });
});
```

- [ ] **Step 3: Implement at write sites**

Modify every `emitEvent`/`insertEvent` call site to compute and inject `traceId` into the payload:

```ts
const traceId = input.traceId ?? getOrCreateTrace(this.db, input.handoffUid);
const payloadWithTrace = { ...input.payload, traceId };
this.db.prepare(`INSERT INTO events (…) VALUES (…)`).run(/* … */, JSON.stringify(payloadWithTrace), /* … */);
```

For child handoffs in `publishHandoff`, look up the parent's first event traceId via `getOrCreateTrace(db, dependsOnHandoffUid)` and pass it through.

For root events without a handoff context (e.g., `session.registered`), generate fresh.

- [ ] **Step 4: Add `traceId` to list-events filter**

CLI:

```ts
yargs.command("list-events", "List events", {
  db: { type: "string", demandOption: true },
  trace: { type: "string" },
  // …
}, async (args) => {
  const events = handoffs.listEvents({
    traceId: args.trace,
    // …
  });
  console.log(JSON.stringify(events, null, 2));
});
```

In `listEvents`, when `traceId` is supplied:

```sql
WHERE json_extract(payload, '$.traceId') = ?
```

Add a SQLite expression index for query speed:

```sql
CREATE INDEX IF NOT EXISTS events_trace_idx
  ON events(json_extract(payload, '$.traceId'));
```

MCP tool: extend `vault_collab_list_events` input schema with optional `traceId`.

- [ ] **Step 5: Document**

In `src/types.ts`, add a doc comment on `EventPayload` (or the relevant type):

```ts
/**
 * Every event payload includes a string `traceId` that propagates across the
 * originating action's lifecycle (publish → claim → update → resolve, plus any
 * discussion or child handoff). Use `list-events --trace <id>` to grep a
 * cross-session flow.
 */
```

In agent guide loop, add an entry:

```ts
"Every event carries a traceId in its payload that propagates across the originating action's lifecycle. Use vault_collab_list_events with traceId to follow a flow across sessions.",
```

Update `tests/cli.test.ts` and `tests/mcp-tools.test.ts` to assert `/traceId/` appears in the guide.

- [ ] **Step 6: Run tests**

```bash
npm run build
npm run test:run -- tests/event.service.test.ts tests/handoff.service.test.ts tests/cli.test.ts tests/mcp-tools.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/ tests/
git commit -m "Propagate traceId across event payloads"
```

---

## Task 5: Events Table Append-Only Trigger

**Files:**
- Modify: `src/database/schema.ts`
- Modify: `tests/setup.ts` (or wherever test DB reset lives)
- Test: `tests/database.test.ts` (create)

- [ ] **Step 1: Pre-audit production code**

```bash
# Should return zero hits in src/
git grep -nE "UPDATE.+events\b|DELETE FROM events" src/ tests/
```

Inspect any hits. Production-code hits are blockers; test-code hits must be migrated to either `DROP TABLE events; CREATE TABLE events …` reset or wrapped in the helper introduced in Step 3.

- [ ] **Step 2: Add failing test**

```ts
// tests/database.test.ts
describe("events table append-only invariant", () => {
  it("rejects UPDATE on events", () => {
    db.prepare(`INSERT INTO events (handoffUid, sessionUid, eventType, payload, createdAt) VALUES ('h','s','x','{}', ?)`).run(new Date().toISOString());
    expect(() => db.exec(`UPDATE events SET eventType = 'y'`)).toThrow(/append-only/);
  });

  it("rejects DELETE on events", () => {
    expect(() => db.exec(`DELETE FROM events`)).toThrow(/append-only/);
  });

  it("permits INSERT into events", () => {
    expect(() => db.prepare(`INSERT INTO events (handoffUid, sessionUid, eventType, payload, createdAt) VALUES ('h2','s','z','{}', ?)`).run(new Date().toISOString())).not.toThrow();
  });
});
```

- [ ] **Step 3: Add triggers via migration**

```ts
// src/database/migrations/<NNN>-events-append-only.ts
db.exec(`
  CREATE TRIGGER IF NOT EXISTS events_no_update
    BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events table is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS events_no_delete
    BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events table is append-only');
  END;
`);
```

Register the migration in the migration runner.

- [ ] **Step 4: Add maintenance escape hatch (loudly named)**

```ts
// src/database/maintenance.ts

/**
 * MAINTENANCE / TEST-ONLY. Disables the events append-only trigger for the
 * duration of `fn`, then restores it. Calling this from production code is a
 * bug — any legitimate use case (schema migration, test fixture reset) must
 * justify itself in code review. The name is deliberately verbose so a
 * grep for it in `src/` (excluding `src/database/migrations/` and tests)
 * flags review attention.
 */
export function __MAINTENANCE_ONLY_withEventsTriggersDisabled<T>(
  db: CollabDatabase,
  fn: () => T,
): T {
  db.exec(`DROP TRIGGER IF EXISTS events_no_update`);
  db.exec(`DROP TRIGGER IF EXISTS events_no_delete`);
  try {
    return fn();
  } finally {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;
    `);
  }
}
```

The double-underscore prefix and `MAINTENANCE_ONLY` segment are intentional: a grep for the name in production code (`src/` outside `src/database/migrations/` and `tests/`) should surface zero hits. Add a lint or CI check later if desired.

- [ ] **Step 5: Fix any test fixtures**

Any hit from Step 1 in `tests/` must be replaced:
- For full DB reset: drop and recreate the whole DB file rather than `DELETE FROM events`.
- For targeted cleanup mid-test: wrap in `__MAINTENANCE_ONLY_withEventsTriggersDisabled(db, () => …)`.

- [ ] **Step 6: Run tests**

```bash
npm run build
npm run test:run
```

Expected: full suite pass.

- [ ] **Step 7: Commit**

```bash
git add src/database/ tests/
git commit -m "Enforce events table append-only at schema level"
```

---

## Phase 2 Design Record (deferred): Provider Prompt-Readiness Detection

**Gate:** managed-worker smoke green against an installed The Vault build. Do not implement until at least one real Codex worker has demonstrated launch → ping → ack end-to-end.

**Why deferred:** designing prompt regex without ground truth from real PTY output produces brittle markers that need rework. The smoke run will produce captured PTY traces that should be the seed data.

**Design:**

Interface:

```ts
interface ProviderReadiness {
  provider: "codex" | "claude-code";
  /** Markers whose match in the last N bytes indicates the worker is at prompt. */
  readyMarkers: RegExp[];
  /** Markers whose match indicates an active tool call / not safe to inject. */
  notReadyMarkers: RegExp[];
  /** Minimum quiet time after last PTY output before a write is considered safe. */
  quietWindowMs: number;
  /** Window size (bytes) to scan from the tail of the buffer. */
  scanWindowBytes: number;
}
```

Decision algorithm:

1. Take last `scanWindowBytes` bytes of PTY output buffer (rolling).
2. If any `notReadyMarkers` regex matches → not safe.
3. If no `readyMarkers` regex matches → unknown, fall back to existing time-based gate (`session.status === 'idle' AND PTY quiet for default N ms AND worker.status === 'running'`).
4. If a `readyMarkers` regex matches AND last PTY output is older than `quietWindowMs` → safe.

Implementation order:

1. Capture PTY output during the next managed-worker smoke run (add `--capture-pty <path>` to The Vault broker).
2. Inspect captured traces; identify the actual idle-prompt marker for Codex.
3. Encode markers for the Codex provider only.
4. Wire into `vault-collab-managed-workers.ts`'s delivery gate, with the existing time-based gate as fallback.
5. Add Claude Code markers once Claude Code is launched as a managed worker.

Failure modes to design for:
- Provider TUI change breaks the regex → fallback continues to work, just at lower fidelity.
- ANSI escape sequences in the buffer (cursor moves, colors) → strip via a small ANSI tokenizer before regex match.

---

## Phase 3 Design Record (deferred): Deferred-Delivery Queue

**Gate:** Phase 2 stable. The queue's flush trigger depends on prompt-readiness detection; building it before is wasted iteration.

**Why deferred:** the queue turns delivery into a state machine. Initial UX (record failed/not-idle-safe attempts in `attention_delivery_attempts` and surface in the dashboard) gives ~80% of the user-visible value while we validate the receiver path.

**Design:**

State:

```ts
interface QueuedDelivery {
  sessionUid: string;
  latestEventId: number;
  composedMessage: string;
  queuedAt: string;
  attempts: number;
}

interface DeliveryQueue {
  enqueue(item: QueuedDelivery): void;
  flush(sessionUid: string): Promise<{ delivered: boolean; reason?: string }>;
  size(sessionUid: string): number;
}
```

Persistence (SQLite mirror, owned by The Vault, not Vault Collab):

```sql
CREATE TABLE IF NOT EXISTS pending_deliveries (
  sessionUid TEXT NOT NULL,
  latestEventId INTEGER NOT NULL,
  composedMessage TEXT NOT NULL,
  queuedAt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sessionUid, latestEventId)
);
```

Flush behavior:
- Triggered by: provider-readiness transition to ready, periodic check (30 s fallback), or explicit `flushAll()`.
- Coalesces all pending items for the worker into one composed message ("Vault Collab attention (3 pending): …").
- On success: write to PTY, advance `attention-ack` to max `latestEventId`, clear queue rows for that worker.
- On failure: increment `attempts`, leave in queue, record failed delivery attempt in Vault Collab.

Bounded queue:
- Hard cap 20 items per worker.
- If exceeded, drop oldest with reason `queue_overflow` recorded as failed delivery attempt.

Restart recovery:
- On Electron boot, load `pending_deliveries` for currently-owned workers (identified by orphan-recovery).
- For workers without an owned PTY: leave queue rows for visibility but mark worker disconnected so coordinator sees the unresolved deliveries.

Failure modes:
- PTY write succeeds but worker dies mid-prompt → ack does not advance, queue stays, next flush retries.
- Queue grows unbounded due to permanently-stuck worker → cap + drop-oldest, dashboard shows growing failed-attempt count, user investigates.

---

## Verification Gates

Do not claim Phase 1 done until all of these pass:

```bash
# Vault Collab repo
npm run build
npm run test:run -- tests/handoff.service.test.ts tests/session.service.test.ts tests/event.service.test.ts tests/database.test.ts tests/cli.test.ts tests/mcp-tools.test.ts
npm run typecheck

# CLI smoke
node dist/cli.js sweep-leases --db /tmp/vc-smoke.db
node dist/cli.js list-events --trace vc_trace_<some-id> --db /tmp/vc-smoke.db
node dist/cli.js list-events --db /tmp/vc-smoke.db   # confirm payload contains traceId
```

For Phase 2 and Phase 3, add their verification gates when those phases are activated.

---

## Best-Way Assessment

This phase is the right next step because it converts three latent failure modes into explicit, observable behaviors:

- **Lease expiry** converts "session crash → ghost claim forever" into "session crash → claim auto-recovers within LEASE_TTL". The audit event makes the cause visible to the original claimer's next session and to any reviewer.
- **trace_id in payload** is a small, additive change that pays off enormously in incident response. Putting it in payload first (not a column) means zero schema risk; promotion to a column later is a clean migration once the shape is proven.
- **Append-only trigger** costs nothing operationally and prevents a class of subtle bugs that would otherwise only show up under audit. Codex correctly flagged this as low-effort high-value.

Deferring prompt-readiness and the deferred queue is correct. Both depend on a working PTY receiver. Designing them blind produces worse code, more iteration, and a harder review. Capturing them here as design records preserves the analysis without committing to premature implementation.

The phase is provider-neutral: nothing in Phase 1 couples Vault Collab to The Vault or to any specific provider. That preserves the architecture invariant from `docs/pty-process-ownership-gate.md`.

---

## Self-Review

- **Spec coverage:**
  - Lease lifecycle: Task 1 (set/refresh on lifecycle ops), Task 2 (heartbeat + disconnect), Task 3 (sweep + audit).
  - trace_id: Task 4 (helpers + injection + inheritance + CLI/MCP filter + docs/tests).
  - Append-only events: Task 5 (audit + trigger + escape hatch + test).
  - Phase 2 design: provider prompt-readiness with deferred implementation gate.
  - Phase 3 design: deferred-delivery queue with deferred implementation gate.
- **Placeholder scan:** no TBD/TODO in Phase 1 tasks. Phase 2/3 are explicitly design records, gated.
- **Type consistency:**
  - `leaseExpiresAt` matches existing column type (ISO string).
  - `traceId` lives in JSON payload only; no schema column in Phase 1.
  - Event payload extension is additive; existing consumers ignore unknown keys.
- **Backward compatibility:**
  - Pre-existing claimed handoffs get a backfill on migration (Task 1 Step 5).
  - Pre-existing events without `traceId` in payload sort to the bottom of trace queries (they don't match any traceId filter, which is correct).
  - Append-only trigger is enforced on the upgraded DB; legitimate maintenance uses `__MAINTENANCE_ONLY_withEventsTriggersDisabled`.
- **Concurrency:**
  - Sweep is atomic per transaction with `BEGIN IMMEDIATE`; two sweepers see disjoint rows.
  - Heartbeat refresh and update refresh race-safe (last-write-wins is correct here).
  - Disconnect cascade and sweep can interleave; the cascade only writes `leaseExpiresAt = now`, sweep then UPDATEs the status — both idempotent.
- **Documentation:**
  - Agent guide gains a loop entry on traceId.
  - `src/types.ts` gains doc comments on `Event.payload.traceId` and `LEASE_TTL_MS` env override.
  - This plan documents Phase 2/3 design so a future session has context.
