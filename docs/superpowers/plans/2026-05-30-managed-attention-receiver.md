# Managed Attention Receiver Implementation Plan

> For agentic workers: use `superpowers:subagent-driven-development` for the
> implementation tasks and `superpowers:test-driven-development` for each
> behavior change.

## Goal

Add an end-to-end managed receiver path for sessions that Vault Collab or a
trusted local broker owns. A managed session should be able to receive attention
events without waiting for a manual user prompt, and Vault Collab should only
mark delivery successful after a receiver has observed and acknowledged the
event.

This plan deliberately does not change manual sessions. `manual_poll` remains
stored-but-undelivered attention.

## Ownership Model

Vault Collab itself is still the durable coordination store. A separate local
broker process owns process I/O and can safely claim `managed_process`
capability.

The broker must:

- register its own broker session with `launchBroker: true`;
- launch or attach only to processes it owns;
- register launched sessions with `delivery.mode = "managed_process"` and
  `delivery.wakeable = true`;
- keep the launched session token private to the broker process;
- poll attention by cursor for each managed session;
- deliver attention through an adapter only when the target input channel is
  known and idle-safe;
- call `acknowledgeAttention(sessionUid, sessionToken, latestEventId)` only
  after delivery has been written or otherwise confirmed.

Manual Codex/Claude sessions cannot be upgraded to `managed_process` merely
because they are registered in the database. There must be a verified adapter.

## Current Constraints

- `launch_requests` records lifecycle intent, approval, broker pickup, and a
  registered launched session. It does not spawn processes.
- `SessionService` now stores delivery mode/wakeable/ack metadata.
- `pingSession` now returns `PingSessionResult` with `delivered = false`.
- There is no existing PTY or child-process runtime in this package.
- `package.json` has no PTY dependency. If terminal injection is required,
  choose one explicitly in the implementation task and justify it.

## Reference Pattern

Use Octogent as the behavioral reference, not as a direct copy:

- `C:/Users/Mini/Desktop/cloned-repos/octogent/docs/guides/inter-agent-messaging.md`
- `C:/Users/Mini/Desktop/cloned-repos/octogent/docs/concepts/runtime-and-api.md`
- `C:/Users/Mini/Desktop/cloned-repos/octogent/apps/api/src/terminalRuntime/channelMessaging.ts`
- `C:/Users/Mini/Desktop/cloned-repos/octogent/apps/api/src/terminalRuntime/hookProcessor.ts`
- `C:/Users/Mini/Desktop/cloned-repos/octogent/apps/api/src/terminalRuntime/sessionRuntime.ts`

Borrow these ideas:

- queue attention per target session;
- deliver immediately if the target is idle;
- retry delivery on idle/stop transitions;
- compose pending messages into one injected prompt;
- write only to owned PTY/input channels;
- mark delivered only after the write succeeds.

Improve the pattern by persisting receiver state, acknowledgement cursors, and
failure reasons.

## Proposed Architecture

Add three layers:

1. **Receiver service**
   - Owns attention polling and acknowledgement rules.
   - Accepts a `ReceiverAdapter` interface.
   - Does not know about PTYs, terminals, or provider-specific launch commands.

2. **Adapter interface**
   - Represents a verified input channel for a managed session.
   - Has `canDeliver(session)`, `deliver(batch)`, and `close(sessionUid)`.
   - Returns a structured result with success/failure reason.

3. **Local broker CLI**
   - Runs on the same machine as the managed processes.
   - Owns spawned child processes or PTYs.
   - Registers launched sessions and links them to launch requests.
   - Runs a bounded or long-running receiver loop.

## Data Model

Add a persisted delivery-attempt table rather than overloading events:

```sql
CREATE TABLE attention_delivery_attempts (
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
```

Statuses:

- `pending`: receiver saw work but has not written it yet.
- `delivered`: adapter wrote/surfaced the batch and acknowledgement was recorded.
- `failed`: adapter could not deliver; `message` explains why.

Keep acknowledgement cursor on `sessions.delivery_last_ack_event_id` and
`delivery_last_ack_at`.

## Attention Batch Format

The receiver should ask `AttentionService.getSessionAttention(sessionUid, {
sinceEventId: lastAckEventId ?? 0,
includeCurrentHandoffs: true
})`.

Batch rules:

- Skip empty feeds.
- Use `feed.latestEventId` as `toEventId`.
- Compose event-backed items and current handoff state into a concise prompt.
- Never include session tokens.
- Do not auto-claim handoffs.
- Do not execute commands.

Example injected text:

```text
Vault Collab attention:
- Ping from vc_sess_...: Check the inbox when active.
- Suggested handoff vc_handoff_...: Review failing test.

Inspect attention before acting. Do not auto-claim unless appropriate.
```

## Task 1: Receiver Service With Fake Adapter

Files:

- Add: `src/services/attention-receiver.service.ts`
- Modify: `src/types.ts`
- Test: `tests/attention-receiver.service.test.ts`

TDD:

1. Test that a managed wakeable session with a ping is delivered through a fake
   adapter and then acknowledged to `latestEventId`.
2. Test that a `manual_poll` session is skipped with a failed/undeliverable
   result and no acknowledgement.
3. Test that adapter failure records a failed attempt and does not acknowledge.

Expected service API:

```ts
interface ReceiverAdapter {
  name: string;
  canDeliver(session: SessionSnapshot): boolean;
  deliver(batch: AttentionDeliveryBatch): Promise<AttentionDeliveryAdapterResult>;
}

class AttentionReceiverService {
  deliverOnce(sessionUid: string, sessionToken: string): Promise<AttentionDeliveryAttempt>;
}
```

The service requires the managed session token because acknowledgement is still
owner-token checked.

## Task 2: Persist Delivery Attempts

Files:

- Modify: `src/database/schema.ts`
- Modify: `src/services/attention-receiver.service.ts`
- Test: `tests/schema.test.ts`
- Test: `tests/attention-receiver.service.test.ts`

TDD:

1. Schema test verifies the table exists with indexes for `session_uid` and
   `status`.
2. Receiver tests verify delivered and failed attempts are persisted.

Indexes:

```sql
CREATE INDEX idx_attention_delivery_attempts_session
  ON attention_delivery_attempts(session_uid);
CREATE INDEX idx_attention_delivery_attempts_status
  ON attention_delivery_attempts(status);
```

## Task 3: CLI Receiver Loop

Files:

- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

Add a command:

```powershell
vault-collab receive-attention --db $db --session-uid vc_sess_... --session-token ... --interval-ms 1000 --timeout-ms 30000
```

Initial implementation can use a `stdout` adapter that prints the composed
attention batch and acknowledges after successful write. This proves the polling
and acknowledgement loop without unsafe process injection.

TDD:

1. Start the receiver loop for a `local_watch` or `managed_process` test
   session.
2. Write a ping while it is running.
3. Expect output with delivery attempt status `delivered`.
4. Expect the session's `delivery.lastAckEventId` to match the feed's
   `latestEventId`.
5. Assert no session token appears in output.

This is not a model wake guarantee yet; it is the first verified receiver loop.

## Task 4: Managed Process Adapter Design Gate

Before writing a PTY adapter, decide and document:

- Whether this package should own PTYs directly or The Vault desktop should own
  process I/O and call the receiver API.
- Which dependency is acceptable on Windows for PTY support.
- How idle state is detected for Codex/Claude.
- Whether input injection requires explicit launch-request approval metadata.
- How adapter failures surface in the dashboard.

Do not implement PTY injection until this gate is answered.

Gate outcome: answered in `docs/pty-process-ownership-gate.md`.

Decision: The Vault desktop should own PTY/process I/O through an Electron main
runtime, likely using `node-pty` for Windows/macOS/Linux PTY support. Vault
Collab remains the durable coordination and acknowledgement package. Actual
model/terminal input injection should be implemented in `the-vault` after
dashboard action wiring is verified.

## Task 5: Dashboard Contract Update

Files:

- Modify: `docs/cockpit-v2-actionable-dashboard-contract.md`
- Modify: `README.md`

Document:

- receiver loop command;
- delivery attempt statuses;
- `lastAckEventId` and `lastAckAt` display;
- failed receiver reason display;
- distinction between stdout/local receiver and managed process injection.

## Verification

Run after each task:

```powershell
npm run test:run -- tests/attention-receiver.service.test.ts
npm run build
```

Run before completion:

```powershell
npm run test:run -- tests/session.service.test.ts tests/attention.service.test.ts tests/cli.test.ts tests/mcp-tools.test.ts tests/schema.test.ts tests/attention-receiver.service.test.ts
npm run build
```

## Completion Criteria

This phase is complete when:

- a receiver loop can observe attention by cursor;
- a fake/stdout adapter can deliver and acknowledge;
- manual sessions remain non-wakeable and undelivered;
- adapter failures are persisted and visible;
- all output is token-safe;
- docs state clearly that PTY/model wake injection is a later adapter gate.
