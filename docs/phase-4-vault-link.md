# Phase 4 Vault Link Guide

Phase 4 adds optional Vault memory links to local Vault Collab handoffs. The
goal is to keep short local inbox records fast and inspectable while allowing a
full handoff brief to live in Vault memory.

This phase does not add auto-execution, Vault Desktop UI, Graphify enrichment,
Octogent bridging, delete/clean behavior, fixed agent roles, or automatic
mutation of agent instruction files.

## Boundary

Vault Collab is a standalone project. It does not directly call the chat
session's Vault MCP tools from its default stdio server.

There are three supported link paths:

- Publish a local handoff with an existing `vaultMemoryUid`.
- Publish through an injected `VaultMemoryClient` when a host embeds the MCP
  tools programmatically.
- Link an existing local handoff to an existing Vault memory UID as the source
  session owner.

The default stdio server supports the local handoff and manual-link paths. The
injected `VaultMemoryClient` path is for hosts that can provide a real Vault
memory adapter.

## CLI Workflow

Build first:

```powershell
npm run build
```

The examples assume PowerShell from the repository root. Set paths from the
current checkout so they work for any user:

```powershell
$workspace = (Get-Location).Path
$db = Join-Path $workspace ".vault-collab.db"
```

Register the source session:

```powershell
node dist\cli.js register --db $db --display-name "Codex" --client-type codex --project "Vault Collab" --workspace-path $workspace --capability handoffs=true
```

The response includes a `sessionUid` and `sessionToken`. Keep the token private;
listing commands do not expose it.

If the full brief already exists in Vault memory, publish the handoff with that
memory UID:

```powershell
node dist\cli.js publish --db $db --short-prompt "Continue Phase 4 Vault link docs." --source-project "Vault Collab" --target-project "Vault Collab" --source-session-uid vc_session_... --vault-memory-uid vm_...
```

If the handoff was already published, link it afterward as the source session
owner:

```powershell
node dist\cli.js link-vault-memory --db $db --handoff-uid vc_handoff_... --session-uid vc_session_... --session-token ... --vault-memory-uid vm_...
```

The manual link command:

- requires the source session UID and token,
- rejects a non-source session,
- rejects an invalid token,
- refuses public linking when the handoff has no source session owner,
- records a `handoff.vault_memory_linked` event.

Inspect the inbox and event history:

```powershell
node dist\cli.js inbox --db $db --target-project "Vault Collab"
node dist\cli.js events --db $db --handoff-uid vc_handoff_...
node dist\cli.js events --db $db --session-uid vc_session_...
```

Event output is read-only and does not include session tokens.

## MCP Stdio Workflow

Start the standalone MCP server after building:

```powershell
$db = Join-Path (Get-Location).Path ".vault-collab.db"
node dist\mcp\server.js --db $db
```

Equivalent environment-based startup:

```powershell
$env:VAULT_COLLAB_DB = (Join-Path (Get-Location).Path ".vault-collab.db")
node dist\mcp\server.js
```

Relevant Phase 4 tools:

- `vault_collab_publish_handoff`
- `vault_collab_publish_handoff_with_vault_memory`
- `vault_collab_link_vault_memory`
- `vault_collab_get_handoff`
- `vault_collab_list_events`

Use `vault_collab_publish_handoff` with `vaultMemoryUid` when a Vault memory item
already exists:

```json
{
  "shortPrompt": "Continue Phase 4 Vault link docs.",
  "sourceProject": "Vault Collab",
  "targetProject": "Vault Collab",
  "sourceSessionUid": "vc_session_...",
  "vaultMemoryUid": "vm_..."
}
```

Use `vault_collab_link_vault_memory` when a local handoff already exists:

```json
{
  "handoffUid": "vc_handoff_...",
  "sessionUid": "vc_session_...",
  "sessionToken": "...",
  "vaultMemoryUid": "vm_..."
}
```

Inspect lifecycle history with `vault_collab_list_events`:

```json
{
  "handoffUid": "vc_handoff_..."
}
```

or:

```json
{
  "sessionUid": "vc_session_..."
}
```

## Injected Vault Memory Client

`vault_collab_publish_handoff_with_vault_memory` saves the full brief to Vault
memory first, then publishes the linked local handoff. It requires a
`VaultMemoryClient` supplied by the host:

```typescript
import { createVaultCollabMcpTools } from "./dist/mcp/tools.js";

const tools = createVaultCollabMcpTools({
  dbPath: process.env.VAULT_COLLAB_DB ?? ".vault-collab.db",
  vaultMemoryClient: {
    async saveMemory(input) {
      // Host-specific adapter calls Vault memory here.
      return { itemUid: "vm_..." };
    }
  }
});
```

Without an injected client, this tool returns an explicit configuration error.
That is intentional: the standalone server should not silently reach into an
unconfigured memory backend.

## Safety Rules

- Vault Collab never deletes handoffs, sessions, or events in Phase 4.
- Claiming and lifecycle updates require the claiming session token.
- Manual Vault memory linking requires the source session token.
- Event history is append-only and inspectable through CLI/MCP.
- A short local handoff remains useful even when the full Vault memory brief is
  unavailable.
