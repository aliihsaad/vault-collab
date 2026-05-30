# Cockpit V2 Actionable Dashboard Contract

This contract is for dashboard hosts, including The Vault desktop UI, that render
Vault Collab sessions, handoffs, discussions, and launch requests. The dashboard
may inspect state, but it must not infer authority from visible records alone and
must not spawn provider processes directly.

## Session Roster Semantics

Split sessions into live and closed groups before rendering action affordances.

Live sessions:

- `idle`: live and pingable. It may be offered handoffs, pings, and attention
  watcher prompts.
- `working`: live but busy. Do not ping, interrupt, auto-claim, or show primary
  claim actions.
- `blocked`: live but blocked. Show the blocker detail; ping should stay
  disabled unless the user intentionally changes the session state.
- `awaiting_user`: live but waiting on permission. Show the question/detail and
  do not offer unrelated actions.
- `awaiting_verification`: live but waiting on verification. Show verification
  state separately from active implementation.

Closed sessions:

- `complete`: historical. Hide or collapse by default, do not count as active
  attention, and disable ping with the reason `session is complete`.
- `disconnected`: historical/offline. Hide or collapse by default, do not count
  as active attention, and disable ping with the reason `session is disconnected`.

Heartbeat staleness is display metadata, not a session status. If a live session
has an old `lastHeartbeatAt`, show a stale-heartbeat badge and avoid treating it
as confidently active, but keep the persisted status unchanged until a lifecycle
mutation updates it.

Handoff statuses `resolved`, `abandoned`, and `stale` are closed handoff states,
not session states. Render them in history surfaces, not the live session roster.

## Handoff Actions

Use the owner-token lifecycle mutations for handoff buttons. The dashboard should
call `vault_collab_get_handoff_actions` first with the acting session UID and
owner token, then render only enabled actions.

Action affordance tool:

```json
{
  "tool": "vault_collab_get_handoff_actions",
  "args": {
    "handoffUid": "vc_handoff_...",
    "sessionUid": "vc_sess_...",
    "sessionToken": "<owner-token>"
  }
}
```

The response is token-safe:

```ts
interface HandoffActionSet {
  handoff: HandoffRecord;
  actingSessionUid: string;
  actions: HandoffActionAffordance[];
}

interface HandoffActionAffordance {
  kind:
    | "claim"
    | "update"
    | "request_user_confirmation"
    | "request_handoff_permission"
    | "release"
    | "resolve"
    | "recover"
    | "reopen";
  enabled: boolean;
  reason: string;
  toolName: string;
  requiredCapability: string | null;
  requiresOwnerToken: boolean;
  requiresProgressNote: boolean;
  requiresQuestion: boolean;
  requiresReason: boolean;
  requiresSummary: boolean;
  requiresEvidenceVaultMemoryUid: boolean;
}
```

Action semantics:

- `claim`: enabled only for unclaimed `available` handoffs; calls
  `vault_collab_claim_handoff`.
- `update`: enabled only for the claimed session owner on open handoffs; requires
  a progress note/status; calls `vault_collab_update_handoff`.
- `request_user_confirmation`: enabled only for the claimed session owner on
  open handoffs; requires a question; calls
  `vault_collab_request_user_confirmation`.
- `request_handoff_permission`: enabled only for the claimed session owner on
  open handoffs; requires a question; calls
  `vault_collab_request_handoff_permission`.
- `release`: enabled only for the claimed session owner on open handoffs; calls
  `vault_collab_release_handoff`.
- `resolve`: enabled only for the claimed session owner on open handoffs;
  requires a summary; calls `vault_collab_resolve_handoff`.
- `recover`: enabled only for the source session or a `handoffRecovery`/`admin`
  capable session on open handoffs; requires a reason, summary, and evidence
  Vault memory UID; calls `vault_collab_recover_handoff`.
- `reopen`: enabled for closed handoffs; requires a reason; calls
  `vault_collab_reopen_handoff`.

Each mutation remains audited by a `handoff.*` event. The dashboard must pass the
acting session token only to the selected mutation call; it must not store or
render owner tokens.

## Discussion Actions

Dashboard discussion controls should use the existing discussion lifecycle tools:

- `vault_collab_create_handoff_discussion_thread`
- `vault_collab_add_discussion_message`
- `vault_collab_list_discussion_threads`
- `vault_collab_get_discussion_thread`

Discussion messages are attention events for relevant sessions, but passive
thread records are not enough for an operational dashboard. The UI should surface
new discussion messages as actionable attention and provide compose/reply
controls directly in the handoff inspector.

## Launch Request Actions

Use the existing owner-token lifecycle mutations for buttons. The dashboard
should call `vault_collab_get_launch_request_actions` first with the acting
session UID and owner token, then render only enabled actions.

Action affordance tool:

```json
{
  "tool": "vault_collab_get_launch_request_actions",
  "args": {
    "launchRequestUid": "vc_launch_...",
    "sessionUid": "vc_sess_...",
    "sessionToken": "<owner-token>"
  }
}
```

The response is token-safe:

```ts
interface LaunchRequestActionSet {
  launchRequest: LaunchRequestRecord;
  actingSessionUid: string;
  actions: LaunchRequestActionAffordance[];
}

interface LaunchRequestActionAffordance {
  kind:
    | "approve"
    | "reject"
    | "cancel"
    | "mark_launching"
    | "mark_running"
    | "fail";
  enabled: boolean;
  reason: string;
  toolName: string;
  requiredCapability: string | null;
  requiresOwnerToken: true;
  requiresReason: boolean;
  requiresLaunchedSessionUid: boolean;
}
```

Action semantics:

- `approve`: enabled only when status is `requested` and the actor has
  `launchApproval`; calls `vault_collab_approve_launch_request`.
- `reject`: enabled only when status is `requested` and the actor has
  `launchApproval`; requires a reason; calls
  `vault_collab_reject_launch_request`.
- `cancel`: enabled while status is `requested` or `approved` when the actor is
  the requester or has `launchApproval`; requires a reason; calls
  `vault_collab_cancel_launch_request`.
- `mark_launching`: enabled only when status is `approved` and the actor has
  `launchBroker`; calls `vault_collab_mark_launch_request_launching`.
- `mark_running`: enabled only when status is `launching`, the actor has
  `launchBroker`, and the actor is the same broker that marked the request
  launching; requires a `launchedSessionUid`; calls
  `vault_collab_mark_launch_request_running`.
- `fail`: enabled when status is `approved`, `launching`, or `running`, the
  actor has `launchBroker`, and any existing broker matches the actor; requires
  a reason; calls `vault_collab_fail_launch_request`.

Each mutation remains owner-token checked and audited by a
`launch_request.*` event. The dashboard must pass the acting session token only
to the selected mutation call; it must not store or render owner tokens.

## No Direct Spawn

`mark_launching` and `mark_running` are broker lifecycle records only. A
dashboard button must never start Codex, Claude, or another provider process
directly. A separate local broker may start/register an agent through its own
operator-approved process, then attach that already registered session with
`mark_running`.
