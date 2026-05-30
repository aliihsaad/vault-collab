# Vault Collab Cockpit V2 Design Review

Date: 2026-05-30
Status: recommendation, no implementation

## Executive Recommendation

Build Cockpit V2 as a desktop operator control plane, not as a direct terminal-spawning dashboard.

The recommended architecture is:

1. Vault Collab remains the provider-neutral collaboration ledger.
2. The Vault desktop becomes the operator control plane.
3. The UI creates launch requests, approvals, and operator intents.
4. A separate local launcher broker executes approved launches later.
5. Spawned agents register themselves through the normal Vault Collab session flow.

Do not put direct multi-provider terminal spawning behind the first `+` button. The safe product sequence is coordination, then approvals, then launch plans, then a process-owning launcher.

The mobile dashboard/control requirement has been dropped by operator decision. V2.0 and V2.1 should not carry mobile dashboard scope.

## Review Inputs

### Independent Codex Review

The Vault Collab Codex reviewer recommended accepting the Cockpit direction only if authority stays split. The dashboard should create launch intent and approvals, while a separate broker owns process execution. The primary UX should be an operations board, inspector, and event/approval rails; graph or spatial views are secondary.

Key point: current Vault Collab has coordination primitives, owner-token checks, append-only events, attention feeds, and discussions, but not provider adapters, workspace allowlists, process ownership, credential isolation, or bootstrap-token semantics.

### The Vault Host/Control-Plane Review

The Vault-side reviewers agreed that The Vault already has the right base: a Vault Collab extension tab, local/managed runtime settings, client MCP setup wiring, and read-only dashboard snapshots over sessions, handoffs, events, discussion summaries, and permission attention.

Their recommendation: add a safe action broker and action matrix before richer visuals. Renderer code should render action models and send operator intents, not mutate the Vault Collab database directly and not hold other agents' owner tokens.

### Squad Reference Check

The local `squad` repo supports the same architectural lesson:

- Core collaboration is a one-shot CLI plus SQLite, with no daemon or background process in the core.
- Terminal launching is optional automation, separate from the core Rust CLI.
- The tmux launcher supports dry-run and worktree isolation.
- Session-token planning exists to detect identity replacement.

This reinforces the broker split: keep collaboration state simple and inspectable; make launching a separate, explicit capability.

Relevant local references:

- `C:\Users\Mini\Desktop\cloned-repos\squad\README.md`
- `C:\Users\Mini\Desktop\cloned-repos\squad\templates\launcher.yaml.example`
- `C:\Users\Mini\Desktop\cloned-repos\squad\docs\superpowers\plans\2026-03-22-session-token-plan.md`

### Claude Code Review

Claude Code posted after the first synthesis. Its headline position agrees with
the core convergence: no direct dashboard spawning in V2.0, launch requests as
the primitive, broker later, and an operations board over cubicles.

Claude added five gaps that should be folded into the final architecture:

- Project-name normalization is a V2.0 blocking prerequisite. This review board
  itself exposed the issue because threads and sessions were split across
  `Vault Collab` and `vault-collab`.
- Launch approvals are trajectory approvals, not command approvals. Operators
  are authorizing autonomous work envelopes, not just a starting command.
- `Spawn helper`, `pause`, and `stop` are backdoors unless modeled through the
  launch-request/action-matrix path with provider-specific semantics.
- Project-scope discussions are structurally easy to miss in attention feeds;
  Cockpit V2 needs an explicit subscription primitive or equivalent delivery
  model.
- Cost visibility and cross-provider asymmetry need to be first-class. Multi
  agent spawning is multi-provider spend, and provider action support is not
  symmetric.

Claude also proposed mobile companion constraints, but the operator has since
dropped mobile dashboard/control from V2.0 and V2.1 scope. Mobile remains
non-driving future context only.

## Product Direction

Cockpit V2 should answer these operational questions first:

- Who is active?
- Who is idle?
- Who is blocked?
- Who needs human approval?
- Which handoff is owned by whom?
- What changed recently?
- What can the operator legally do right now?
- What launch request is pending, approved, failed, or spawned?

The UI should not optimize for visual spectacle. It should optimize for repeated operational triage.

## Topic Decisions

### Topic 1: Visual Representation

Recommendation: use a hybrid, but make the default screen an operations board.

Do not make cubicle offices the primary information architecture. They are memorable, but low-density, ambiguous at scale, and likely to become decorative.

Do not make a node graph the default either. Graphs are useful for dependency and communication topology, but poor for repeated triage.

Use:

- Primary: dense operations board grouped by active sessions, approvals, launch requests, claimed handoffs, stale heartbeats, and recent events.
- Secondary: optional topology overlay showing recent communication and dependency edges.
- Optional later: a compact workstation/cubicle metaphor as a skin or mini-map, not as the core workflow.

### Topic 2: Direct Spawn vs Launch Requests

Recommendation: dashboard creates launch requests; a later broker executes them.

Direct spawning from the UI collapses operator intent, audit, command construction, process ownership, and provider-specific behavior into one risky path.

Launch requests should include:

- provider
- model and effort
- project label and normalized project key
- workspace path
- role/profile
- initial instructions or linked handoff/memory UID
- permission profile
- requested capabilities
- command preview
- risk level
- requested/approved/denied/deferred state
- spawned session UID, if execution later succeeds
- failure output and audit events

### Topic 3: Safest Spawning Model

Recommendation: local launcher broker, not renderer spawn.

The broker must:

- run only on the trusted local desktop
- allowlist providers and workspace roots
- validate command arguments structurally
- show exact command previews
- avoid broad shell strings where possible
- record process ownership
- track PID, provider, workspace, command preview, log path, started-by operator, and stop status
- require a registration handshake before declaring launch success
- use one-time bootstrap IDs, not another session's owner token
- distinguish broker-owned sessions from externally started sessions

The Vault can stop only processes it launched and tracks. External Codex/Claude sessions can be pinged, asked to report, marked stale/disconnected, or sent a stop request, but the UI should not imply it can kill them.

### Topic 4: Active Communication Visualization

Represent communication as operational signal, not animation.

Show edges only for meaningful relationships:

- handoff assignment
- review request
- permission request
- blocker
- discussion mention/update
- launch request
- report requested

Edges should encode event type, age, and current actionability. They should decay or move into history rather than permanently cluttering the board.

### Topic 5: Human Approvals

Approvals must be first-class records, not modal side effects.

Each approval card should show:

- requester session
- linked handoff or launch request
- requested capability
- command/action preview
- workspace/current directory
- risk level
- expected side effects
- approval scope
- expiry or timeout
- decision actor
- decision note
- current state

Preferred scopes:

- approve once
- approve for this handoff
- approve for this launch request
- approve for this workspace/profile until session end
- deny with note
- defer

Avoid broad "always allow" controls in early versions.

### Topic 6: Mobile Control

Operator update: drop the mobile dashboard/control requirement.

V2.0 and V2.1 should not include mobile dashboard work. The architecture should avoid choices that would make a future narrow companion impossible, but mobile should not drive scope, permissions, UX, or broker design now.

### Topic 7: New Capabilities After Spawning Exists

Once launch requests and broker-owned spawning exist, the system can support:

- helper agents spawned from a handoff
- review agents spawned for a completed change
- project-specific team templates
- provider-specific launch presets
- tracked stop/restart for broker-owned processes
- launch failure diagnostics
- workload history by project, role, provider, and model
- safer "request help" flows from any agent
- controlled multi-agent smoke tests
- future cost/budget gates

### Topic 8: Architectural Risks

Highest risks:

- renderer gets write access to the collaboration database
- session owner tokens leak into UI state
- direct spawn becomes an arbitrary shell gateway
- provider-specific CLI behavior is hidden behind one generic `+`
- workspace path spoofing or quoting bugs
- stale/disconnected sessions look actionable
- UI claims stop/pause authority over external terminals
- approval decisions exist only in UI state
- graph/cubicle visuals hide blockers instead of surfacing them
- "success" is inferred from process start instead of agent registration
- bypass-permission presets become normalized

### Topic 9: What Claude Would Recommend

Claude agrees with the main split-authority recommendation, but argues the
initial convergence under-modeled five things: project normalization, trajectory
approval envelopes, inspector action backdoors, discussion subscription, and cost
visibility.

Claude's specific recommendation is:

- make project normalization blocking before Cockpit implementation
- model approvals as budget + capability + escalation + output envelopes
- route `spawn helper` through launch requests, not a separate shortcut
- compute `pause` and `stop` through a provider and ownership action matrix
- add explicit discussion subscriptions rather than a project-wide firehose
- surface launch cost estimates and running session spend before enforcing
  budgets
- avoid fake provider symmetry; disabled-with-reason is better than universal
  buttons that mean different things per provider

### Topic 10: What Codex Recommends

Codex recommendation:

- build the operations board first
- model launch requests before launching
- model approval decisions as durable records
- keep Vault Collab provider-neutral
- keep The Vault responsible for host/control-plane behavior
- add a local launcher broker only after action legality and process ownership are explicit
- use focused schemas and tests around launch/approval/process ownership before UI polish

## Recommended Architecture

### Vault Collab Package Owns

- sessions
- heartbeats
- session state
- agent profiles
- handoffs
- queues and labels
- discussion threads and messages
- attention feed
- permission request lifecycle
- event ledger
- owner-token validation
- audited recovery
- launch-request records, if kept provider-neutral

### The Vault Owns

- desktop operator session
- local runtime settings
- Vault Collab database/source configuration
- UI rendering
- action broker
- launch request composer
- operator policy
- provider availability detection
- local launcher broker
- process registry
- Vault memory links
- Graphify/context surfacing

### Renderer Boundary

The renderer should receive action models:

```ts
type CockpitAction = {
  id: string;
  label: string;
  enabled: boolean;
  disabledReason?: string;
  sideEffect: "none" | "state-change" | "process" | "filesystem" | "network";
  requiredAuthority: string[];
  risk: "low" | "medium" | "high";
};
```

The renderer sends operator intents to the main process. It should not write SQLite directly and should not hold arbitrary session owner tokens.

## Recommended UX

Default desktop layout:

- left: projects and filters
- center: operations board
- right: inspector drawer
- bottom/right rail: recent events and approvals

Operations board groups:

- Needs Approval
- Blocked
- Active Agents
- Idle Agents
- Launch Requests
- Claimed Handoffs
- Stale/Disconnected
- Recent Completed

Agent inspector:

- provider/client type
- role/profile
- project display label and normalized key
- workspace path
- status and status detail
- heartbeat age
- current handoff
- recent events
- discussion participation
- linked Vault memories
- legal action matrix with disabled reasons

Launch composer:

- provider
- model/effort preset
- project
- workspace
- role/profile
- initial instructions
- permission profile
- linked handoff/memory
- generated command preview
- risk summary
- create request

V2.0 should allow creating the request, not executing it.

## Rollout Plan

### V2.0 Scope

Goal: operational Cockpit without process execution.

Include:

- project normalization as a blocking prerequisite across sessions, handoffs,
  discussions, attention, and launch requests
- active/history roster
- stale heartbeat and disconnected visibility
- selected session/handoff inspector
- attention feed integration
- project discussion subscription or equivalent non-firehose delivery model
- approval queue display
- permission request lifecycle schema
- launch-request schema and composer
- launch-request cost estimate and inspector running-spend display
- command preview generation as text only
- discussion posting
- idle ping
- request report
- server-side action matrix with enabled and disabled reasons, including the
  authorizing path for enabled actions

Exclude:

- direct spawn
- arbitrary shell execution
- mobile dashboard
- process kill/stop
- auto-claim
- active-session interruption
- broad allowlist approvals

### V2.1 Scope

Goal: local broker MVP for one or two explicit providers.

Include:

- local launcher broker
- provider adapter interface
- trajectory approvals with budget, capability, escalation, and output envelopes
- workspace allowlist
- provider binary detection
- structured argv generation
- exact command preview
- local process registry
- one-time bootstrap ID
- registration handshake
- launch failure states
- broker-owned stop request
- explicit operator policy store
- audit events for every state transition
- provider-asymmetric pause/stop semantics, only where ownership makes them real

Start with one provider path before generalizing.

### V3 Vision

Goal: full desktop command center for multi-agent teams.

Potential capabilities:

- team templates
- helper spawning from handoffs
- reviewer spawning from completed work
- cross-project assignment
- provider fallback policies
- budget/cost gates
- richer topology overlays
- broker-owned restart/recover flows
- notification routing
- replayable operation history
- automated but policy-gated review/smoke loops

Mobile remains out of scope unless explicitly reintroduced later.

## Source-Backed Constraints

- OpenAI Codex CLI is a local terminal coding agent that can read, change, and run code in the selected directory; its approval mode matters to launch safety. Source: https://developers.openai.com/codex/cli
- Claude Code documents permission-based operation, project-scoped write boundaries, and explicit command approvals. Source: https://code.claude.com/docs/en/security
- Claude Code settings support deny rules for sensitive files and hierarchical policy precedence. Source: https://code.claude.com/docs/en/settings
- MCP tools are model-controlled but clients should keep a human in the loop, show exposed tools and tool inputs, validate results, time out calls, and log usage. Source: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP elicitation must not be used to request sensitive information. Source: https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
- If The Vault uses Tauri shell capabilities, command execution must be scoped to configured programs/arguments; unconfigured commands are denied. Source: https://v2.tauri.app/reference/javascript/shell/

## Final Decision

Proceed with Cockpit V2 as a desktop operations board and control plane.

Do not implement direct dashboard spawning in V2.0. Model launch requests and approvals first. Add a launcher broker only after the system can prove action authority, process ownership, command preview correctness, and registration handshakes.

The strongest long-term architecture is not "dashboard launches agents." It is "operator records intent, policy approves it, local broker executes it, agent registers itself, and the ledger makes every step inspectable."
