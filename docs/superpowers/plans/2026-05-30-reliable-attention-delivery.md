# Reliable Attention Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vault Collab honest and reliable about attention delivery by modeling whether a session can actually receive pings without a manual prompt.

**Architecture:** Split the fix into two layers. First, add delivery capability metadata and dashboard/API affordances so manual sessions are clearly `manual_poll` and not shown as wakeable. Second, add a managed receiver path for sessions that Vault Collab or The Vault launches and owns, where delivery can be acknowledged end to end.

**Tech Stack:** TypeScript, SQLite, Vitest, existing Vault Collab services/CLI/MCP.

---

## File Map

- `src/types.ts`: add delivery capability/status types to session records.
- `src/database/schema.ts`: add session delivery columns with migration/backfill.
- `src/services/session.service.ts`: persist delivery metadata, expose defaults, and update registration/listing.
- `src/services/attention.service.ts`: keep attention read behavior; add delivery state only if needed for feed summaries.
- `src/services/handoff.service.ts`: keep `claimed_by_other_handoff` attention clarity if accepted as adjacent hardening.
- `src/cli.ts`: expose registration flags and status output for delivery capability.
- `src/mcp/tools.ts`: expose MCP registration fields and tool schema descriptions.
- `tests/session.service.test.ts`: cover session delivery metadata defaults and updates.
- `tests/mcp-tools.test.ts`: cover MCP registration/output contract.
- `tests/cli.test.ts`: cover CLI registration flags and JSON output.
- `README.md`: document manual vs managed delivery behavior.
- `docs/reliable-attention-delivery.md`: keep as product/design reference.

---

### Task 1: Add Session Delivery Metadata

**Files:**
- Modify: `src/types.ts`
- Modify: `src/database/schema.ts`
- Modify: `src/services/session.service.ts`
- Test: `tests/session.service.test.ts`

- [ ] **Step 1: Write failing service tests**

Add tests proving manually registered sessions default to non-wakeable delivery, and managed-capable sessions can declare a receiver.

```ts
it("defaults manually registered sessions to manual polling delivery", () => {
  const session = service.registerSession({
    displayName: "Manual Codex",
    clientType: "codex",
    project: "Vault Collab",
    workspacePath,
    capabilities: {}
  });

  expect(session.delivery).toEqual({
    mode: "manual_poll",
    wakeable: false,
    lastAckEventId: null,
    lastAckAt: null
  });
});

it("persists declared managed process delivery metadata", () => {
  const session = service.registerSession({
    displayName: "Managed Codex",
    clientType: "codex",
    project: "Vault Collab",
    workspacePath,
    capabilities: {},
    delivery: {
      mode: "managed_process",
      wakeable: true
    }
  });

  expect(service.requireSession(session.sessionUid).delivery).toMatchObject({
    mode: "managed_process",
    wakeable: true,
    lastAckEventId: null,
    lastAckAt: null
  });
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `npm run test:run -- tests/session.service.test.ts`

Expected: fail because `delivery` is not part of registration/session records yet.

- [ ] **Step 3: Add delivery types**

In `src/types.ts`, add:

```ts
export type SessionDeliveryMode =
  | "manual_poll"
  | "local_watch"
  | "mcp_notification"
  | "managed_process";

export interface SessionDeliveryState {
  mode: SessionDeliveryMode;
  wakeable: boolean;
  lastAckEventId: number | null;
  lastAckAt: string | null;
}
```

Extend `RegisterSessionInput` with:

```ts
delivery?: {
  mode?: SessionDeliveryMode;
  wakeable?: boolean;
};
```

Extend `RegisteredSession` with:

```ts
delivery: SessionDeliveryState;
```

- [ ] **Step 4: Add schema columns and backfill**

In `src/database/schema.ts`, add migration columns to `sessions`:

```ts
addColumnIfMissing(db, "sessions", "delivery_mode", "TEXT NOT NULL DEFAULT 'manual_poll'");
addColumnIfMissing(db, "sessions", "delivery_wakeable", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing(db, "sessions", "delivery_last_ack_event_id", "INTEGER");
addColumnIfMissing(db, "sessions", "delivery_last_ack_at", "TEXT");
```

- [ ] **Step 5: Persist and map delivery metadata**

In `src/services/session.service.ts`, update insert/select/map logic so:

```ts
const deliveryMode = input.delivery?.mode ?? "manual_poll";
const deliveryWakeable = input.delivery?.wakeable === true ? 1 : 0;
```

Map DB rows to:

```ts
delivery: {
  mode: row.delivery_mode as SessionDeliveryMode,
  wakeable: row.delivery_wakeable === 1,
  lastAckEventId: row.delivery_last_ack_event_id,
  lastAckAt: row.delivery_last_ack_at
}
```

- [ ] **Step 6: Run service tests**

Run: `npm run test:run -- tests/session.service.test.ts`

Expected: pass.

---

### Task 2: Expose Delivery Capability Through CLI And MCP

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Write failing CLI and MCP tests**

Add a CLI test that registers with:

```powershell
node dist\cli.js register --db $db --display-name "Managed Codex" --client-type codex --project "Vault Collab" --workspace-path . --delivery-mode managed_process --wakeable
```

Assert output contains:

```ts
delivery: {
  mode: "managed_process",
  wakeable: true,
  lastAckEventId: null,
  lastAckAt: null
}
```

Add an MCP test that calls `vault_collab_register_session` with:

```ts
deliveryMode: "local_watch",
deliveryWakeable: false
```

Assert output contains `delivery.mode === "local_watch"` and `delivery.wakeable === false`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run test:run -- tests/cli.test.ts tests/mcp-tools.test.ts`

Expected: fail because CLI flags and MCP schema fields do not exist.

- [ ] **Step 3: Add CLI flags**

In `src/cli.ts`, registration should parse:

```ts
delivery: {
  mode: optionalSessionDeliveryMode(parsed, "delivery-mode") ?? "manual_poll",
  wakeable: parsed.options.has("wakeable")
}
```

Add `optionalSessionDeliveryMode` that accepts only:

```ts
manual_poll
local_watch
mcp_notification
managed_process
```

- [ ] **Step 4: Add MCP schema fields**

In `src/mcp/tools.ts`, extend registration input schema with:

```ts
deliveryMode: z.enum(sessionDeliveryModeValues).optional(),
delivery_mode: z.enum(sessionDeliveryModeValues).optional(),
deliveryWakeable: z.boolean().optional(),
delivery_wakeable: z.boolean().optional()
```

Pass them into `sessions.registerSession`.

- [ ] **Step 5: Run CLI/MCP tests**

Run: `npm run test:run -- tests/cli.test.ts tests/mcp-tools.test.ts`

Expected: pass.

---

### Task 3: Add Attention Acknowledgement

**Files:**
- Modify: `src/services/session.service.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/session.service.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Write failing acknowledgement tests**

Service test:

```ts
const session = service.registerSession({
  displayName: "Watcher",
  clientType: "codex",
  project: "Vault Collab",
  workspacePath,
  capabilities: {},
  delivery: { mode: "local_watch", wakeable: false }
});

const acknowledged = service.acknowledgeAttention(
  session.sessionUid,
  session.sessionToken,
  42
);

expect(acknowledged.delivery.lastAckEventId).toBe(42);
expect(acknowledged.delivery.lastAckAt).toBe("2026-05-30T12:00:00.000Z");
```

CLI/MCP tests should prove owner token is required and tokens are not leaked.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run test:run -- tests/session.service.test.ts tests/cli.test.ts tests/mcp-tools.test.ts`

Expected: fail because acknowledgement API does not exist.

- [ ] **Step 3: Implement service method**

Add to `SessionService`:

```ts
acknowledgeAttention(
  sessionUid: string,
  sessionToken: string,
  latestEventId: number
): RegisteredSession {
  this.assertSessionOwner(sessionUid, sessionToken);
  const acknowledgedAt = this.now();
  this.db
    .prepare(
      `
      UPDATE sessions
      SET delivery_last_ack_event_id = ?,
          delivery_last_ack_at = ?,
          updated_at = ?
      WHERE session_uid = ?
    `
    )
    .run(latestEventId, acknowledgedAt, acknowledgedAt, sessionUid);

  this.events.recordEvent({
    eventType: "session.attention_acknowledged",
    sessionUid,
    payload: { latestEventId, acknowledgedAt }
  });

  return this.requireSession(sessionUid);
}
```

- [ ] **Step 4: Add CLI/MCP commands**

CLI command:

```powershell
vault-collab attention-ack --db $db --session-uid vc_sess_... --session-token ... --latest-event-id 42
```

MCP tool:

```ts
vault_collab_acknowledge_attention
```

Required args: `sessionUid/session_uid`, `sessionToken/session_token`, `latestEventId/latest_event_id`.

- [ ] **Step 5: Run tests**

Run: `npm run test:run -- tests/session.service.test.ts tests/cli.test.ts tests/mcp-tools.test.ts`

Expected: pass.

---

### Task 4: Make Ping Results Honest

**Files:**
- Modify: `src/services/session.service.ts`
- Modify: `src/types.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/session.service.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Write failing tests for ping delivery result**

Manual session expected:

```ts
expect(result.delivery).toMatchObject({
  mode: "manual_poll",
  wakeable: false,
  delivered: false,
  nextStep: "Target session must poll attention manually or run a watcher."
});
```

Managed session expected:

```ts
expect(result.delivery).toMatchObject({
  mode: "managed_process",
  wakeable: true,
  delivered: false,
  nextStep: "Await receiver acknowledgement."
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run test:run -- tests/session.service.test.ts tests/cli.test.ts tests/mcp-tools.test.ts`

Expected: fail because ping returns only an event.

- [ ] **Step 3: Return a ping result envelope**

Add:

```ts
export interface PingSessionResult {
  event: EventRecord;
  targetSession: RegisteredSession;
  delivery: {
    mode: SessionDeliveryMode;
    wakeable: boolean;
    delivered: false;
    nextStep: string;
  };
}
```

Change `pingSession` to return `PingSessionResult`.

- [ ] **Step 4: Preserve token safety**

Assert JSON output does not contain target or actor session tokens.

- [ ] **Step 5: Run tests**

Run: `npm run test:run -- tests/session.service.test.ts tests/cli.test.ts tests/mcp-tools.test.ts`

Expected: pass.

---

### Task 5: Update Documentation And Dashboard Contract

**Files:**
- Modify: `README.md`
- Modify: `docs/reliable-attention-delivery.md`
- Modify: `docs/cockpit-v2-actionable-dashboard-contract.md`

- [ ] **Step 1: Document delivery classes**

Add CLI examples:

```powershell
node dist\cli.js register --db $db --display-name "Manual Codex" --client-type codex --project "Vault Collab" --workspace-path . --delivery-mode manual_poll

node dist\cli.js register --db $db --display-name "Managed Codex" --client-type codex --project "Vault Collab" --workspace-path . --delivery-mode managed_process --wakeable
```

- [ ] **Step 2: Document ping semantics**

State:

```md
Ping stores an attention event. It is only delivered when a receiver polls,
acknowledges, or a managed process adapter receives it.
```

- [ ] **Step 3: Document dashboard display rules**

Dashboard contract should say:

```md
Show `manual_poll` sessions as "manual attention only"; do not label ping as
wake. Show `managed_process` and verified adapters as wakeable only when
`delivery.wakeable` is true.
```

- [ ] **Step 4: Run verification**

Run:

```powershell
npm run test:run -- tests/session.service.test.ts tests/cli.test.ts tests/mcp-tools.test.ts tests/attention.service.test.ts
npm run build
```

Expected: all pass.

---

### Task 6: Decide The Managed Receiver Adapter Separately

**Files:**
- Create: `docs/superpowers/plans/YYYY-MM-DD-managed-attention-receiver.md`

- [ ] **Step 1: Write a separate implementation plan**

The managed receiver is a larger feature and should not be mixed with delivery metadata. The plan must answer:

```md
- Which process owns the target session?
- How does the receiver poll or subscribe?
- How does it acknowledge latestEventId?
- How does it notify or inject input into Codex/Claude safely?
- What permissions and workspace boundaries apply?
- How does the dashboard show receiver failure?
```

Use Octogent's channel delivery model as the main local reference:

```md
Reference repo: C:/Users/Mini/Desktop/cloned-repos/octogent
Relevant docs:
- docs/guides/inter-agent-messaging.md
- docs/concepts/runtime-and-api.md

Relevant source:
- apps/api/src/terminalRuntime/channelMessaging.ts
- apps/api/src/terminalRuntime/hookProcessor.ts
- apps/api/src/terminalRuntime/sessionRuntime.ts

Borrow the pattern, not the exact persistence model:
- queue per target session
- deliver immediately if target is idle
- retry delivery on idle/stop hook events
- compose pending messages into one input injection
- write only to owned PTY/input channels
- mark delivered after write

Improve it for Vault Collab by persisting delivery state and acknowledgements.
```

- [ ] **Step 2: Do not start adapter implementation in this branch**

Stop after the metadata/API layer is verified unless the user explicitly approves the next plan.

---

## Self-Review

Spec coverage:
- Delivery truth is covered by Tasks 1, 2, 4, and 5.
- Receiver acknowledgement is covered by Task 3.
- Managed wake behavior is deliberately split into Task 6 because it needs adapter/process ownership design.
- Existing adjacent `claimed_by_other_handoff` hardening is not the delivery fix and should be reviewed separately before commit.

Placeholder scan:
- No task depends on unspecified code or hidden behavior.
- The managed adapter is intentionally out of scope for this plan and has its own required plan.

Type consistency:
- Delivery mode names are consistent across types, CLI, MCP, docs, and tests.
- Acknowledgement uses `latestEventId` in TS and `latest-event-id`/`latest_event_id` in CLI/MCP inputs.
