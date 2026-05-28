# Squad Reference Audit

Vault Collab is an independent, provider-neutral collaboration project. It uses
`C:\Users\Mini\Desktop\cloned-repos\squad` as a design reference, not as a fork,
copy, or rebrand.

This audit documents what informed Vault Collab and what was intentionally left
out.

## Reference Files

### `squad\README.md`

The README informed the broad collaboration shape:

- Multiple AI clients can coordinate through local command-line workflows.
- Claude Code, Codex CLI, Gemini CLI, and OpenCode are treated as participants
  in one local collaboration space.
- A shared SQLite database can provide inspectable state without a daemon.
- Agent-readable JSON output is useful for automation-safe polling and scripting.

Vault Collab keeps the provider-neutral, local-first collaboration idea, but
does not copy the role-oriented workflow from the README.

### `squad\src\store.rs`

The store implementation informed these local-core patterns:

- A SQLite-backed local store for sessions, messages/tasks, and lifecycle state.
- Session metadata stored alongside participant records.
- Structured lifecycle transitions for work items.
- Conditional updates for race-sensitive transitions, especially claim/ack style
  operations where only one participant should win.
- Deterministic listing and filterable state views.

Vault Collab adapts those ideas into its own TypeScript services:

- `sessions` hold provider-neutral client metadata and owner tokens.
- `handoffs` replace squad's task/message model with a Vault-oriented handoff
  inbox.
- claim/update/resolve/reopen are local service methods with explicit ownership
  checks.

### `squad\src\session.rs`

The session module informed Vault Collab's owner-token rule:

- A participant has a session token.
- Mutating actions validate that the caller still owns the session identity.
- A stale or replaced session should not silently continue acting as the owner.

Vault Collab implements this at the service/database boundary instead of through
per-agent token files. Session tokens are returned to the registering client and
are required for heartbeat, state update, disconnect, claim, update, resolve,
release, and user-confirmation actions.

### `squad\tests\task_test.rs`

The task tests informed Vault Collab's test shape:

- Lifecycle tests should cover create, claim/ack, complete/resolve, requeue/reopen,
  and listing.
- Tests should verify stale conditional updates fail instead of pretending work
  changed.
- Tests should verify filter behavior and deterministic ordering.

Vault Collab uses these as testing lessons, not as copied assertions. Its tests
cover sessions, handoffs, CLI smoke commands, MCP tools, and Vault-linked handoff
publishing.

### `squad\docs\superpowers\specs\2026-03-22-poll-receive-design.md`

This design note informed Vault Collab's stance on blocking receive loops:

- Default blocking `receive --wait` workflows can interact badly with AI tool
  timeouts.
- A backgrounded blocking receive can create competing consumers.
- A one-shot check better matches the "execute, inspect, decide, execute again"
  model used by AI coding tools.

Vault Collab therefore avoids making a blocking receive loop the default workflow.
Inbox/list tools are non-blocking. Future waiting or notification behavior should
be explicit and should not create hidden competing consumers.

## Borrowed Concepts

Vault Collab intentionally borrows these concepts at the design level:

- Local SQLite store: local-first, inspectable state with no required daemon.
- Session token ownership: clients must prove ownership before mutating session
  or handoff state.
- Conditional update / atomic claim pattern: claim-like operations must be safe
  when multiple clients race for the same work.
- Lifecycle tests: behavior is defined through tests before implementation.
- Provider-neutral collaboration: Codex, Claude Code, Claude Desktop, Gemini,
  OpenCode, Octogent, and future MCP clients should participate through a common
  protocol.
- Avoiding blocking receive loops: default workflows should be one-shot and
  inspectable rather than long-running hidden consumers.

## Explicit Non-Copy Decisions

Vault Collab deliberately does not copy these squad behaviors:

- No fixed roles like manager, worker, or inspector.
- No role templates in v1.
- No `clean` command or destructive reset path.
- No auto-mutation of `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Codex skills, or
  agent configuration files.
- No default blocking `receive --wait` loop.
- No source-code copy or rebrand. Squad is a reference for patterns and lessons
  only.

## Current Vault Collab Direction

Vault Collab's own model is centered on:

- Provider-neutral sessions.
- Handoff inboxes.
- Atomic claim/update/resolve/reopen lifecycle.
- Optional Vault memory links for full handoff briefs.
- MCP tools with a neutral `vault_collab_` prefix.

The result should stay local-first, inspectable, reversible where possible, and
free of hidden automation.
