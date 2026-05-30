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
- Soft session pings and explicit permission-needed events for dashboard
  attention indicators.
- Durable launch requests that record spawn intent, approvals, broker pickup,
  registered launched sessions, and failure/cancel states without directly
  spawning a process.
- Durable provider-neutral agent profiles with advisory role metadata.
- Optional session binding to an agent profile.
- Labeled and ordered handoff queues through `queueKey`, `labels`,
  `queuePosition`, and `dependsOnHandoffUid`.
- Append-only discussion threads and messages tied to projects or handoffs.
- Deterministic project-key matching so clients using labels such as
  `Vault Collab`, `vault-collab`, or `vault_collab` still see the same
  sessions, handoffs, profiles, and discussions.

The current scope intentionally does not include:

- Vault Desktop UI.
- Graphify enrichment.
- Octogent bridge automation.
- Auto-execution of work.
- Direct dashboard or MCP process spawning.
- Auto-claiming or interruption of active sessions.
- Delete or clean commands.
- Hard-coded manager/worker/inspector client classes.
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

## Install For Normal Users

No source checkout is required. This command installs Vault Collab from GitHub
through npm's exec cache, opens or creates the local SQLite database, and prints
a JSON health check. It does not start background work or run hidden agents.

Windows PowerShell:

```powershell
$db = Join-Path $env:LOCALAPPDATA "TheVault\vault-collab.db"; New-Item -ItemType Directory -Force -Path (Split-Path $db) | Out-Null; npm exec --yes --package github:aliihsaad/vault-collab -- vault-collab check --db $db
```

The `$db` value is built from the current user's `LOCALAPPDATA`, so the actual
path varies per machine. The npm separator belongs before the executable name:
`npm exec --yes --package github:aliihsaad/vault-collab -- vault-collab ...`.

The MCP server can be started from GitHub with the same database path:

```powershell
$db = Join-Path $env:LOCALAPPDATA "TheVault\vault-collab.db"; New-Item -ItemType Directory -Force -Path (Split-Path $db) | Out-Null; npm exec --yes --package github:aliihsaad/vault-collab -- vault-collab-mcp --db $db
```

## Development From A Local Checkout

Local source checkout mode is for development. Normal users should use the
GitHub npm exec command above.

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

## Developer CLI Quickstart

The examples assume PowerShell from the repository root. Set paths from the
current checkout so they work for any user:

```powershell
$workspace = (Get-Location).Path
$db = Join-Path $workspace ".vault-collab.db"
```

Read the provider-neutral agent guide first. It is the same loop exposed through
the MCP `vault_collab_get_agent_guide` tool, so any agent can learn the workflow
without Codex-specific memory:

```powershell
node dist\cli.js guide --client-type codex --project "Vault Collab"
```

The guide tells agents to register, immediately check the attention feed, inspect
handoff detail before acting, claim only when idle and ready, keep state current,
use handoff-linked discussions for coordination, and recheck attention before
reporting that no work is available. It also returns a `projectKey` field; use
that key as the stable routing identity when different clients format a project
label differently.

Register a session:

```powershell
node dist\cli.js register --db $db --display-name "Codex" --client-type codex --project "Vault Collab" --workspace-path $workspace --capability handoffs=true
```

The response includes a `sessionUid`, `sessionToken`, and `nextActions`. Keep the
token private. Listing commands do not expose session tokens. The first
`nextActions` entry points back to the attention feed so agents do not need
Codex-specific memory to know the next step.

After registering, active agents should immediately read their session attention
feed before reporting that no work is available:

```powershell
node dist\cli.js attention --db $db --session-uid vc_sess_...
```

This one-shot check is the active-session discovery surface. It includes pings,
suggested handoffs, claimed handoffs, discussion messages, permission requests,
and available project handoffs. `inbox` remains useful for queue inspection, but
it is only a project snapshot and does not replace the attention feed for a
registered session. Prefer repeated one-shot attention checks at startup and
idle boundaries over long-running waits; this matches AI clients' command/result
execution model and avoids backgrounded competing consumers.

Project filters use deterministic project keys. A session registered under
`vault-collab` can still see a handoff targeted at `Vault Collab`; exact display
casing is preserved in records, but routing is by key.

Create a launch request:

```powershell
node dist\cli.js launch-create --db $db --session-uid vc_sess_... --session-token ... --provider codex --model gpt-5-codex --effort-level high --project "Vault Collab" --workspace-path $workspace --role implementer --initial-instructions "Implement the approved broker slice." --permission-mode workspace-write
```

Launch requests are durable operator intent records. Creating one does not start
a terminal, spawn an agent, or bypass approvals. A session with
`launchApproval=true` can approve or reject a requested launch:

```powershell
node dist\cli.js launch-approve --db $db --launch-request-uid vc_launch_... --session-uid vc_sess_... --session-token ... --detail "Approved for local broker pickup."
node dist\cli.js launch-reject --db $db --launch-request-uid vc_launch_... --session-uid vc_sess_... --session-token ... --reason "Needs a tighter brief."
```

A separate local broker session with `launchBroker=true` can mark an approved
request as launching and later attach an already registered launched session:

```powershell
node dist\cli.js launch-mark-launching --db $db --launch-request-uid vc_launch_... --session-uid vc_sess_... --session-token ... --detail "Broker accepted request."
node dist\cli.js launch-mark-running --db $db --launch-request-uid vc_launch_... --session-uid vc_sess_... --session-token ... --launched-session-uid vc_sess_... --detail "Launched session registered."
```

Inspect launch requests:

```powershell
node dist\cli.js launches --db $db --project "Vault Collab"
node dist\cli.js launch --db $db --launch-request-uid vc_launch_...
node dist\cli.js launch-actions --db $db --launch-request-uid vc_launch_... --session-uid vc_sess_... --session-token ...
```

Inspect token-safe handoff action affordances before rendering dashboard
lifecycle buttons:

```powershell
node dist\cli.js handoff-actions --db $db --handoff-uid vc_handoff_... --session-uid vc_sess_... --session-token ...
```

Dashboard consumption contract:

- Launch request records are token-safe for read-only dashboards. They do not
  contain session owner tokens or process handles.
- Read-only dashboards may query `launch_requests` directly when the table
  exists. Keep the query optional so old databases still render.
- `requested`, `approved`, `launching`, and `running` are current dashboard
  states. `running` should appear in record lists, not as a persistent current
  attention item; `launch_request.running` may still appear as a lifecycle event
  for cursor-based attention consumers.
- A compact dashboard DTO may be added later if another host should consume
  launch requests without SQLite schema coupling, but it is not required for the
  first The Vault read-only dashboard cards.
- No additional action-state event is required before read-only cards. Future
  actions must go through owner-token-aware approval/cancel paths and
  handoff lifecycle methods or `launchBroker`-gated broker transitions. The
  dashboard must not directly spawn processes from a launch request.
- See [`docs/cockpit-v2-actionable-dashboard-contract.md`](docs/cockpit-v2-actionable-dashboard-contract.md)
  for live-vs-closed session roster semantics and the owner-token-aware
  `actions` affordance contract for dashboard buttons.

Create a durable agent profile and bind a provider session to it:

```powershell
node dist\cli.js agent-upsert --db $db --stable-name "claude-reviewer" --display-name "Claude Reviewer" --role reviewer --client-type claude-code --project "Vault Collab"

node dist\cli.js register --db $db --display-name "Claude Code" --client-type claude-code --project "Vault Collab" --workspace-path $workspace --agent-uid vc_agent_...
```

Roles are advisory metadata. Built-in role labels are `coordinator`,
`implementer`, `reviewer`, `sweeper`, and `observer`; custom role strings are
accepted by the profile service.

Publish a handoff:

```powershell
node dist\cli.js publish --db $db --short-prompt "Continue the Vault Collab implementation." --source-project "Vault Collab" --target-project "Vault Collab" --source-session-uid vc_sess_...
```

Publish into an ordered queue with labels:

```powershell
node dist\cli.js publish --db $db --short-prompt "Review the MCP contract." --source-project "Vault Collab" --target-project "Vault Collab" --source-session-uid vc_sess_... --queue-key phase-1 --queue-position 500 --label mcp --label review
```

List the target inbox:

```powershell
node dist\cli.js inbox --db $db --target-project "Vault Collab"
```

Claim a handoff:

```powershell
node dist\cli.js claim --db $db --handoff-uid vc_handoff_... --session-uid vc_sess_... --session-token ...
```

Update and resolve:

```powershell
# `update` is for progress states only: in_progress, blocked, awaiting_user,
# or verification_needed. Use lifecycle commands for claim/release/resolve/recover/reopen.
node dist\cli.js update --db $db --handoff-uid vc_handoff_... --session-uid vc_sess_... --session-token ... --status in_progress --progress-note "Implementation in progress."

node dist\cli.js resolve --db $db --handoff-uid vc_handoff_... --session-uid vc_sess_... --session-token ... --summary "Completed and verified."
```

Recover a completed handoff when the claimed owner token is no longer available:

```powershell
node dist\cli.js recover --db $db --handoff-uid vc_handoff_... --actor-session-uid vc_sess_... --actor-session-token ... --reason "Claim owner token was lost after restart." --summary "Completion report accepted." --evidence-vault-memory-uid vm_...
```

Recovery resolution is audited separately from normal owner resolution. The actor
must be the source session owner or a session registered with a recovery/admin
capability such as `handoffRecovery=true`, and the event history records the
previous claim owner, previous status, reason, summary, and evidence memory UID
without exposing tokens.

Ping a session and record permission-needed attention states:

```powershell
node dist\cli.js ping-session --db $db --target-session-uid vc_sess_... --actor-session-uid vc_sess_... --message "Please check the inbox when active."

node dist\cli.js session-permission-request --db $db --session-uid vc_sess_... --session-token ... --question "Allow network access for git push?" --requested-capability network --command-preview "git push origin main" --source codex

node dist\cli.js handoff-permission-request --db $db --handoff-uid vc_handoff_... --session-uid vc_sess_... --session-token ... --question "Allow filesystem write?" --requested-capability filesystem-write --command-preview "npm run build" --source claude-code
```

`ping-session` records a `session.pinged` event only, and only when the target
session is currently `idle`. This prevents pings from interrupting a working,
blocked, or awaiting-user session. It does not wake a stopped process, claim
work, or execute anything. Permission-request commands move the session or
handoff to `awaiting_user`, store the question in the public detail field, and
emit token-safe `session.permission_requested` or
`handoff.permission_requested` events. Agents should record these events before
triggering a human approval prompt when practical, then update state after the
approval or denial.

Read an active session's attention feed:

```powershell
node dist\cli.js attention --db $db --session-uid vc_sess_...

node dist\cli.js attention --db $db --session-uid vc_sess_... --since-event-id 42 --no-current-handoffs

node dist\cli.js watch-attention --db $db --session-uid vc_sess_... --interval-ms 2000 --timeout-ms 30000
```

The feed is token-safe and does not mutate state. It aggregates pings,
permission-needed events, discussion messages on relevant handoffs, claimed
handoffs, suggested handoffs, and available project handoffs. `watch-attention`
is a bounded local helper loop over the same feed. It returns when attention
items appear or the timeout expires, then prints manual `recommendedActions`
such as inspecting detail or running `claim` with the caller's owner token. It
does not mutate state, auto-claim, wake a stopped client, or execute commands.
`ping-session` is therefore still only a passive event unless the target agent
checks `attention` or has `watch-attention` running.

Inspect event history:

```powershell
node dist\cli.js handoff --db $db --handoff-uid vc_handoff_...
node dist\cli.js events --db $db --handoff-uid vc_handoff_...
node dist\cli.js events --db $db --session-uid vc_sess_...
node dist\cli.js events --db $db --session-uid vc_sess_... --event-type session.permission_requested
```

Create and inspect an append-only discussion:

```powershell
# Prefer the MCP `vault_collab_create_handoff_discussion_thread` tool for
# handoff-linked discussions; it derives the project from the handoff so
# `vault_collab_get_handoff_detail` includes the thread.
node dist\cli.js discussion-create --db $db --project "Vault Collab" --handoff-uid vc_handoff_... --title "Review concerns" --session-uid vc_sess_... --session-token ...

node dist\cli.js discussion-add-message --db $db --thread-uid vc_thread_... --session-uid vc_sess_... --session-token ... --type proposal --body "Keep this provider-neutral."

node dist\cli.js discussion --db $db --thread-uid vc_thread_...
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

- `vault_collab_get_agent_guide`
- `vault_collab_register_session`
- `vault_collab_heartbeat_session`
- `vault_collab_update_session_state`
- `vault_collab_ping_session`
- `vault_collab_request_session_permission`
- `vault_collab_list_sessions`
- `vault_collab_get_session_attention`
- `vault_collab_disconnect_session`
- `vault_collab_create_launch_request`
- `vault_collab_list_launch_requests`
- `vault_collab_get_launch_request`
- `vault_collab_get_launch_request_detail`
- `vault_collab_get_launch_request_actions`
- `vault_collab_approve_launch_request`
- `vault_collab_reject_launch_request`
- `vault_collab_cancel_launch_request`
- `vault_collab_mark_launch_request_launching`
- `vault_collab_mark_launch_request_running`
- `vault_collab_fail_launch_request`
- `vault_collab_list_agent_roles`
- `vault_collab_upsert_agent_profile`
- `vault_collab_list_agent_profiles`
- `vault_collab_publish_handoff`
- `vault_collab_publish_handoff_with_vault_memory`
- `vault_collab_link_vault_memory`
- `vault_collab_list_inbox`
- `vault_collab_get_handoff`
- `vault_collab_get_handoff_detail`
- `vault_collab_get_handoff_actions`
- `vault_collab_update_handoff_metadata`
- `vault_collab_create_discussion_thread`
- `vault_collab_create_handoff_discussion_thread`
- `vault_collab_add_discussion_message`
- `vault_collab_list_discussion_threads`
- `vault_collab_get_discussion_thread`
- `vault_collab_list_events`
- `vault_collab_claim_handoff`
- `vault_collab_update_handoff`
- `vault_collab_request_user_confirmation`
- `vault_collab_request_handoff_permission`
- `vault_collab_resolve_handoff`
- `vault_collab_recover_handoff`
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
`VaultMemoryClient` is injected, the standalone MCP server does not advertise
`vault_collab_publish_handoff_with_vault_memory`. If a stale client still calls
the tool by name, it returns an explicit fallback instruction: save the full
brief with Vault MCP `vault_save_memory`, then call
`vault_collab_publish_handoff` with the returned `vaultMemoryUid`.

See [`docs/phase-4-vault-link.md`](docs/phase-4-vault-link.md) for detailed
Phase 4 usage.

## Architecture

```text
src/
  cli.ts                    JSON CLI surface
  database/
    connection.ts           SQLite connection setup
    schema.ts               sessions, agents, handoffs, discussions, events schema
  mcp/
    server.ts               MCP stdio server
    tools.ts                neutral vault_collab_* tool registry
  services/
    agent-profile.service.ts durable agent identities and role metadata
    discussion.service.ts    append-only discussion threads and messages
    event.service.ts        append-only event recording and listing
    handoff-detail.service.ts selected handoff detail bundle
    handoff.service.ts      handoff lifecycle and token ownership
    launch-request.service.ts launch request approval and broker state machine
    session.service.ts      session lifecycle and owner tokens
    vault-link.service.ts   optional Vault memory linked publishing
  types.ts                  shared public types
tests/
  *.test.ts                 Vitest coverage for services, CLI, MCP, Vault links
docs/
  phase-4-vault-link.md     linked handoff usage guide
  cockpit-v2-actionable-dashboard-contract.md dashboard roster/action contract
  v1-plan.md                current scope and deferred areas
```

## Design Principles

- Local-first: SQLite state stays on the user's machine.
- Inspectable: sessions, handoffs, launch requests, and events are readable
  through CLI/MCP.
- Provider-neutral: clients identify by capability and client type, not fixed
  roles.
- Token-owned mutations: sensitive lifecycle updates require the owning session
  token.
- Audited recovery: source sessions or recovery-capable sessions can close
  stranded completed handoffs with required reason, summary, and Vault memory
  evidence, producing `handoff.recovery_resolved` events.
- Roles are metadata: roles help routing and UI display, but do not create
  provider-specific client classes.
- Discussions are append-only: messages are added for auditability rather than
  edited in place.
- Non-destructive by default: no delete/clean command exists in the current
  scope.
- No hidden automation: Vault Collab coordinates work but does not execute,
  auto-claim, or interrupt active sessions.
- Broker split: launch requests record intent and approval; only a separate
  launchBroker-capable local broker can mark pickup/running, and this package
  still does not spawn processes directly.

## Documentation

- [`docs/v1-plan.md`](docs/v1-plan.md)
- [`docs/phase-4-vault-link.md`](docs/phase-4-vault-link.md)

## License

MIT. See [`LICENSE`](LICENSE).
