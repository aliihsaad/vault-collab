# Vault Collab Pull-Based Comms Core — Implementation Plan (Sub-project #1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every task. Steps use checkbox (`- [ ]`) syntax. This plan is written at the contract/behavior level for a high-effort executor — follow existing repo patterns for idiomatic implementation, and do NOT regress existing passing tests.

**Goal:** Make agent-to-agent communication reliable by replacing the "push/wake" model with a "pull" model: each agent drains its own inbox via a blocking `receive` loop, and dead agents self-clean so the roster stays trustworthy.

**Architecture:** Additive and non-destructive. We ADD a pull primitive (`receive`) over the existing event/attention cursor, ACTIVATE the already-designed lease+heartbeat hygiene, formalize roles, and bake a work-loop into the agent guide. We DEPRECATE the broker (AttentionReceiverService, delivery modes, ping-as-wake, launch-request lifecycle) in place — marked deprecated, still readable — but remove nothing yet. Removal is a later slice once The Vault dashboard migrates off it.

**Tech Stack:** TypeScript, better-sqlite3, Vault Collab CLI + MCP (`src/cli.ts`, `src/mcp/tools.ts`), Vitest. No new runtime dependencies.

**Relationship to existing plan:** `docs/superpowers/plans/2026-05-30-vault-collab-robustness-phase-2.md` already specifies lease lifecycle (Tasks 1–3), trace_id (Task 4), and append-only events (Task 5). Task B below **executes that plan's Phase 1** as-is — do not redesign it; reuse it. This plan adds the pull primitive, role formalization, the work-loop, and broker deprecation around it.

**Out of scope (owned by The Vault repo, later sub-projects):** permission-gated agent launching (#2) and the operator dashboard redesign (#3). Do not touch The Vault repo. Do not delete broker code or tables.

---

## Why "pull, not push"

Today `AttentionReceiverService.deliverOnce` explicitly **fails** for `manual_poll`/non-wakeable sessions ("target must poll attention manually or run a watcher"), and the `managed_process` wake path depends on fragile Windows PTY injection. The default channel is therefore dead. squad's proven model: no daemon, no injection — each agent runs a blocking `receive` loop against shared SQLite and drains its own inbox. We adopt that. The session already has an ack cursor (`delivery.lastAckEventId`) and `getSessionAttention({ sinceEventId })`; `receive` is a thin, robust wrapper over those.

---

## File Map

- Modify: `src/services/attention.service.ts` — add `waitForAttention()` (blocking poll) + `receiveOnce()` (cursor-advancing drain).
- Modify: `src/services/session.service.ts` — lease/heartbeat/disconnect cascade (per phase-2 plan); ensure `role` is first-class on register.
- Modify: `src/services/handoff.service.ts` — lease set/refresh/sweep (per phase-2 plan).
- Modify: `src/cli.ts` — add `receive` command (`--wait`, `--timeout`, `--json`); add `sweep-leases` (per phase-2).
- Modify: `src/mcp/tools.ts` — add `vault_collab_receive`; add `vault_collab_sweep_expired_handoffs`; mark broker tools deprecated in their descriptions.
- Modify: `src/agent-guide.ts` — add the work-loop and the pull/role guidance lines.
- Modify: `src/types.ts` — `ReceiveResult`, `WaitForAttentionOptions`; doc-deprecate delivery-mode/launch-request types (keep them).
- Modify: `src/services/attention-receiver.service.ts` — add a top-of-file `@deprecated` banner; no behavior change.
- Tests: `tests/attention.service.test.ts`, `tests/session.service.test.ts`, `tests/handoff.service.test.ts`, `tests/cli.test.ts`, `tests/mcp-tools.test.ts`, `tests/agent-guide.test.ts` (create any that don't exist).

---

## Task A: `receive` pull primitive

**Files:** `src/services/attention.service.ts`, `src/cli.ts`, `src/mcp/tools.ts`, `src/types.ts`, tests.

Contract:

- `receiveOnce(sessionUid, sessionToken, { includeCurrentHandoffs?, advanceCursor? = true }): ReceiveResult`
  - Reads attention since `session.delivery.lastAckEventId` via existing `getSessionAttention`.
  - Returns `{ items, fromEventId, toEventId, drained: boolean }`.
  - If `advanceCursor` and `items.length > 0`, calls `acknowledgeAttention(sessionUid, sessionToken, toEventId)` so the next receive only returns newer events. **Idempotent:** a second immediate `receiveOnce` returns `items: []`.
- `waitForAttention(sessionUid, sessionToken, { timeoutMs = 60000, pollIntervalMs = 1000, ...receiveOpts }): ReceiveResult`
  - Loops: `receiveOnce`; if items found, return immediately; else sleep `pollIntervalMs` and retry until `timeoutMs` elapses, then return an empty `ReceiveResult` (`drained: true`). Never throws on timeout.
  - Must not hold a DB write transaction across the sleep (open/close per poll) so other agents aren't blocked.

CLI:
- `vault-collab receive <sessionUid> --token <t> [--wait] [--timeout <sec>] [--json]`
  - No `--wait`: one `receiveOnce`, print items (or "no new attention"), exit 0.
  - `--wait`: call `waitForAttention`; print on arrival or after timeout.
  - `--json`: one JSON object per line (match existing `--json` conventions in `receive`-style commands).

MCP:
- `vault_collab_receive { sessionUid, sessionToken, includeCurrentHandoffs?, advanceCursor? }` → non-blocking `receiveOnce` result. (MCP stays non-blocking; the *skill* owns looping. Do not add a long-blocking MCP call.)

TDD expectations (write failing first):
- `receiveOnce` returns new items then advances cursor; immediate re-call returns empty.
- `receiveOnce` with `advanceCursor: false` does not move the cursor.
- `waitForAttention` returns promptly when an event is inserted mid-wait (simulate by inserting an event between polls or with a short interval); returns empty after timeout with no events.
- CLI `receive --json` emits parseable lines; `--wait --timeout 1` returns within ~1s when idle.
- MCP `vault_collab_receive` advances the cursor and is idempotent.

Commit after green: `feat: add pull-based receive primitive (CLI + MCP)`.

---

## Task B: Activate lease + heartbeat hygiene (ghost cleanup)

**Files:** per `2026-05-30-vault-collab-robustness-phase-2.md` Tasks 1–3 (handoff.service, session.service, schema, cli, mcp/tools, tests).

Execute that plan's **Phase 1, Tasks 1–3 verbatim**:
- Lease set on claim, refreshed on update (Task 1).
- Heartbeat refreshes claimed-handoff leases; disconnect cascades to immediate lease expiry (Task 2).
- `sweepExpiredLeases()` releases expired claims atomically + emits `handoff.lease_expired`; invoked lazily in `listInbox`/`getSessionAttention`; `sweep-leases` CLI + `vault_collab_sweep_expired_handoffs` MCP (Task 3).

Additionally for session roster trust:
- In the lazy-disconnect path (stale heartbeat detection), ensure a session past a staleness threshold is reported `disconnected` so it drops off the live roster used by `getSessionAttention`/`listSessions` "online" views.

TDD expectations: use the test bodies given in the phase-2 plan (Tasks 1–3). Add one test: a session whose `last_heartbeat_at` is older than the staleness threshold is treated as disconnected by the roster read path.

Commit per phase-2 plan's commit messages (3 commits).

*(Trace_id Task 4 and append-only Task 5 from phase-2 are valuable but optional for this slice — include them only if they land cleanly without expanding review surface. Do not block this slice on them.)*

---

## Task C: Formalize roles

**Files:** `src/services/session.service.ts`, `src/types.ts`, `src/services/agent-profile.service.ts` (exists), tests.

Contract:
- `registerSession` already accepts role-ish fields (`agentRole`, agent profiles, `list_agent_roles` exists). Ensure a session carries a single canonical `role` string (e.g. `manager | worker | reviewer | planner | <custom>`), defaulting sensibly when omitted (do not hard-fail old callers).
- `getSessionAttention`/roster snapshots expose `role` so consumers can group by it.
- Keep the existing `list_agent_roles` registry as the source of known roles; custom roles are allowed (free string) but validated as non-empty.

TDD expectations:
- Registering with `role: "reviewer"` round-trips on the session snapshot.
- Registering without a role yields the documented default, no throw.

Commit: `feat: formalize session role as first-class field`.

---

## Task D: Work-loop in the agent guide

**Files:** `src/agent-guide.ts`, `tests/agent-guide.test.ts` (or existing guide test).

Add guide content (the behavioral half — agents must actually loop):
- The operating loop: *register with a role → do your work → `receive --wait` (or `vault_collab_receive` in a poll loop) → handle pings/handoffs/discussion → repeat; heartbeat periodically; on idle, drain inbox before going quiet.*
- A line stating delivery is pull-based: agents are responsible for draining their own attention; nothing will inject messages into them.
- Reference `receive`/`vault_collab_receive` by name.

TDD expectations: guide-content test asserts the guide string contains `receive` and a "pull"/"drain your own" instruction (mirror however existing guide tests assert content).

Commit: `docs: add pull-based work-loop to agent guide`.

---

## Task E: Deprecate the broker in place (no removal)

**Files:** `src/services/attention-receiver.service.ts`, `src/mcp/tools.ts`, `src/types.ts`, `docs/`.

- Add a file-top `@deprecated` JSDoc banner to `attention-receiver.service.ts` explaining it is superseded by the pull model and slated for removal after The Vault dashboard migrates (sub-project #3). Do not change its behavior or delete it.
- In `mcp/tools.ts`, prefix the *descriptions* of the **wake/managed-execution** tools with `[DEPRECATED — use vault_collab_receive]`: `ping_session`, `list_attention_delivery_attempts`, and the launch-request **execution** lifecycle (`mark_launching`, `mark_running`, `mark_stopped`, `fail` launch_request). Keep all tools registered and functional so the current dashboard does not break.
  - **Do NOT deprecate** `create_launch_request`, `approve_launch_request`, `reject_launch_request`, `cancel_launch_request`. Those are the coordination signal "an agent requests a new agent; a human approves/rejects" — sub-project #2 (The Vault repo) builds on them. They are pure control-plane state, not fragile execution. Leave their descriptions intact.
- Add a short `docs/pull-vs-push.md` (or append to the existing agent-guide doc) recording the migration intent: pull is canonical; broker is deprecated-in-place; removal is gated on dashboard migration.

No behavior change ⇒ no new failing test required; ensure the full suite still passes and descriptions render in `tests/mcp-tools.test.ts` if it snapshots tool descriptions (update snapshots intentionally).

Commit: `chore: deprecate push/broker delivery in favor of pull`.

---

## Verification Gates (do not report done until all pass)

```bash
# in vault-collab repo
npm run build
npm run test:run
npm run typecheck   # if present

# pull primitive smoke against a throwaway DB
node dist/cli.js receive <sessionUid> --token <t> --json            # prints new items or "no new attention"
node dist/cli.js receive <sessionUid> --token <t> --wait --timeout 1 # returns within ~1s when idle
node dist/cli.js sweep-leases --db <path>                            # releases expired, prints count
```

Acceptance:
1. Two sessions: A publishes a handoff / posts a discussion message to B; B's `receive --wait` returns it without any manual poke or PTY injection. Re-running B's `receive` immediately returns empty (cursor advanced).
2. A claimed handoff whose owner stops heartbeating is auto-released by the sweep within the lease TTL, emitting `handoff.lease_expired`.
3. A session past the staleness threshold no longer appears as online in the roster.
4. Full existing suite still green; broker tools still callable (deprecated, not removed).

---

## Self-Review (author)

- **Spec coverage:** pull primitive (A), robust delivery + ghost cleanup (B), roles (C), work-loop so agents actually pull (D), deprecate-not-delete broker to protect the live dashboard (E). All approved-direction items for the comms core are covered; launch (#2) and UI (#3) are correctly excluded.
- **Non-destructive:** no table drops, no code deletion, separate DB untouched-by-design. Safe to run while the desktop app reads the same DB.
- **Type consistency:** `ReceiveResult` is defined in Task A and reused by CLI/MCP; `role` defined in Task C is consumed by roster snapshots. No forward references to undefined symbols.
- **Risk:** the only schema changes are lease columns/indexes from the phase-2 plan (already designed, backward-compatible). Coordinate timing with The Vault dashboard read path before any future broker removal (not in this slice).
