# Vault Collab V1 Current Scope

Vault Collab starts as a standalone, provider-neutral local collaboration core.

Current scope:
- TypeScript, Vitest, and SQLite scaffold.
- Local session registration, heartbeat, state, disconnect, and listing.
- Local handoff publish, list, claim, update, resolve, and reopen.
- Read-only event history listing for inspectable session and handoff lifecycles.
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

Queue metadata is additive. Existing inbox behavior remains compatible, while
new callers can filter and sort by `queueKey`, `labels`, `queuePosition`, and
`dependsOnHandoffUid`.
