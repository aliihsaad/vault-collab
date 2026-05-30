# Attention Watch Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded CLI watcher so registered idle agents can notice attention feed items without manual inbox checks.

**Architecture:** Keep delivery passive and token-safe. The watcher repeatedly calls the existing `AttentionService.getSessionAttention()` and returns recommended manual actions; it never claims handoffs, changes session state, or runs commands.

**Tech Stack:** TypeScript, Vitest, existing SQLite-backed services and CLI.

---

### Task 1: Watcher CLI Contract

**Files:**
- Modify: `tests/cli.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing CLI tests**

Add tests that start `watch-attention`, publish a targeted handoff while it is polling, and expect a bounded result containing the handoff plus a manual `claim` instruction. Add a second test proving a working session is not auto-claimed or interrupted.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run test:run -- tests/cli.test.ts`

Expected: fail with `Unknown command: watch-attention`.

- [ ] **Step 3: Implement minimal watcher**

Add `watch-attention` to `src/cli.ts`. It should accept `--session-uid`, optional `--since-event-id`, `--interval-ms`, `--timeout-ms`, and `--no-current-handoffs`, loop until attention items are present or timeout expires, and return JSON with `timedOut`, `attention`, and `recommendedActions`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm run test:run -- tests/cli.test.ts`

Expected: pass.

### Task 2: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `src/agent-guide.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Document watcher semantics**

State that `ping-session` remains a passive event unless an agent runs `attention` or `watch-attention`. Document that the watcher surfaces notices and manual actions only.

- [ ] **Step 2: Verify**

Run: `npm run test:run -- tests/cli.test.ts tests/mcp-tools.test.ts tests/attention.service.test.ts`

Run: `npm run build`

Expected: both pass.
