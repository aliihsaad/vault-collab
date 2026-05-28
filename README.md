# Vault Collab

Vault Collab is a local-first collaboration extension for The Vault. It lets
Codex, Claude Code, Claude Desktop, Octogent, Gemini, OpenCode, and future MCP
clients coordinate through shared sessions, handoff inboxes, owner-token checks,
and inspectable SQLite state.

The current package runs as a standalone TypeScript/SQLite core with CLI and MCP
surfaces. It is designed to become the collaboration layer that Vault can expose
to multiple AI clients without making any one provider special.

## Status

Vault Collab is an early standalone core. The current implementation covers:

- TypeScript, Vitest, and SQLite scaffold.
- Provider-neutral session registration, heartbeat, state update, disconnect,
  and listing.
- Handoff publish, inbox listing, atomic claim, progress update, user
  confirmation request, release, resolve, and reopen.
- JSON CLI workflows for local smoke usage.
- MCP stdio server exposing neutral `vault_collab_*` tools.
- Optional Vault memory links for full handoff briefs.
- Read-only event history for session and handoff lifecycle inspection.

The current scope intentionally does not include:

- Vault Desktop UI.
- Graphify enrichment.
- Octogent bridge automation.
- Auto-execution of work.
- Delete or clean commands.
- Fixed manager/worker/inspector roles.
- Automatic mutation of `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Codex skills, or
  agent configuration files.

## Why This Exists

Most AI coding clients can run tools, but they do not have a shared local
coordination surface. Vault Collab provides that surface without making one
provider special:

- A session records who is present, what project they are in, and their current
  state.
- A handoff records work that another session can inspect, claim, update, and
  resolve.
- A Vault memory link can point a short local handoff to a durable full brief.
- An event log makes lifecycle history inspectable without deleting or hiding
  prior state.

The design is deliberately conservative: no hidden consumers, no silent file
mutation, no background auto-execution, and no destructive cleanup path.

## Requirements

- Node.js 24 or newer.
- npm.
- A local filesystem path for the SQLite database.

## Install

```powershell
npm install
npm run build
```

## Verify

```powershell
npm run test:run
npm run build
npm run typecheck
```

## CLI Quickstart

The examples assume PowerShell from the repository root. Set paths from the
current checkout so they work for any user:

```powershell
$workspace = (Get-Location).Path
$db = Join-Path $workspace ".vault-collab.db"
```

Register a session:

```powershell
node dist\cli.js register --db $db --display-name "Codex" --client-type codex --project "Vault Collab" --workspace-path $workspace --capability handoffs=true
```

The response includes a `sessionUid` and `sessionToken`. Keep the token private.
Listing commands do not expose session tokens.

Publish a handoff:

```powershell
node dist\cli.js publish --db $db --short-prompt "Continue the Vault Collab implementation." --source-project "Vault Collab" --target-project "Vault Collab" --source-session-uid vc_session_...
```

List the target inbox:

```powershell
node dist\cli.js inbox --db $db --target-project "Vault Collab"
```

Claim a handoff:

```powershell
node dist\cli.js claim --db $db --handoff-uid vc_handoff_... --session-uid vc_session_... --session-token ...
```

Update and resolve:

```powershell
node dist\cli.js update --db $db --handoff-uid vc_handoff_... --session-uid vc_session_... --session-token ... --status in_progress --progress-note "Implementation in progress."

node dist\cli.js resolve --db $db --handoff-uid vc_handoff_... --session-uid vc_session_... --session-token ... --summary "Completed and verified."
```

Inspect event history:

```powershell
node dist\cli.js events --db $db --handoff-uid vc_handoff_...
node dist\cli.js events --db $db --session-uid vc_session_...
```

## MCP Stdio Server

Build first:

```powershell
npm run build
```

Start the server with a database path:

```powershell
$db = Join-Path (Get-Location).Path ".vault-collab.db"
node dist\mcp\server.js --db $db
```

Or use an environment variable:

```powershell
$env:VAULT_COLLAB_DB = (Join-Path (Get-Location).Path ".vault-collab.db")
node dist\mcp\server.js
```

Available MCP tools include:

- `vault_collab_register_session`
- `vault_collab_heartbeat_session`
- `vault_collab_update_session_state`
- `vault_collab_list_sessions`
- `vault_collab_disconnect_session`
- `vault_collab_publish_handoff`
- `vault_collab_publish_handoff_with_vault_memory`
- `vault_collab_link_vault_memory`
- `vault_collab_list_inbox`
- `vault_collab_get_handoff`
- `vault_collab_list_events`
- `vault_collab_claim_handoff`
- `vault_collab_update_handoff`
- `vault_collab_request_user_confirmation`
- `vault_collab_resolve_handoff`
- `vault_collab_reopen_handoff`
- `vault_collab_release_handoff`

## Vault Memory Links

Vault Collab stores a short local handoff in SQLite. A full brief can live in
Vault memory and be referenced by `vaultMemoryUid`.

Supported link paths:

- Publish a handoff with an existing `vaultMemoryUid`.
- Link an existing handoff later as the source session owner.
- Use an injected `VaultMemoryClient` when embedding the MCP tools
  programmatically.

The standalone stdio server does not silently call Vault MCP. If no
`VaultMemoryClient` is injected, `vault_collab_publish_handoff_with_vault_memory`
returns an explicit configuration error.

See [`docs/phase-4-vault-link.md`](docs/phase-4-vault-link.md) for detailed
Phase 4 usage.

## Architecture

```text
src/
  cli.ts                    JSON CLI surface
  database/
    connection.ts           SQLite connection setup
    schema.ts               sessions, handoffs, events schema
  mcp/
    server.ts               MCP stdio server
    tools.ts                neutral vault_collab_* tool registry
  services/
    event.service.ts        append-only event recording and listing
    handoff.service.ts      handoff lifecycle and token ownership
    session.service.ts      session lifecycle and owner tokens
    vault-link.service.ts   optional Vault memory linked publishing
  types.ts                  shared public types
tests/
  *.test.ts                 Vitest coverage for services, CLI, MCP, Vault links
docs/
  phase-4-vault-link.md     linked handoff usage guide
  v1-plan.md                current scope and deferred areas
```

## Design Principles

- Local-first: SQLite state stays on the user's machine.
- Inspectable: sessions, handoffs, and events are readable through CLI/MCP.
- Provider-neutral: clients identify by capability and client type, not fixed
  roles.
- Token-owned mutations: sensitive lifecycle updates require the owning session
  token.
- Non-destructive by default: no delete/clean command exists in the current
  scope.
- No hidden automation: Vault Collab coordinates work but does not execute it.

## Documentation

- [`docs/v1-plan.md`](docs/v1-plan.md)
- [`docs/phase-4-vault-link.md`](docs/phase-4-vault-link.md)

## License

No license has been selected yet. Until one is added, all rights are reserved by
the repository owner.
