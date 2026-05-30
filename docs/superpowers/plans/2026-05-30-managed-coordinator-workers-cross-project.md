# Managed Coordinator / Worker Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vault Collab work as a real multi-agent operating layer: a manually opened coordinator controls and talks to dashboard-launched managed workers across projects, and worker pings/attention are actually delivered.

**Architecture:** Vault Collab remains the durable shared control plane: sessions, handoffs, discussions, pings, launch requests, delivery attempts, and acknowledgements. The Vault desktop becomes the worker process owner: it launches worker agents, owns their PTY/ConPTY or managed process handle, registers them as `managed_process` / `wakeable`, delivers attention into owned workers, and acknowledges delivery. Manually opened terminal agents are coordinators and stay external/manual; dashboard-launched workers are managed/wakeable.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, Electron main/preload IPC, Vault Collab CLI/MCP, The Vault desktop React dashboard, node-pty for interactive terminal ownership, Vitest.

## 2026-05-30 Review Update: Audit Pivot

Claude reviewed this plan in discussion `vc_thread_7cb4c160-9408-45b3-9dbb-621489060f77` after reading the original implementation discussion `vc_thread_2db1ffe7-5313-48ad-ad87-035ef13852d5`.

The important correction: The Vault agent reported a local, unpushed ConPTY/node-pty runtime in `vc_msg_31dc4cad-edb5-4175-9800-2abda13a8ddd`. It claims The Vault now launches approved Codex workers through `node-pty`, registers them as `managed_process` / `wakeable`, maps `sessionUid -> PTY`, polls attention, writes into the PTY, and acknowledges after write.

Therefore Tasks 2-4 below must not be executed as greenfield implementation. Treat them as an audit/hardening baseline against The Vault's actual branch once it is pushed. The first phase is now:

1. The Vault pushes or otherwise makes the PTY runtime branch inspectable.
2. Vault Collab lands the low-risk contract/docs/tests plus default cross-project `relatedProjects`.
3. The Vault hardens the runtime: idle-safety, onExit lifecycle, launch failure paths, orphan recovery after Electron restart, and delivery-attempt visibility.
4. Then run the managed-worker smoke.

Blockers before claiming "no limitations":

- Define idle-safe delivery concretely. A managed worker must be `running`, Vault Collab session status must be `idle`, and the PTY must have a quiet window before writing attention.
- Handle Electron restart/orphan recovery. In-memory `sessionUid -> PTY` mappings cannot survive restart; lost workers must be marked disconnected or surfaced for reconciliation.
- Wire real `onExit` handling so exited workers are marked disconnected and do not remain shown as wakeable.
- Specify cross-project dashboard queries with `projectKey`, not raw labels.
- Default `relatedProjects` on handoff creation to `[sourceProject, targetProject]` when omitted.
- Keep launch form fields as The Vault broker IPC payload for v1 unless Vault Collab gets an explicit launch-request schema migration.
- Define Pause as suppressing attention delivery plus marking the worker blocked; define Stop as killing only owned PTYs, closing the session, and releasing claimed handoffs where appropriate.

---

## Product Contract

The best architecture is **manual coordinator + managed workers**.

- The coordinator is opened by the user in a terminal.
  - Claude: `/vault-collab`
  - Codex: text prompt `use vault collab`
- Workers are launched from The Vault dashboard.
  - A coordinator may create/request the launch.
  - The user may manually approve/launch from the dashboard.
- Only dashboard-launched workers are expected to be wakeable.
- External/manual coordinator sessions are not force-woken. They poll or use Vault Collab explicitly.
- Cross-project coordination must work when all sessions share the same Vault Collab database.
- Sessions keep their own `project` and `workspacePath`.
- Routing must work through `relatedProjects`, `sourceProject`, `targetProject`, `suggestedSessionUid`, discussions, and pings.

This is better than trying to wake arbitrary external terminals because it keeps process authority real. If The Vault did not launch and own the terminal/process, it cannot reliably and safely inject input into it.

## File Structure

### Vault Collab repo

- Modify: `src/agent-guide.ts`
  - Make the coordinator/worker model explicit.
  - State that automatic delivery applies to managed workers only.
- Modify: `docs/pty-process-ownership-gate.md`
  - Keep the process-owner boundary and cross-project worker model in one reference doc.
- Modify: `docs/cockpit-v2-actionable-dashboard-contract.md`
  - Add dashboard requirements for coordinator/worker labels, cross-project routing, and delivery attempt display.
- Test: `tests/cli.test.ts`
  - Assert the guide describes manual coordinator + managed workers.
- Test: `tests/mcp-tools.test.ts`
  - Assert MCP guide output contains the same contract.

### The Vault repo

- Modify: `packages/desktop/package.json`
  - Add `node-pty` when implementing interactive worker terminals.
- Create: `packages/desktop/electron/vault-collab-managed-workers.ts`
  - Own managed worker processes.
  - Register launched workers with Vault Collab.
  - Map `sessionUid -> worker runtime`.
  - Poll attention and deliver into owned workers.
  - Acknowledge attention after successful delivery.
- Modify: `packages/desktop/electron/main.ts`
  - Wire IPC handlers to the managed worker service.
  - Replace one-shot launch-only behavior with managed worker runtime.
- Modify: `packages/desktop/electron/preload.ts`
  - Expose safe renderer methods for launch, stop, and worker delivery status.
- Modify: `packages/desktop/src/types.d.ts`
  - Add typed renderer API methods.
- Modify: `packages/core/src/types/vault-collab.ts`
  - Add dashboard-facing worker runtime status types if needed.
- Modify: `packages/core/src/services/vault-collab-actions.service.ts`
  - Keep CLI action construction token-safe.
  - Add helper invocations only if the managed worker service needs them.
- Modify: `packages/desktop/src/vault-collab-view-model.ts`
  - Label coordinator vs worker sessions.
  - Show managed/wakeable worker delivery state and last ack.
  - Show cross-project related sessions and handoffs.
- Modify: `packages/desktop/src/components/VaultCollabView.tsx`
  - Route Launch to the managed worker service.
  - Add a proper managed worker launch/control UI.
  - Show worker runtime state, delivery attempts, and failures.
  - Avoid implying external/manual coordinator sessions are wakeable.
- Test: `packages/core/src/vault-collab-actions.test.ts`
  - Cover any new CLI action invocations.
- Test: `packages/desktop/src/vault-collab-view-model.test.ts`
  - Cover coordinator/worker labels, cross-project visibility, and delivery state.
- Add/Test: `packages/desktop/electron/vault-collab-managed-workers.test.ts`
  - Unit test launch/register/ack behavior with fake process and fake Vault Collab runner.

---

### Task 1: Lock The Vault Collab Contract

**Files:**
- Modify: `src/agent-guide.ts`
- Modify: `docs/pty-process-ownership-gate.md`
- Modify: `docs/cockpit-v2-actionable-dashboard-contract.md`
- Test: `tests/cli.test.ts`
- Test: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Add failing CLI guide assertions**

In `tests/cli.test.ts`, extend the guide test:

```ts
expect(loopText).toMatch(/coordinator/i);
expect(loopText).toMatch(/managed worker/i);
expect(safetyText).toMatch(/manual coordinator/i);
expect(safetyText).toMatch(/dashboard-launched worker/i);
```

- [ ] **Step 2: Add failing MCP guide assertions**

In `tests/mcp-tools.test.ts`, extend the guide test:

```ts
expect(loopText).toMatch(/coordinator/i);
expect(loopText).toMatch(/managed worker/i);
expect(safetyText).toMatch(/manual coordinator/i);
expect(safetyText).toMatch(/dashboard-launched worker/i);
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
npm run test:run -- tests/cli.test.ts tests/mcp-tools.test.ts
```

Expected: fail until the guide text is updated.

- [ ] **Step 4: Update `src/agent-guide.ts`**

Add these loop entries:

```ts
"Use a manually opened terminal session as the coordinator. Claude coordinators join with /vault-collab; Codex coordinators join by prompting `use vault collab`.",
"Use The Vault dashboard launch requests for worker agents. Dashboard-launched workers are the sessions that should be managed, wakeable, and automatically delivered to.",
"For cross-project work, keep all sessions on the same Vault Collab database and route via relatedProjects, sourceProject, targetProject, suggestedSessionUid, discussions, and pings.",
```

Add these safety rules:

```ts
"Do not promise wake delivery for a manual coordinator session. The coordinator is user-driven and polls Vault Collab explicitly.",
"Do not mark a worker wakeable unless The Vault launched or owns the worker process and can deliver attention into it.",
"Do not isolate cross-project workers by current repository when they share the same Vault Collab database and are linked by relatedProjects or suggestedSessionUid.",
```

- [ ] **Step 5: Update docs**

In `docs/pty-process-ownership-gate.md`, add:

```md
## Coordinator / Worker Model

The user-opened terminal agent is the coordinator. It joins Vault Collab manually and does not need forced wake delivery.

Dashboard-launched agents are workers. They must be launched and owned by The Vault when the product promises automatic ping/attention delivery.

Cross-project workers are valid as long as they share the same Vault Collab database. Routing should use relatedProjects, sourceProject, targetProject, suggestedSessionUid, discussions, and pings rather than assuming a single current repository.
```

In `docs/cockpit-v2-actionable-dashboard-contract.md`, add:

```md
## Coordinator and Managed Worker UX

- Show manually joined sessions as coordinator/manual unless their delivery metadata proves otherwise.
- Show dashboard-launched sessions as managed workers when `capabilities.launchedBy` is present and `delivery.mode === "managed_process"`.
- Ping copy for coordinator/manual sessions must say stored/manual.
- Ping copy for managed workers may say delivered only after a delivery attempt succeeds and acknowledgement advances.
- Cross-project related sessions and handoffs must remain visible when connected through relatedProjects or suggestedSessionUid.
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run build
npm run test:run -- tests/cli.test.ts tests/mcp-tools.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/agent-guide.ts docs/pty-process-ownership-gate.md docs/cockpit-v2-actionable-dashboard-contract.md tests/cli.test.ts tests/mcp-tools.test.ts
git commit -m "Clarify coordinator worker delivery contract"
```

---

### Task 1.5: Default Cross-Project Related Projects

**Files:**
- Modify: `src/services/handoff.service.ts`
- Test: `tests/handoff.service.test.ts`

- [ ] **Step 1: Add failing handoff service tests**

Assert that publishing a handoff without `relatedProjects` stores source and target projects as related projects, deduplicated by `projectKey`.

- [ ] **Step 2: Implement publish-time defaulting**

In `HandoffService.publishHandoff`, normalize related projects:

- if caller supplies non-empty `relatedProjects`, preserve that set;
- otherwise use `[sourceProject, targetProject]`;
- dedupe by `projectKey` so `Vault Collab` and `vault_collab` do not create duplicate route entries.

- [ ] **Step 3: Verify**

Run:

```bash
npm run test:run -- tests/handoff.service.test.ts
```

Expected: pass.

---

### Task 2: Audit And Harden The Vault Managed Worker Runtime

**Files:**
- Modify: `packages/desktop/electron/vault-collab-managed-workers.ts`
- Test: `packages/desktop/electron/vault-collab-managed-workers.test.ts`
- Modify: `packages/desktop/package.json`

Do not start this task until The Vault's local PTY runtime from `vc_msg_31dc4cad-edb5-4175-9800-2abda13a8ddd` is pushed or otherwise inspectable. The implementation below is historical scaffolding; the real task is to verify and harden the existing runtime.

Audit requirements:

- Confirm approved launch requests register workers as `managed_process` and `wakeable`.
- Confirm `onExit` marks the runtime exited and updates the Vault Collab session to `disconnected`.
- Confirm startup/register/spawn failures call `vault_collab_fail_launch_request`.
- Add orphan recovery: on Electron boot, detect previously managed wakeable workers that no longer have an owned PTY and surface or mark them disconnected.
- Keep worker session tokens out of renderer state.

- [ ] **Step 1: Add a failing service test**

Create `packages/desktop/electron/vault-collab-managed-workers.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createVaultCollabManagedWorkerService } from './vault-collab-managed-workers.js';

describe('Vault Collab managed worker service', () => {
  it('registers a dashboard-launched worker as managed and wakeable', async () => {
    const runAction = vi.fn(async (input: unknown) => {
      const action = input as { kind: string; action?: string };
      if (action.kind === 'session-register') {
        return {
          sessionUid: 'vc_sess_worker',
          sessionToken: 'worker-token',
        };
      }
      return { ok: true };
    });

    const service = createVaultCollabManagedWorkerService({
      runAction,
      spawnWorker: vi.fn(() => ({
        pid: 123,
        write: vi.fn(),
        kill: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn(),
      })),
      now: () => new Date('2026-05-30T12:00:00.000Z'),
    });

    const worker = await service.launchWorker({
      launchRequestUid: 'vc_launch_1',
      provider: 'codex',
      project: 'Vault Collab',
      workspacePath: 'C:/repo/vault-collab',
      initialInstructions: 'Inspect the bug.',
      permissionMode: 'workspace-write',
    });

    expect(worker).toMatchObject({
      launchRequestUid: 'vc_launch_1',
      sessionUid: 'vc_sess_worker',
      deliveryMode: 'managed_process',
      wakeable: true,
      status: 'running',
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test -- packages/desktop/electron/vault-collab-managed-workers.test.ts
```

Expected: fail because the service does not exist.

- [ ] **Step 3: Implement the skeleton service**

Create `packages/desktop/electron/vault-collab-managed-workers.ts`:

```ts
export interface ManagedWorkerLaunchInput {
  launchRequestUid: string;
  provider: 'codex' | 'claude-code' | 'claude-desktop' | 'octogent' | 'gemini' | 'opencode' | 'other';
  project: string;
  workspacePath: string;
  initialInstructions: string;
  permissionMode: string;
}

export interface ManagedWorkerRuntime {
  launchRequestUid: string;
  sessionUid: string;
  sessionToken: string;
  provider: ManagedWorkerLaunchInput['provider'];
  project: string;
  workspacePath: string;
  deliveryMode: 'managed_process';
  wakeable: true;
  status: 'running' | 'exited' | 'failed';
  pid: number | null;
}

export interface WorkerProcessHandle {
  pid: number | null;
  write(data: string): void;
  kill(): void;
  onData(callback: (chunk: string) => void): void;
  onExit(callback: (exit: { exitCode: number | null; signal?: string | null }) => void): void;
}

export interface ManagedWorkerServiceDeps {
  runAction(input: unknown): Promise<unknown>;
  spawnWorker(input: ManagedWorkerLaunchInput): WorkerProcessHandle;
  now?: () => Date;
}

export function createVaultCollabManagedWorkerService(deps: ManagedWorkerServiceDeps) {
  const workers = new Map<string, ManagedWorkerRuntime>();

  return {
    async launchWorker(input: ManagedWorkerLaunchInput): Promise<ManagedWorkerRuntime> {
      const registered = await deps.runAction({
        kind: 'session-register',
        displayName: `Worker - ${input.provider}`,
        clientType: input.provider,
        project: input.project,
        workspacePath: input.workspacePath,
        capabilities: {
          worker: true,
          launchedBy: input.launchRequestUid,
        },
        deliveryMode: 'managed_process',
        deliveryWakeable: true,
      }) as { sessionUid: string; sessionToken: string };

      const process = deps.spawnWorker(input);
      const runtime: ManagedWorkerRuntime = {
        launchRequestUid: input.launchRequestUid,
        sessionUid: registered.sessionUid,
        sessionToken: registered.sessionToken,
        provider: input.provider,
        project: input.project,
        workspacePath: input.workspacePath,
        deliveryMode: 'managed_process',
        wakeable: true,
        status: 'running',
        pid: process.pid,
      };

      workers.set(runtime.sessionUid, runtime);
      return runtime;
    },
    getWorker(sessionUid: string): ManagedWorkerRuntime | null {
      return workers.get(sessionUid) ?? null;
    },
  };
}
```

- [ ] **Step 4: Run test**

Run:

```bash
pnpm test -- packages/desktop/electron/vault-collab-managed-workers.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/electron/vault-collab-managed-workers.ts packages/desktop/electron/vault-collab-managed-workers.test.ts
git commit -m "Add managed worker runtime skeleton"
```

---

### Task 3: Verify Launch Requests Route To Managed Workers

**Files:**
- Modify: `packages/desktop/electron/main.ts`
- Modify: `packages/core/src/services/vault-collab-actions.service.ts`
- Modify: `packages/core/src/types/vault-collab.ts`
- Test: `packages/core/src/vault-collab-actions.test.ts`

The Vault reportedly already replaced the plain Launch path with a PTY-backed broker. Re-baseline this task against the pushed The Vault branch before writing new code. Required lifecycle remains: `mark_launching -> register managed worker -> spawn owned PTY -> mark_running`, and every error path must call `launch-fail`.

- [ ] **Step 1: Add session registration action input**

In `packages/core/src/types/vault-collab.ts`, extend `VaultCollabDashboardActionInput`:

```ts
| {
    kind: 'session_register';
    displayName: string;
    clientType: VaultCollabClientType;
    project: string;
    workspacePath: string;
    capabilities?: VaultCollabJsonRecord;
    deliveryMode?: 'manual_poll' | 'local_watch' | 'mcp_notification' | 'managed_process';
    deliveryWakeable?: boolean;
  }
```

- [ ] **Step 2: Add failing action-builder test**

In `packages/core/src/vault-collab-actions.test.ts`:

```ts
it('builds managed worker session registration commands', () => {
  const invocation = buildVaultCollabActionInvocation(config, actor, {
    kind: 'session_register',
    displayName: 'Worker - codex',
    clientType: 'codex',
    project: 'Vault Collab',
    workspacePath: 'C:\\repo\\vault-collab',
    capabilities: { worker: true, launchedBy: 'vc_launch_123' },
    deliveryMode: 'managed_process',
    deliveryWakeable: true,
  });

  expect(invocation.args).toEqual(expect.arrayContaining([
    'register',
    '--db',
    config.databasePath,
    '--display-name',
    'Worker - codex',
    '--client-type',
    'codex',
    '--project',
    'Vault Collab',
    '--workspace-path',
    'C:\\repo\\vault-collab',
    '--delivery-mode',
    'managed_process',
    '--wakeable',
    '--capability',
    'worker=true',
    '--capability',
    'launchedBy=vc_launch_123',
  ]));
});
```

- [ ] **Step 3: Implement action-builder support**

In `packages/core/src/services/vault-collab-actions.service.ts`, route the new kind:

```ts
if (input.kind === 'session_register') {
  const capabilityArgs = Object.entries(input.capabilities ?? {}).flatMap(([key, value]) => [
    '--capability',
    `${key}=${String(value)}`,
  ]);

  return [
    'register',
    '--db',
    databasePath,
    '--display-name',
    requiredValue(input.displayName, 'Session display name'),
    '--client-type',
    input.clientType,
    '--project',
    requiredValue(input.project, 'Session project'),
    '--workspace-path',
    requiredValue(input.workspacePath, 'Session workspace path'),
    ...(input.deliveryMode ? ['--delivery-mode', input.deliveryMode] : []),
    ...(input.deliveryWakeable ? ['--wakeable'] : []),
    ...capabilityArgs,
  ];
}
```

- [ ] **Step 4: Wire `vault:startVaultCollabLaunchRequest`**

> Audit only: verify this lifecycle against the pushed The Vault branch. Do not
> re-implement this sample verbatim if The Vault already has the PTY runtime.

In `packages/desktop/electron/main.ts`, keep the existing broker IPC but make its core sequence failure-safe:

```ts
const actor = await ensureVaultCollabDashboardActor();
try {
  await executeVaultCollabAction(config, actor, {
    kind: 'launch',
    action: 'mark_launching',
    launchRequestUid,
    detail: 'The Vault broker accepted the launch request.',
  });

  const worker = await managedWorkerService.launchWorker({
    launchRequestUid,
    provider: launchRequest.provider,
    project: launchRequest.project,
    workspacePath: launchRequest.workspacePath,
    initialInstructions: launchRequest.initialInstructions,
    permissionMode: launchRequest.permissionMode,
  });

  await executeVaultCollabAction(config, actor, {
    kind: 'launch',
    action: 'mark_running',
    launchRequestUid,
    launchedSessionUid: worker.sessionUid,
    detail: 'The Vault broker launched and registered a managed worker.',
  });
} catch (error) {
  await executeVaultCollabAction(config, actor, {
    kind: 'launch',
    action: 'fail',
    launchRequestUid,
    reason: error instanceof Error ? error.message : String(error),
  });
  throw error;
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm test -- packages/core/src/vault-collab-actions.test.ts
pnpm lint
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types/vault-collab.ts packages/core/src/services/vault-collab-actions.service.ts packages/core/src/vault-collab-actions.test.ts packages/desktop/electron/main.ts
git commit -m "Wire launch requests to managed worker registration"
```

---

### Task 4: Enforce Idle-Safe Worker Attention Delivery

**Files:**
- Modify: `packages/desktop/electron/vault-collab-managed-workers.ts`
- Modify: `packages/desktop/electron/main.ts`
- Test: `packages/desktop/electron/vault-collab-managed-workers.test.ts`

The Vault note says attention delivery already exists. This task is now about enforcing the safety contract:

- prefer event-driven delivery after `session.pinged`;
- use a long fallback interval, not a tight 2s loop, unless tests prove it is needed;
- deliver only when worker runtime is `running`;
- deliver only when Vault Collab session status is `idle`;
- require a PTY quiet window before writing;
- write a short attention summary, never arbitrary commands;
- acknowledge only after a successful PTY write;
- record a failed delivery attempt when the target is not idle-safe.

- [ ] **Step 1: Add failing delivery test**

Add to `packages/desktop/electron/vault-collab-managed-workers.test.ts`:

```ts
it('writes attention into an owned worker and acknowledges after write', async () => {
  const writes: string[] = [];
  const runAction = vi.fn(async (input: unknown) => {
    const action = input as { kind: string; sessionUid?: string };
    if (action.kind === 'session-register') {
      return { sessionUid: 'vc_sess_worker', sessionToken: 'worker-token' };
    }
    if (action.kind === 'attention') {
      return {
        latestEventId: 12,
        items: [{ kind: 'session_ping', event: { payload: { message: 'Please check this.' } } }],
      };
    }
    if (action.kind === 'attention-ack') {
      return { ok: true };
    }
    return { ok: true };
  });

  const service = createVaultCollabManagedWorkerService({
    runAction,
    spawnWorker: vi.fn(() => ({
      pid: 123,
      write: (data: string) => writes.push(data),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    })),
  });

  const worker = await service.launchWorker({
    launchRequestUid: 'vc_launch_1',
    provider: 'codex',
    project: 'Vault Collab',
    workspacePath: 'C:/repo/vault-collab',
    initialInstructions: 'Start.',
    permissionMode: 'workspace-write',
  });

  await service.deliverAttention(worker.sessionUid);

  expect(writes.join('\n')).toContain('Vault Collab attention');
  expect(writes.join('\n')).toContain('Please check this.');
  expect(runAction).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'attention-ack',
    sessionUid: 'vc_sess_worker',
    sessionToken: 'worker-token',
    latestEventId: 12,
  }));
});
```

- [ ] **Step 2: Implement `deliverAttention`**

> Audit only: the code below is the intended shape of the safety contract, not a
> greenfield replacement for The Vault's existing receiver. The implementation
> must gate on session idle state and PTY quiet time before writing.

In `vault-collab-managed-workers.ts`, keep attention text short and non-commanding:

```ts
function composeAttentionPrompt(feed: { items: Array<{ kind: string; event?: { payload?: { message?: string } } }>; latestEventId: number }): string {
  const lines = ['Vault Collab attention:'];
  for (const item of feed.items) {
    const message = item.event?.payload?.message;
    lines.push(`- ${item.kind}${message ? ` - ${message}` : ''}`);
  }
  lines.push('Inspect attention before acting. Do not auto-claim unless appropriate.');
  return `${lines.join('\n')}\r`;
}
```

Add method:

```ts
async deliverAttention(sessionUid: string): Promise<boolean> {
  const worker = workers.get(sessionUid);
  const process = processes.get(sessionUid);
  if (!worker || !process || worker.status !== 'running') {
    return false;
  }

  const session = await deps.runAction({
    kind: 'session',
    action: 'get',
    sessionUid,
  }) as { status: string };
  if (session.status !== 'idle' || !isPtyQuiet(sessionUid)) {
    await recordFailedDelivery(sessionUid, 'target session not idle-safe');
    return false;
  }

  const feed = await deps.runAction({
    kind: 'attention',
    sessionUid,
    includeCurrentHandoffs: true,
  }) as { latestEventId: number; items: unknown[] };

  if (feed.items.length === 0) {
    return false;
  }

  process.write(composeAttentionPrompt(feed as any));
  await deps.runAction({
    kind: 'attention-ack',
    sessionUid,
    sessionToken: worker.sessionToken,
    latestEventId: feed.latestEventId,
  });
  return true;
}
```

- [ ] **Step 3: Trigger delivery after ping or on interval**

In `main.ts`, after successful `performVaultCollabDashboardAction` for `kind === 'session' && action === 'ping'`, call:

```ts
if (input.kind === 'session' && input.action === 'ping') {
  await managedWorkerService.deliverAttention(input.targetSessionUid);
}
```

Also start a conservative fallback interval:

```ts
setInterval(() => {
  managedWorkerService.deliverAllAttention().catch((error) => {
    console.warn('[Vault Collab] managed worker delivery failed', error);
  });
}, 30_000);
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test -- packages/desktop/electron/vault-collab-managed-workers.test.ts
pnpm lint
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/electron/vault-collab-managed-workers.ts packages/desktop/electron/vault-collab-managed-workers.test.ts packages/desktop/electron/main.ts
git commit -m "Deliver Vault Collab attention to managed workers"
```

---

### Task 5: Add Cross-Project Visibility Tests

**Files:**
- Modify: `packages/desktop/src/vault-collab-view-model.test.ts`
- Modify: `packages/desktop/src/vault-collab-view-model.ts`
- Modify: `packages/core/src/services/vault-collab-dashboard.service.ts`

- [ ] **Step 1: Add failing view-model test**

In `packages/desktop/src/vault-collab-view-model.test.ts`:

```ts
it('keeps related cross-project workers visible to the coordinator', () => {
  const model = buildVaultCollabDashboardViewModel({
    configured: true,
    ready: true,
    dataReady: true,
    databasePath: 'C:/Vault/vault-collab.db',
    message: 'Ready',
    errorMessage: null,
    sessions: [
      session({ sessionUid: 'vc_sess_coord', project: 'the-vault', displayName: 'Coordinator', capabilities: { coordinator: true } }),
      session({ sessionUid: 'vc_sess_worker', project: 'vault-collab', displayName: 'Worker', capabilities: { worker: true, launchedBy: 'vc_launch_1' }, delivery: { mode: 'managed_process', wakeable: true, lastAckEventId: 10, lastAckAt: '2026-05-30T12:00:00.000Z' } }),
    ],
    handoffs: [
      handoff({ handoffUid: 'vc_handoff_cross', sourceProject: 'the-vault', targetProject: 'vault-collab', relatedProjects: ['the-vault', 'vault-collab'], suggestedSessionUid: 'vc_sess_worker' }),
    ],
    launchRequests: [],
    events: [],
    counts: emptyCounts(),
  });

  expect(model.sessionGroups.flatMap((group) => group.sessions).map((row) => row.uid)).toContain('vc_sess_worker');
  expect(model.handoffRows.map((row) => row.uid)).toContain('vc_handoff_cross');
});
```

- [ ] **Step 2: Update dashboard query policy**

In `packages/core/src/services/vault-collab-dashboard.service.ts`, ensure dashboard snapshot includes:

- sessions where `projectKey(session.project) === projectKey(currentProject)`;
- sessions suggested or claimed on a handoff where current project appears in `sourceProject`, `targetProject`, or `relatedProjects`;
- handoffs where current project is `sourceProject`, `targetProject`, or included in `relatedProjects`, compared by `projectKey`;
- handoffs suggested to any visible session;
- discussions linked to visible handoffs.

- [ ] **Step 3: Update view model labels**

In `packages/desktop/src/vault-collab-view-model.ts`, label sessions:

```ts
const isManagedWorker = session.capabilities?.worker === true || typeof session.capabilities?.launchedBy === 'string';
const isCoordinator = session.capabilities?.coordinator === true || !isManagedWorker;
```

Display labels:

```ts
roleLabel: isManagedWorker ? 'Managed worker' : 'Coordinator/manual',
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test -- packages/desktop/src/vault-collab-view-model.test.ts packages/core/src/vault-collab-runtime.test.ts
pnpm lint
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/vault-collab-view-model.ts packages/desktop/src/vault-collab-view-model.test.ts packages/core/src/services/vault-collab-dashboard.service.ts
git commit -m "Show cross-project coordinator worker context"
```

---

### Task 6: Dashboard UX For Managed Workers

**Files:**
- Modify: `packages/desktop/src/components/VaultCollabView.tsx`
- Modify: `packages/desktop/src/app.css`
- Modify: `packages/desktop/src/vault-collab-view-model.ts`
- Test: `packages/desktop/src/vault-collab-view-model.test.ts`

- [ ] **Step 1: Add view-model expectations**

In `packages/desktop/src/vault-collab-view-model.test.ts`, assert:

```ts
expect(workerRow.deliveryLabel).toBe('Wakeable managed');
expect(workerRow.roleLabel).toBe('Managed worker');
expect(coordinatorRow.deliveryDetail).toMatch(/manual/i);
expect(coordinatorRow.roleLabel).toBe('Coordinator/manual');
```

- [ ] **Step 2: Render role and delivery clearly**

In `VaultCollabView.tsx`, add role display beside session title:

```tsx
<span className="vault-collab-meta-chip">{session.roleLabel}</span>
```

For ping notices:

```ts
if (delivery.wakeable === true) {
  setActionNotice(`Ping delivered to managed worker ${formatSessionShortUid(sessionUid)}. ${nextStep}`);
} else {
  setActionNotice(`Ping stored for manual coordinator/session ${formatSessionShortUid(sessionUid)}. ${nextStep}`);
}
```

- [ ] **Step 3: Add delivery attempt panel**

Add a compact section under session detail:

```tsx
{session.deliveryAttempts?.length ? (
  <div className="vault-collab-delivery-attempts">
    {session.deliveryAttempts.map((attempt) => (
      <span key={attempt.attemptUid} className={`badge badge-${attempt.status === 'delivered' ? 'good' : 'warning'}`}>
        {attempt.status}: {attempt.message}
      </span>
    ))}
  </div>
) : null}
```

- [ ] **Step 4: Run tests/build**

Run:

```bash
pnpm test -- packages/desktop/src/vault-collab-view-model.test.ts
pnpm --filter @the-vault/desktop build
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/components/VaultCollabView.tsx packages/desktop/src/app.css packages/desktop/src/vault-collab-view-model.ts packages/desktop/src/vault-collab-view-model.test.ts
git commit -m "Clarify managed worker delivery in dashboard"
```

---

### Task 7: Managed Worker Launch Controls UX

**Files:**
- Modify: `packages/desktop/src/components/VaultCollabView.tsx`
- Modify: `packages/desktop/src/vault-collab-view-model.ts`
- Modify: `packages/desktop/src/vault-collab-view-model.test.ts`
- Modify: `packages/desktop/src/app.css`
- Modify: `packages/core/src/types/vault-collab.ts`

Review correction: do not add model/effort/role/workspace/instructions fields to Vault Collab dashboard action types unless a Vault Collab schema migration stores them. For v1, keep those fields in The Vault Electron broker IPC payload and use Vault Collab launch-request records as the durable source. Provider controls must branch by provider because Codex and Claude Code do not share the same model, effort, or permission vocabulary.

- [ ] **Step 1: Add view-model test for launch configuration**

In `packages/desktop/src/vault-collab-view-model.test.ts`, add:

```ts
it('exposes managed worker launch configuration for dashboard controls', () => {
  const model = buildVaultCollabDashboardViewModel(snapshotWithLaunchRequest({
    launchRequestUid: 'vc_launch_worker',
    provider: 'codex',
    model: 'gpt-5-codex',
    effortLevel: 'high',
    role: 'reviewer',
    project: 'vault-collab',
    workspacePath: 'C:/repo/vault-collab',
    permissionMode: 'workspace-write',
    initialInstructions: 'Review the receiver path.',
    requestedCapabilities: ['tests', 'code_edit'],
    status: 'approved',
  }));

  const row = model.launchRequestRows.find((item) => item.uid === 'vc_launch_worker');

  expect(row).toMatchObject({
    providerLabel: 'codex',
    modelLabel: 'gpt-5-codex',
    effortLabel: 'high',
    roleLabel: 'reviewer',
    workspaceLabel: 'C:/repo/vault-collab',
    canLaunchManagedWorker: true,
  });
});
```

- [ ] **Step 2: Add editable launch form state**

In `VaultCollabView.tsx`, replace prompt-only Launch behavior with a managed launch form state:

```ts
interface ManagedLaunchDraft {
  launchRequestUid: string;
  sessionName: string;
  provider: 'codex' | 'claude-code';
  model: string;
  effortLevel: 'low' | 'medium' | 'high';
  role: string;
  permissionMode: 'read-only' | 'workspace-write';
  workspacePath: string;
  initialInstructions: string;
}

const [managedLaunchDraft, setManagedLaunchDraft] = useState<ManagedLaunchDraft | null>(null);
```

- [ ] **Step 3: Add launch controls UI**

In the launch request card area, render controls for approved/requested launch requests:

```tsx
{managedLaunchDraft?.launchRequestUid === launchRequest.uid ? (
  <div className="vault-collab-managed-launch-form">
    <label>
      <span>Session name</span>
      <input
        className="text-input"
        value={managedLaunchDraft.sessionName}
        onChange={(event) => setManagedLaunchDraft({ ...managedLaunchDraft, sessionName: event.target.value })}
      />
    </label>
    <label>
      <span>Model</span>
      <input
        className="text-input"
        value={managedLaunchDraft.model}
        onChange={(event) => setManagedLaunchDraft({ ...managedLaunchDraft, model: event.target.value })}
      />
    </label>
    <label>
      <span>Effort</span>
      <select
        className="text-input"
        value={managedLaunchDraft.effortLevel}
        onChange={(event) => setManagedLaunchDraft({ ...managedLaunchDraft, effortLevel: event.target.value as ManagedLaunchDraft['effortLevel'] })}
      >
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
      </select>
    </label>
    <label>
      <span>Permissions</span>
      <select
        className="text-input"
        value={managedLaunchDraft.permissionMode}
        onChange={(event) => setManagedLaunchDraft({ ...managedLaunchDraft, permissionMode: event.target.value as ManagedLaunchDraft['permissionMode'] })}
      >
        <option value="read-only">read-only</option>
        <option value="workspace-write">workspace-write</option>
      </select>
    </label>
    <textarea
      className="text-input"
      value={managedLaunchDraft.initialInstructions}
      onChange={(event) => setManagedLaunchDraft({ ...managedLaunchDraft, initialInstructions: event.target.value })}
    />
    <div className="inline-actions vault-collab-action-row">
      <button type="button" className="primary-button" onClick={() => void runManagedLaunch(managedLaunchDraft)}>
        Launch managed worker
      </button>
      <button type="button" className="header-button" onClick={() => setManagedLaunchDraft(null)}>
        Cancel
      </button>
    </div>
  </div>
) : null}
```

- [ ] **Step 4: Keep launch configuration broker-local**

Do not extend `VaultCollabDashboardActionInput` with broker-only launch form fields in v1. Instead:

- use the existing Vault Collab launch request as the durable request record;
- pass editable runtime overrides through The Vault Electron IPC only;
- branch model/effort/permission controls by provider;
- use agent-role/profile APIs for role dropdown values when available.

- [ ] **Step 5: Pass launch config to IPC broker**

In `VaultCollabView.tsx`, send launch configuration through The Vault's broker IPC, not through `VaultCollabDashboardActionInput`:

```ts
async function runManagedLaunch(draft: ManagedLaunchDraft) {
  await window.theVault.startVaultCollabLaunchRequest({
    launchRequestUid: draft.launchRequestUid,
    sessionName: draft.sessionName,
    provider: draft.provider,
    model: draft.model,
    effortLevel: draft.effortLevel,
    role: draft.role,
    workspacePath: draft.workspacePath,
    permissionMode: draft.permissionMode,
    initialInstructions: draft.initialInstructions,
  });
  setManagedLaunchDraft(null);
}
```

The Electron handler should call `vault:startVaultCollabLaunchRequest` with broker-local launch config rather than treating those fields as plain Vault Collab lifecycle marks.

- [ ] **Step 6: Add worker control actions**

For running managed workers, add controls:

```tsx
<button type="button" className="header-button" disabled={!session.canPing} onClick={() => void runSessionAction('ping', session.uid, session.displayName)}>
  Ping
</button>
<button type="button" className="header-button" disabled={!session.canPause} onClick={() => void runManagedWorkerAction('pause', session.uid)}>
  Pause
</button>
<button type="button" className="danger-button" disabled={!session.canStop} onClick={() => void runManagedWorkerAction('stop', session.uid)}>
  Stop
</button>
```

Back these with Electron-main methods that only operate on workers The Vault owns. External coordinator sessions should not show Pause/Stop.

Pause semantics: suppress delivery to the owned worker and mark its Vault Collab session `blocked` with a reason.

Stop semantics: kill only The Vault-owned PTYs, close/disconnect the worker session, and release any handoff claimed by that worker when the release is safe and token-authorized.

- [ ] **Step 7: Add CSS for dense operational controls**

In `packages/desktop/src/app.css`:

```css
.vault-collab-managed-launch-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 10px 0 0;
}

.vault-collab-managed-launch-form textarea {
  grid-column: 1 / -1;
  min-height: 84px;
  resize: vertical;
}

.vault-collab-managed-launch-form .vault-collab-action-row {
  grid-column: 1 / -1;
}
```

- [ ] **Step 8: Run UI tests/build**

Run:

```bash
pnpm test -- packages/desktop/src/vault-collab-view-model.test.ts
pnpm --filter @the-vault/desktop build
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add packages/desktop/src/components/VaultCollabView.tsx packages/desktop/src/vault-collab-view-model.ts packages/desktop/src/vault-collab-view-model.test.ts packages/desktop/src/app.css packages/core/src/types/vault-collab.ts
git commit -m "Add managed worker launch controls"
```

---

### Task 8: End-To-End Smoke Script

**Files:**
- Create: `scripts/smoke-vault-collab-managed-worker.ps1`
- Modify: `package.json`

This smoke is Windows-only because the first managed-worker target is The Vault
desktop on Windows/ConPTY. Add WSL/macOS coverage later when those runtimes are
supported.

- [ ] **Step 1: Create smoke script**

Create `scripts/smoke-vault-collab-managed-worker.ps1`:

```powershell
param(
  [Parameter(Mandatory=$true)][string]$Db,
  [Parameter(Mandatory=$true)][string]$Workspace
)

$ErrorActionPreference = "Stop"

$coordinator = node dist/cli.js register --db $Db --display-name "Smoke Coordinator" --client-type codex --project "the-vault" --workspace-path $Workspace --capability coordinator=true | ConvertFrom-Json
$launch = node dist/cli.js launch-create --db $Db --provider codex --model codex --project "vault-collab" --workspace-path $Workspace --initial-instructions "Smoke worker. Wait for Vault Collab attention." --permission-mode workspace-write --session-uid $coordinator.sessionUid --session-token $coordinator.sessionToken --capability worker=true | ConvertFrom-Json

Write-Output "Created launch request $($launch.launchRequestUid)"
Write-Output "Approve and launch it from The Vault dashboard, then press Enter."
Read-Host

$requests = node dist/cli.js launches --db $Db --status running | ConvertFrom-Json
$running = $requests | Where-Object { $_.launchRequestUid -eq $launch.launchRequestUid } | Select-Object -First 1
if (-not $running -or -not $running.launchedSessionUid) {
  throw "Launch request did not reach running with launchedSessionUid."
}

$ping = node dist/cli.js ping-session --db $Db --target-session-uid $running.launchedSessionUid --actor-session-uid $coordinator.sessionUid --message "Smoke ping from coordinator." | ConvertFrom-Json
if ($ping.delivery.wakeable -ne $true) {
  throw "Expected managed worker to be wakeable."
}

Start-Sleep -Seconds 3
$sessions = node dist/cli.js sessions --db $Db | ConvertFrom-Json
$worker = $sessions | Where-Object { $_.sessionUid -eq $running.launchedSessionUid } | Select-Object -First 1
if (-not $worker.delivery.lastAckEventId) {
  throw "Expected managed worker delivery ack to advance."
}

Write-Output "PASS managed worker launch and ping delivery."
```

- [ ] **Step 2: Add package script**

In root `package.json`:

```json
"smoke:managed-worker": "powershell -ExecutionPolicy Bypass -File scripts/smoke-vault-collab-managed-worker.ps1"
```

- [ ] **Step 3: Run smoke manually**

Run after building Vault Collab:

```bash
npm run build
powershell -ExecutionPolicy Bypass -File scripts/smoke-vault-collab-managed-worker.ps1 -Db C:\path\to\vault-collab.db -Workspace C:\Users\Mini\Desktop\Projects\vault-collab
```

Expected:

```text
PASS managed worker launch and ping delivery.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-vault-collab-managed-worker.ps1 package.json
git commit -m "Add managed worker smoke test"
```

---

## Verification Gates

Do not claim the work is done until all of these pass:

```bash
# Vault Collab
npm run build
npm run test:run -- tests/cli.test.ts tests/mcp-tools.test.ts tests/session.service.test.ts tests/attention-receiver.service.test.ts

# The Vault
pnpm test -- packages/core/src/vault-collab-actions.test.ts packages/core/src/vault-collab-runtime.test.ts packages/desktop/src/vault-collab-view-model.test.ts
pnpm lint
pnpm --filter @the-vault/desktop build

# Manual smoke
powershell -ExecutionPolicy Bypass -File scripts/smoke-vault-collab-managed-worker.ps1 -Db <shared-vault-collab-db> -Workspace <worker-repo>
```

## Best-Way Assessment

This is the best approach because it separates authority correctly:

- Vault Collab is the shared control plane and audit log.
- The manually opened coordinator remains user-driven and explicit.
- The Vault owns worker processes and therefore can safely claim wake delivery.
- Cross-project coordination remains database-level and project-key based.
- The system avoids pretending it can inject into arbitrary external terminals.

The main enhancement beyond the current work is to make managed workers the default path from the dashboard. That gives the user the “no limitations” behavior for agents launched through the product, while still allowing external/manual sessions for coordinator use.

## Self-Review

- Spec coverage:
  - Manual coordinator: Task 1, Task 5, Task 6.
  - Dashboard-launched workers: Task 2, Task 3, Task 4, Task 6.
  - Automatic delivery: Task 4 and Task 8.
  - Cross-project coordination: Task 5 and Task 8.
  - Managed worker launch controls: Task 7.
  - Best use of Vault Collab: Product Contract and Best-Way Assessment.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency:
  - `managed_process`, `deliveryWakeable`, `launchedBy`, `launchRequestUid`, and `sessionUid` match existing Vault Collab naming.
  - New The Vault-only `session_register` action input is intentionally dashboard action-builder scoped.
