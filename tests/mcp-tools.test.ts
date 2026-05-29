import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVaultCollabMcpTools,
  vaultCollabToolDefinitions,
  vaultCollabToolNames,
  type VaultCollabToolResult
} from "../src/mcp/tools.js";
import type { VaultMemoryClient, VaultMemorySaveInput } from "../src/services/vault-link.service.js";

function structured<T>(result: VaultCollabToolResult): T {
  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(result.content[0]).toMatchObject({
    type: "text"
  });
  return result.structuredContent.result as T;
}

function schemaKeys(toolName: string): string[] {
  const definition = vaultCollabToolDefinitions.find((tool) => tool.name === toolName);
  expect(definition).toBeDefined();
  return Object.keys(definition?.inputSchema.shape ?? {});
}

describe("Vault Collab MCP tools", () => {
  let dbPath: string;
  let cwd: string;
  let closeTools: (() => void) | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "vault-collab-mcp-"));
    dbPath = join(cwd, "collab.db");
  });

  afterEach(() => {
    closeTools?.();
    closeTools = undefined;
    vi.useRealTimers();
  });

  it("exposes the neutral tool names without destructive or role-based commands", () => {
    expect(vaultCollabToolNames).toEqual([
      "vault_collab_register_session",
      "vault_collab_heartbeat_session",
      "vault_collab_update_session_state",
      "vault_collab_list_sessions",
      "vault_collab_disconnect_session",
      "vault_collab_list_agent_roles",
      "vault_collab_upsert_agent_profile",
      "vault_collab_list_agent_profiles",
      "vault_collab_publish_handoff",
      "vault_collab_publish_handoff_with_vault_memory",
      "vault_collab_link_vault_memory",
      "vault_collab_list_inbox",
      "vault_collab_get_handoff",
      "vault_collab_get_handoff_detail",
      "vault_collab_update_handoff_metadata",
      "vault_collab_create_discussion_thread",
      "vault_collab_add_discussion_message",
      "vault_collab_list_discussion_threads",
      "vault_collab_get_discussion_thread",
      "vault_collab_list_events",
      "vault_collab_claim_handoff",
      "vault_collab_update_handoff",
      "vault_collab_request_user_confirmation",
      "vault_collab_resolve_handoff",
      "vault_collab_reopen_handoff",
      "vault_collab_release_handoff"
    ]);
    expect(
      vaultCollabToolNames.some((name) =>
        /clean|delete|manager|worker|inspector|auto_claim|auto_execute|assign|interrupt|run_handoff|execute_handoff/i.test(
          name
        )
      )
    ).toBe(false);
  });

  it("documents register session inputs including capabilities and aliases", () => {
    const registerKeys = schemaKeys("vault_collab_register_session");

    expect(registerKeys).toEqual(
      expect.arrayContaining([
        "displayName",
        "display_name",
        "clientType",
        "client_type",
        "project",
        "workspacePath",
        "workspace_path",
        "agentUid",
        "agent_uid",
        "capabilities"
      ])
    );
  });

  it("does not expose empty passthrough-only schemas for any MCP tool", () => {
    for (const definition of vaultCollabToolDefinitions) {
      expect(Object.keys(definition.inputSchema.shape), definition.name).not.toHaveLength(0);
    }
  });

  it("automatically refreshes registered MCP sessions without heartbeat event spam", async () => {
    vi.useFakeTimers();
    let now = new Date("2026-05-28T10:00:00.000Z");
    const tools = createVaultCollabMcpTools({
      dbPath,
      clock: () => now,
      heartbeatIntervalMs: 1000
    });
    closeTools = tools.close;

    const session = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Codex",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );

    now = new Date("2026-05-28T10:00:01.000Z");
    await vi.advanceTimersByTimeAsync(1000);
    now = new Date("2026-05-28T10:00:02.000Z");
    await vi.advanceTimersByTimeAsync(1000);

    const sessions = structured<Array<{ sessionUid: string; lastHeartbeatAt: string }>>(
      await tools.callTool("vault_collab_list_sessions", {
        project: "Vault Collab"
      })
    );
    const events = structured<Array<{ eventType: string }>>(
      await tools.callTool("vault_collab_list_events", {
        sessionUid: session.sessionUid
      })
    );

    expect(sessions[0]).toMatchObject({
      sessionUid: session.sessionUid,
      lastHeartbeatAt: "2026-05-28T10:00:02.000Z"
    });
    expect(events.map((event) => event.eventType)).toEqual(["session.registered"]);
  });

  it("runs a provider-neutral agent, queue, and discussion workflow through MCP tools", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const roles = structured<Array<{ role: string }>>(
      await tools.callTool("vault_collab_list_agent_roles", {})
    );
    expect(roles.map((role) => role.role)).toEqual([
      "coordinator",
      "implementer",
      "reviewer",
      "sweeper",
      "observer"
    ]);

    const reviewer = structured<{ agentUid: string; clientType: string }>(
      await tools.callTool("vault_collab_upsert_agent_profile", {
        stableName: "claude-reviewer",
        displayName: "Claude Reviewer",
        role: "reviewer",
        clientType: "claude-code",
        project: "Vault Collab",
        capabilities: {
          review: true
        }
      })
    );
    const implementer = structured<{ agentUid: string; clientType: string }>(
      await tools.callTool("vault_collab_upsert_agent_profile", {
        stable_name: "opencode-implementer",
        display_name: "OpenCode Implementer",
        role: "implementer",
        client_type: "opencode",
        project: "Vault Collab"
      })
    );

    expect(reviewer).toMatchObject({
      clientType: "claude-code"
    });
    expect(implementer).toMatchObject({
      clientType: "opencode"
    });

    const claude = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Claude Code",
        clientType: "claude-code",
        project: "Vault Collab",
        workspacePath: cwd,
        agentUid: reviewer.agentUid
      })
    );
    const opencode = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "OpenCode",
        clientType: "opencode",
        project: "Vault Collab",
        workspacePath: cwd,
        agent_uid: implementer.agentUid
      })
    );

    const published = structured<{
      handoffUid: string;
      queueKey: string;
      labels: string[];
      queuePosition: number;
    }>(
      await tools.callTool("vault_collab_publish_handoff", {
        shortPrompt: "Discuss MCP contract",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab",
        sourceSessionUid: claude.sessionUid,
        queueKey: "phase-1",
        labels: ["mcp", "discussion"],
        queuePosition: 500
      })
    );

    expect(published).toMatchObject({
      queueKey: "phase-1",
      labels: ["mcp", "discussion"],
      queuePosition: 500
    });

    const metadata = structured<{ labels: string[]; dependsOnHandoffUid: string }>(
      await tools.callTool("vault_collab_update_handoff_metadata", {
        handoffUid: published.handoffUid,
        sessionUid: claude.sessionUid,
        sessionToken: claude.sessionToken,
        labels: ["mcp", "reviewed"],
        dependsOnHandoffUid: "vc_handoff_previous"
      })
    );
    expect(metadata).toMatchObject({
      labels: ["mcp", "reviewed"],
      dependsOnHandoffUid: "vc_handoff_previous"
    });

    const thread = structured<{ threadUid: string; messageCount: number }>(
      await tools.callTool("vault_collab_create_discussion_thread", {
        project: "Vault Collab",
        handoffUid: published.handoffUid,
        title: "MCP contract discussion",
        sessionUid: claude.sessionUid,
        sessionToken: claude.sessionToken
      })
    );
    expect(thread.messageCount).toBe(0);

    await tools.callTool("vault_collab_add_discussion_message", {
      threadUid: thread.threadUid,
      sessionUid: opencode.sessionUid,
      sessionToken: opencode.sessionToken,
      messageType: "proposal",
      body: "Keep this provider-neutral."
    });

    const threadDetail = structured<{
      threadUid: string;
      messages: Array<{ sessionUid: string; agentUid: string | null; messageType: string }>;
    }>(
      await tools.callTool("vault_collab_get_discussion_thread", {
        threadUid: thread.threadUid
      })
    );
    expect(threadDetail.messages).toEqual([
      expect.objectContaining({
        sessionUid: opencode.sessionUid,
        agentUid: implementer.agentUid,
        messageType: "proposal"
      })
    ]);

    const detail = structured<{
      discussionThreads: Array<{ threadUid: string; messageCount: number }>;
    }>(
      await tools.callTool("vault_collab_get_handoff_detail", {
        handoffUid: published.handoffUid
      })
    );
    expect(detail.discussionThreads).toEqual([
      expect.objectContaining({
        threadUid: thread.threadUid,
        messageCount: 1
      })
    ]);

    const badToken = "secret-token-that-must-not-leak";
    const failed = await tools.callTool("vault_collab_add_discussion_message", {
      threadUid: thread.threadUid,
      sessionUid: opencode.sessionUid,
      sessionToken: badToken,
      messageType: "concern",
      body: "This should fail."
    });

    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain(badToken);
    expect(JSON.stringify(threadDetail)).not.toContain(claude.sessionToken);
    expect(JSON.stringify(threadDetail)).not.toContain(opencode.sessionToken);
  });

  it("stops automatic heartbeat after explicit disconnect", async () => {
    vi.useFakeTimers();
    let now = new Date("2026-05-28T10:00:00.000Z");
    const tools = createVaultCollabMcpTools({
      dbPath,
      clock: () => now,
      heartbeatIntervalMs: 1000
    });
    closeTools = tools.close;

    const session = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Claude Code",
        clientType: "claude-code",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    expect(vi.getTimerCount()).toBe(1);

    now = new Date("2026-05-28T10:00:01.000Z");
    await vi.advanceTimersByTimeAsync(1000);
    await tools.callTool("vault_collab_disconnect_session", {
      sessionUid: session.sessionUid,
      sessionToken: session.sessionToken
    });

    const disconnectedAt = structured<Array<{ lastHeartbeatAt: string }>>(
      await tools.callTool("vault_collab_list_sessions", {
        project: "Vault Collab"
      })
    )[0].lastHeartbeatAt;

    now = new Date("2026-05-28T10:00:02.000Z");
    await vi.advanceTimersByTimeAsync(1000);

    const sessions = structured<Array<{ status: string; lastHeartbeatAt: string }>>(
      await tools.callTool("vault_collab_list_sessions", {
        project: "Vault Collab"
      })
    );

    expect(vi.getTimerCount()).toBe(0);
    expect(sessions[0]).toMatchObject({
      status: "disconnected",
      lastHeartbeatAt: disconnectedAt
    });
  });

  it("clears automatic heartbeat timers when tools close", async () => {
    vi.useFakeTimers();
    const tools = createVaultCollabMcpTools({
      dbPath,
      heartbeatIntervalMs: 1000
    });

    await tools.callTool("vault_collab_register_session", {
      displayName: "Claude Desktop",
      clientType: "claude-desktop",
      project: "Vault Collab",
      workspacePath: cwd
    });

    expect(vi.getTimerCount()).toBe(1);

    tools.close();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the session and handoff lifecycle through MCP-style tool calls", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const codex = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Codex",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        capabilities: {
          handoffs: true
        }
      })
    );
    const claude = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Claude Desktop",
        clientType: "claude-desktop",
        project: "Vault Collab",
        workspacePath: cwd,
        capabilities: {
          handoffs: true
        }
      })
    );

    const sessions = structured<Array<{ sessionUid: string; sessionToken?: string }>>(
      await tools.callTool("vault_collab_list_sessions", {
        project: "Vault Collab"
      })
    );

    expect(sessions.map((session) => session.sessionUid)).toEqual([
      codex.sessionUid,
      claude.sessionUid
    ]);
    expect(sessions[0]).not.toHaveProperty("sessionToken");

    const published = structured<{ handoffUid: string; status: string }>(
      await tools.callTool("vault_collab_publish_handoff", {
        shortPrompt: "Wire the neutral MCP tool layer.",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab",
        sourceSessionUid: codex.sessionUid,
        relatedFiles: ["src/mcp/tools.ts", "tests/mcp-tools.test.ts"],
        priority: "high",
        urgent: true
      })
    );

    expect(published.status).toBe("available");

    const linked = structured<{ vaultMemoryUid: string | null }>(
      await tools.callTool("vault_collab_link_vault_memory", {
        handoffUid: published.handoffUid,
        sessionUid: codex.sessionUid,
        sessionToken: codex.sessionToken,
        vaultMemoryUid: "vm_mcp_existing_brief"
      })
    );

    expect(linked.vaultMemoryUid).toBe("vm_mcp_existing_brief");

    const claimed = structured<{ status: string; claimedBySessionUid: string }>(
      await tools.callTool("vault_collab_claim_handoff", {
        handoffUid: published.handoffUid,
        sessionUid: claude.sessionUid,
        sessionToken: claude.sessionToken
      })
    );

    expect(claimed).toMatchObject({
      status: "claimed",
      claimedBySessionUid: claude.sessionUid
    });

    const awaitingUser = structured<{ status: string; progressNote: string }>(
      await tools.callTool("vault_collab_request_user_confirmation", {
        handoffUid: published.handoffUid,
        sessionUid: claude.sessionUid,
        sessionToken: claude.sessionToken,
        question: "Should this be kept on the current branch?"
      })
    );

    expect(awaitingUser).toMatchObject({
      status: "awaiting_user",
      progressNote: "Should this be kept on the current branch?"
    });

    const released = structured<{ status: string; claimedBySessionUid: string | null }>(
      await tools.callTool("vault_collab_release_handoff", {
        handoffUid: published.handoffUid,
        sessionUid: claude.sessionUid,
        sessionToken: claude.sessionToken
      })
    );

    expect(released).toMatchObject({
      status: "available",
      claimedBySessionUid: null
    });

    await tools.callTool("vault_collab_claim_handoff", {
      handoffUid: published.handoffUid,
      sessionUid: claude.sessionUid,
      sessionToken: claude.sessionToken
    });
    const updated = structured<{ status: string; progressNote: string }>(
      await tools.callTool("vault_collab_update_handoff", {
        handoffUid: published.handoffUid,
        sessionUid: claude.sessionUid,
        sessionToken: claude.sessionToken,
        status: "in_progress",
        progressNote: "MCP registry test is green-driving the implementation."
      })
    );

    expect(updated).toMatchObject({
      status: "in_progress",
      progressNote: "MCP registry test is green-driving the implementation."
    });

    const resolved = structured<{ status: string; resolutionSummary: string }>(
      await tools.callTool("vault_collab_resolve_handoff", {
        handoffUid: published.handoffUid,
        sessionUid: claude.sessionUid,
        sessionToken: claude.sessionToken,
        summary: "MCP tool layer verified."
      })
    );

    expect(resolved).toMatchObject({
      status: "resolved",
      resolutionSummary: "MCP tool layer verified."
    });

    const reopened = structured<{ status: string; claimedBySessionUid: string | null }>(
      await tools.callTool("vault_collab_reopen_handoff", {
        handoffUid: published.handoffUid,
        reason: "Need another MCP client smoke run.",
        status: "available"
      })
    );

    expect(reopened).toMatchObject({
      status: "available",
      claimedBySessionUid: null
    });

    const got = structured<{ handoffUid: string; status: string }>(
      await tools.callTool("vault_collab_get_handoff", {
        handoffUid: published.handoffUid
      })
    );

    expect(got).toMatchObject({
      handoffUid: published.handoffUid,
      status: "available"
    });

    const detail = structured<{
      handoff: { handoffUid: string; status: string };
      events: Array<{ eventType: string }>;
      sessions: {
        sourceSession: { sessionUid: string; sessionToken?: string } | null;
        suggestedSession: { sessionUid: string; sessionToken?: string } | null;
        claimedBySession: { sessionUid: string; sessionToken?: string } | null;
      };
    }>(
      await tools.callTool("vault_collab_get_handoff_detail", {
        handoffUid: published.handoffUid
      })
    );

    expect(detail.handoff).toMatchObject({
      handoffUid: published.handoffUid,
      status: "available"
    });
    expect(detail.events.map((event) => event.eventType)).toEqual([
      "handoff.published",
      "handoff.vault_memory_linked",
      "handoff.claimed",
      "handoff.user_confirmation_requested",
      "handoff.released",
      "handoff.claimed",
      "handoff.updated",
      "handoff.resolved",
      "handoff.reopened"
    ]);
    expect(detail.sessions.sourceSession).toMatchObject({
      sessionUid: codex.sessionUid
    });
    expect(detail.sessions.suggestedSession).toBeNull();
    expect(detail.sessions.claimedBySession).toBeNull();
    expect(JSON.stringify(detail)).not.toContain(codex.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(claude.sessionToken);

    const handoffEvents = structured<Array<{ eventType: string; sessionUid: string | null }>>(
      await tools.callTool("vault_collab_list_events", {
        handoffUid: published.handoffUid
      })
    );

    expect(handoffEvents.map((event) => event.eventType)).toEqual([
      "handoff.published",
      "handoff.vault_memory_linked",
      "handoff.claimed",
      "handoff.user_confirmation_requested",
      "handoff.released",
      "handoff.claimed",
      "handoff.updated",
      "handoff.resolved",
      "handoff.reopened"
    ]);
    expect(handoffEvents[1]).toMatchObject({
      sessionUid: codex.sessionUid
    });

    const claudeEvents = structured<Array<{ eventType: string; sessionUid: string | null }>>(
      await tools.callTool("vault_collab_list_events", {
        sessionUid: claude.sessionUid
      })
    );

    expect(claudeEvents.map((event) => event.eventType)).toEqual([
      "session.registered",
      "handoff.claimed",
      "handoff.user_confirmation_requested",
      "handoff.released",
      "handoff.claimed",
      "handoff.updated",
      "handoff.resolved"
    ]);
  });

  it("publishes a Vault-linked handoff through the optional MCP tool", async () => {
    const saves: VaultMemorySaveInput[] = [];
    const vaultMemoryClient: VaultMemoryClient = {
      saveMemory: async (input) => {
        saves.push(input);
        return { itemUid: "vm_mcp_linked_brief" };
      }
    };
    const tools = createVaultCollabMcpTools({ dbPath, vaultMemoryClient });
    closeTools = tools.close;

    const codex = structured<{ sessionUid: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Codex",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );

    const linked = structured<{ handoffUid: string; vaultMemoryUid: string | null }>(
      await tools.callTool("vault_collab_publish_handoff_with_vault_memory", {
        shortPrompt: "Publish from MCP with a full Vault brief.",
        fullBrief: "This full brief is saved to Vault memory before the handoff appears locally.",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab",
        sourceSessionUid: codex.sessionUid,
        relatedFiles: ["src/mcp/tools.ts"],
        vaultTitle: "Handoff: MCP linked publish",
        vaultSubject: "Vault Collab MCP linked publish",
        keywords: ["vault-collab", "mcp", "vault-link"],
        tags: ["handoff", "mcp"],
        nextSteps: ["Claim this from another MCP client"]
      })
    );

    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      title: "Handoff: MCP linked publish",
      project: "Vault Collab",
      memoryType: "handoff",
      subject: "Vault Collab MCP linked publish",
      summary: "Publish from MCP with a full Vault brief.",
      sourceApp: "vault-collab"
    });
    expect(saves[0].content).toContain(
      "This full brief is saved to Vault memory before the handoff appears locally."
    );
    expect(linked).toMatchObject({
      vaultMemoryUid: "vm_mcp_linked_brief"
    });

    const got = structured<{ vaultMemoryUid: string | null }>(
      await tools.callTool("vault_collab_get_handoff", {
        handoffUid: linked.handoffUid
      })
    );

    expect(got.vaultMemoryUid).toBe("vm_mcp_linked_brief");
  });
});
