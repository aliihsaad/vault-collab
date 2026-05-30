# PTY / Process Ownership Gate

## Decision

Do not put terminal/process input injection inside the generic Vault Collab MCP
server or CLI package first.

The first real managed-process adapter should be owned by The Vault desktop
runtime, because The Vault is already an Electron app with a privileged main
process, preload IPC, runtime configuration, and dashboard action plumbing. Vault
Collab should remain the durable coordination and acknowledgement layer:

- session registration and delivery metadata;
- attention feed and acknowledgement cursor;
- delivery attempt persistence;
- token-safe CLI/MCP read and mutation APIs;
- receiver service logic that can be called by a trusted adapter.

The Vault should own:

- launching Codex/Claude/provider CLI processes;
- PTY lifecycle;
- terminal output buffering;
- renderer terminal UI;
- safe input injection into only processes it launched and tracks;
- stop/kill semantics for only owned processes.

## Coordinator / Worker Model

The user-opened terminal agent is the coordinator. It joins Vault Collab manually
and does not need forced wake delivery. Claude coordinators join with
`/vault-collab`; Codex coordinators join by prompting `use vault collab`.

Dashboard-launched agents are workers. They must be launched and owned by The
Vault when the product promises automatic ping or attention delivery.

Cross-project workers are valid as long as they share the same Vault Collab
database. Routing should use `relatedProjects`, `sourceProject`,
`targetProject`, `suggestedSessionUid`, discussions, and pings rather than
assuming a single current repository.

## Why

Vault Collab currently has no process runtime. It is a local-first coordination
package and MCP server. Adding native PTY dependencies and process-control
semantics there would blur ownership and make it too easy to imply control over
manual external sessions.

The Octogent local repo shows the pattern to borrow: a runtime owns live
`node-pty` sessions, queues channel messages by target terminal id, writes
pending messages into the PTY with `writeInput`, and retries delivery when idle
or stop hooks prove the target is safe to prompt. The durable database event is
not the wake mechanism. Automatic delivery is only real when an attached host
process owns the target terminal and can acknowledge the attention cursor after
a successful write.

The Vault already has an Electron main process using `child_process.spawn` for
managed local tasks and a preload bridge for renderer actions. Its Vault Collab
dashboard already registers a dashboard session with `sessionAdmin=true`, calls
Vault Collab CLI actions, and stores runtime config. That is the right boundary
for a local process broker.

## Sources Checked

- `microsoft/node-pty` describes itself as Node pseudoterminal bindings that
  return a terminal object supporting reads and writes. It supports Windows via
  ConPTY on Windows 10 version 1809 or later, exposes `ptyProcess.write(...)`,
  and warns that child processes run at the same permission level as the parent.
  Source: <https://github.com/microsoft/node-pty>
- Microsoft's ConPTY overview shows the underlying model: callers create a
  pseudoconsole with input/output pipes, write input through the input handle,
  read output through the output handle, resize the console, and closing the
  ConPTY terminates attached clients.
  Source: <https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/>
- xterm.js terminal docs describe frontend terminal input events such as
  `onData`, where typed/pasted data should be passed to the backing PTY, and
  binary data can be forwarded via `pty.write(Buffer.from(data, 'binary'))`.
  Source: <https://xtermjs.org/docs/api/terminal/classes/terminal/>

## Local Repo Findings

The Vault relevant files:

- `packages/desktop/electron/main.ts`
  - Electron main process already imports `spawn` from `node:child_process`.
  - Runtime actions run hidden processes with `windowsHide: true`.
  - Vault Collab runtime config and dashboard actor are managed in main.
- `packages/desktop/electron/preload.ts`
  - Renderer accesses Vault Collab actions through IPC methods such as
    `performVaultCollabDashboardAction`.
- `packages/core/src/services/vault-collab-actions.service.ts`
  - Builds and executes Vault Collab CLI invocations.
  - Redacts `--session-token` and `--actor-session-token`.
  - Dashboard registration already grants `sessionAdmin=true`.
- `packages/core/src/types/vault-collab.ts`
  - Already has delivery state types and session dashboard action types.

Vault Collab relevant files:

- `src/services/attention-receiver.service.ts`
  - Provides the receiver/adapter abstraction and acknowledgement behavior.
- `src/database/schema.ts`
  - Persists `attention_delivery_attempts`.
- `src/cli.ts`
  - Provides `receive-attention` with a stdout adapter and
    `delivery-attempts`.
- `src/mcp/tools.ts`
  - Provides `vault_collab_list_attention_delivery_attempts`.

## Required Adapter Contract

The Vault desktop adapter should satisfy:

```ts
interface ManagedTerminalAdapter {
  adapterName: 'the-vault-electron-pty';
  canDeliver(sessionUid: string): boolean;
  deliver(input: {
    sessionUid: string;
    toEventId: number;
    message: string;
  }): Promise<{
    delivered: boolean;
    reason: string | null;
  }>;
}
```

Delivery is valid only when:

- The Vault launched the target process.
- The launched process registered a Vault Collab session with
  `delivery.mode = "managed_process"` and `delivery.wakeable = true`.
- The Vault has retained the session token privately in main process memory or
  encrypted local storage.
- The adapter can map `sessionUid` to an owned PTY process.
- The adapter writes to the PTY input channel successfully.
- The receiver then acknowledges `latestEventId`.

## Implementation Plan

### Phase 1: The Vault Managed Terminal Runtime

In `the-vault`, add an Electron-main runtime service:

- owns PTY processes;
- launches provider commands from approved launch requests;
- records process id, provider, workspace path, launch request UID, session UID,
  delivery mode, and lifecycle state;
- exposes renderer IPC for terminal output/input/resize/close;
- never exposes session tokens to renderer state.

Candidate dependency: `node-pty`.

Reason: it is the standard Node/Electron PTY abstraction, supports Windows via
ConPTY, and has explicit read/write APIs. Packaging/native-build work must be
handled in The Vault desktop build, not Vault Collab's generic CLI package.

### Phase 2: Launch Request Integration

Use existing Vault Collab launch request flow:

1. Dashboard/operator creates or approves a launch request.
2. The Vault broker marks it `launching`.
3. The Vault starts the PTY process.
4. The launched process registers a session with:
   - `deliveryMode: "managed_process"`
   - `deliveryWakeable: true`
   - capability `launchedBy=<launchRequestUid>`
5. The Vault marks launch request `running` with `launchedSessionUid`.

If the child process cannot self-register, The Vault may register on its behalf
only when it controls the process command and stores the returned owner token in
main process memory/encrypted storage.

### Phase 3: Attention Receiver Loop In The Vault

For each owned managed session:

1. Poll `vault-collab attention` or call the MCP equivalent by cursor.
2. Compose or reuse the Vault Collab receiver batch message.
3. Write the message to the owned PTY input only when idle-safe.
4. Call `attention-ack` / `vault_collab_acknowledge_attention`.
5. Persist delivered/failed attempts through Vault Collab.
6. Surface attempts in dashboard using `delivery-attempts` or
   `vault_collab_list_attention_delivery_attempts`.

### Phase 4: Idle-Safety

Start conservative:

- deliver only to sessions whose Vault Collab status is `idle`;
- do not inject into `working`, `blocked`, `awaiting_user`, or
  `awaiting_verification`;
- do not auto-claim handoffs;
- deliver a short attention summary, not arbitrary commands;
- if idle state is ambiguous, record failed attempt with reason
  `target session not idle-safe`.

Later, The Vault can improve idle detection using terminal output markers and
provider-specific prompt patterns, but that should be provider-adapter code.

## Non-Goals

- Do not inject into manual external terminals.
- Do not treat stale heartbeat as process ownership.
- Do not expose owner tokens to renderer UI.
- Do not implement kill/stop for sessions The Vault did not launch.
- Do not make Vault Collab depend on `node-pty` until there is a reason for a
  standalone broker package.

## Next Concrete Work

The next implementation should happen in `the-vault`, not this package:

1. Add types for managed terminal sessions and delivery attempts in
   `packages/core/src/types/vault-collab.ts`.
2. Add action builders for:
   - `delivery-attempts`
   - `session-rename`
   - `session-close`
3. Add dashboard UI for roster rename/close and delivery-attempt history.
4. Add a separate plan for Electron PTY runtime using `node-pty`; do not install
   the native dependency until the dashboard action wiring is verified.
