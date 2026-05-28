# Vault Collab V1 Current Scope

Vault Collab starts as a standalone, provider-neutral local collaboration core.

Current scope:
- TypeScript, Vitest, and SQLite scaffold.
- Local session registration, heartbeat, state, disconnect, and listing.
- Local handoff publish, list, claim, update, resolve, and reopen.
- JSON CLI smoke commands for the local session and handoff lifecycle.
- Neutral MCP tools under the `vault_collab_` prefix.
- Optional Vault memory links for full handoff briefs:
  - publish with an existing `vaultMemoryUid`,
  - publish with an injected Vault memory client,
  - or link an existing handoff to a Vault memory UID as the source session owner.

Deferred:
- Vault Desktop UI.
- Graphify enrichment.
- Octogent bridge.
- Automatic execution.
- Agent config mutation.
- Delete or clean commands.
