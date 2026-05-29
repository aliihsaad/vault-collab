# Vault Collab V1 Current Scope

Vault Collab starts as a standalone, provider-neutral local collaboration core.

Current scope:
- TypeScript, Vitest, and SQLite scaffold.
- Local session registration, heartbeat, state, disconnect, and listing.
- Local handoff publish, list, claim, update, resolve, and reopen.
- Audited recovery resolution for completed handoffs stranded after owner-token
  loss, requiring source/recovery-capable actor credentials plus reason,
  summary, and Vault memory evidence.
- Read-only event history listing for inspectable session and handoff lifecycles.
- Soft session pings (`session.pinged`) and explicit permission-needed events
  (`session.permission_requested`, `handoff.permission_requested`) for
  dashboard attention indicators without waking stopped agents.
- Read-only selected handoff detail bundles containing the handoff, lifecycle
  events, and non-token related session snapshots.
- JSON CLI smoke commands for the local session and handoff lifecycle.
- Neutral MCP tools under the `vault_collab_` prefix.
- Optional Vault memory links for full handoff briefs:
  - publish with an existing `vaultMemoryUid`,
  - publish with an injected Vault memory client,
  - or link an existing handoff to a Vault memory UID as the source session owner.
- Additive v2 Phase 1 coordination metadata:
  - durable provider-neutral agent profiles,
  - advisory role labels (`coordinator`, `implementer`, `reviewer`, `sweeper`,
    `observer`, or custom strings),
  - optional session binding to agent profiles,
  - labeled ordered handoff queues,
  - append-only discussion threads and messages.
- Phase 4 usage notes are in `docs/phase-4-vault-link.md`.

Deferred:
- Vault Desktop UI.
- Graphify enrichment.
- Octogent bridge.
- Automatic execution.
- Automatic claiming.
- Active-session interruption or reassignment.
- Agent config mutation.
- Delete or clean commands.

## V2 Phase 1 Boundaries

Agent profiles and roles are data, not provider-specific classes. Codex, Claude
Code, Claude Desktop, OpenCode, Gemini, Octogent, and `other` clients can all
bind sessions to agent profiles.

Discussion messages are append-only and token-safe. Creating a discussion and
adding messages requires a valid session owner token, but neither action claims,
resolves, reassigns, or executes a handoff.

Soft pings are attention events only. They are useful for dashboards and active
polling agents, but they do not wake a dead process, auto-claim work, or execute
commands. Permission requests update session/handoff state to `awaiting_user`
and store the question in public detail fields so old read-only dashboards can
degrade safely while newer dashboards count and highlight the dedicated event
types.

Recovery resolution is a provenance-preserving lifecycle path for operational
dead ends caused by context compaction or client restart. It emits
`handoff.recovery_resolved`, clears stale current-handoff pointers, preserves the
previous claim owner on the handoff record, and requires linked Vault memory
evidence.

Queue metadata is additive. Existing inbox behavior remains compatible, while
new callers can filter and sort by `queueKey`, `labels`, `queuePosition`, and
`dependsOnHandoffUid`.
