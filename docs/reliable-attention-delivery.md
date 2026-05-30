# Reliable Attention Delivery

## Problem

Vault Collab currently persists attention events correctly, but it does not
guarantee that the target agent notices them. A `session.pinged` event is written
to the database and appears in `vault_collab_get_session_attention`, yet an
external Codex session will not react unless a new user turn or a watcher process
causes that session to poll attention.

This is a delivery-loop gap, not a ping-storage bug.

## Current Data Path

1. `vault_collab_ping_session` records `session.pinged`.
2. `vault_collab_get_session_attention` maps that event to `session_ping`.
3. `watch-attention` can poll and print recommended manual actions.
4. No package or dashboard process injects that notice into an already waiting
   Codex session.

The same distinction applies to discussion messages, permission events, and
targeted handoffs: they are durable and queryable, but not automatically
delivered to a passive external client.

## Delivery Classes

Vault Collab should represent delivery explicitly instead of implying every live
session is equally reachable.

- `manual_poll`: the session only sees attention when the agent is prompted and
  calls `vault_collab_get_session_attention`.
- `local_watch`: an operator or shell process is running `watch-attention`; it
  can notify a human or print commands, but it cannot wake the agent by itself.
- `mcp_notification`: the MCP server can send protocol notifications to its
  connected client. This is advisory because host support determines whether the
  user or model sees the notification.
- `managed_process`: Vault Collab or The Vault launched and owns the process
  channel. This is the first class that can make a reliable wake/receive
  guarantee, because the broker can deliver an input or control signal through a
  known adapter.

External sessions registered by a manually started Codex CLI should default to
`manual_poll` unless they explicitly register a verified receiver capability.

## Required Product Behavior

Dashboard and MCP responses should distinguish stored attention from delivered
attention:

- Ping button copy must not imply wake-up for `manual_poll` sessions.
- Session rows should expose delivery class and last attention acknowledgement.
- Targeted handoffs claimed by another session should be surfaced as a distinct
  attention state rather than still looking like ordinary suggested work.
- When a ping is sent to a session without a receiver, the result should include
  a clear next step: start a watcher, use a managed session, or manually prompt
  the target session.

`vault_collab_ping_session` and the CLI `ping-session` command now return a
token-safe delivery envelope: the stored event, the target session snapshot, and
`delivery.mode`, `delivery.wakeable`, `delivery.delivered`, and
`delivery.nextStep`. `delivered` remains `false` at ping time; a receiver must
observe and acknowledge the attention event before the system can report it as
seen.

## Correct Fix Direction

The durable fix belongs under Vault Collab as a receiver/broker capability:

1. Add receiver metadata to registered sessions.
2. Add a delivery status surface that reports whether a session has a verified
   receiver loop.
3. Add a managed receiver adapter for sessions that Vault Collab or The Vault
   launches and owns.
4. Keep external/manual sessions honest: pings are stored and visible, but not
   guaranteed to wake the agent.

MCP notifications can be an adapter, but not the only fix. MCP hosts decide how
notifications, logging, elicitation, and sampling are surfaced, so Vault Collab
must treat notification delivery as a capability to verify, not an assumption.

## Reference: Octogent Channel Delivery

Octogent has a useful managed-process pattern in
`C:/Users/Mini/Desktop/cloned-repos/octogent`:

- The API owns PTY-backed terminal sessions.
- Channel messages are queued per target terminal.
- Delivery is attempted immediately when the target session is already idle.
- Claude hook events and idle/stop transitions trigger another delivery attempt.
- Pending messages are composed into one prompt and written directly to the
  target PTY input.

The important lesson is the ownership boundary. Octogent can deliver because it
owns the runtime process and can write to its PTY. That maps to Vault Collab's
`managed_process` delivery class. It should not be applied to manually
registered external sessions unless Vault Collab has a verified input channel.

The pieces worth borrowing are:

1. Queue attention messages per target session.
2. Gate delivery on known idle state.
3. Compose pending messages into one injected prompt.
4. Mark messages delivered only after writing to the owned input channel.
5. Trigger delivery both on send and on idle/stop events.

Vault Collab should improve on Octogent by persisting delivery state and
acknowledgements, because Vault Collab's handoffs and attention events are
durable while Octogent channel queues are intentionally in-memory.

## Non-Goals

- Do not auto-claim handoffs.
- Do not execute arbitrary commands from ping or discussion text.
- Do not pretend a database event can wake a disconnected or unmanaged process.
- Do not route work into another active session without explicit ownership and
  permission semantics.

## Verification Plan

Reliable delivery is only proven when tests exercise the whole path:

1. A ping is written.
2. A receiver loop observes the new event by cursor.
3. The receiver emits a delivery acknowledgement or failure reason.
4. The dashboard shows delivered, pending, or undeliverable based on that
   acknowledgement.
5. For managed sessions, a target process receives the attention through the
   adapter without requiring a manual user prompt.

Current implementation covers steps 1-4 for a stdout receiver loop via
`receive-attention`. It persists delivery attempts and advances
`delivery.lastAckEventId` only after adapter success. Step 5 still requires a
separate managed process or PTY/input adapter gate.
