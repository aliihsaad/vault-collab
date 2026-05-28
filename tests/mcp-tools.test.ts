import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createVaultCollabMcpTools,
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
  });

  it("exposes the neutral tool names without destructive or role-based commands", () => {
    expect(vaultCollabToolNames).toEqual([
      "vault_collab_register_session",
      "vault_collab_heartbeat_session",
      "vault_collab_update_session_state",
      "vault_collab_list_sessions",
      "vault_collab_disconnect_session",
      "vault_collab_publish_handoff",
      "vault_collab_publish_handoff_with_vault_memory",
      "vault_collab_list_inbox",
      "vault_collab_get_handoff",
      "vault_collab_claim_handoff",
      "vault_collab_update_handoff",
      "vault_collab_request_user_confirmation",
      "vault_collab_resolve_handoff",
      "vault_collab_reopen_handoff",
      "vault_collab_release_handoff"
    ]);
    expect(vaultCollabToolNames.some((name) => /clean|delete|manager|worker|inspector/i.test(name))).toBe(
      false
    );
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
