import { createHmac } from "node:crypto";
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
import { createCollabDatabase } from "../src/database/connection.js";
import { coreRoleProfileIds } from "../src/types.js";
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

function schemaField(toolName: string, key: string): { safeParse: (value: unknown) => { success: boolean } } {
  const definition = vaultCollabToolDefinitions.find((tool) => tool.name === toolName);
  expect(definition).toBeDefined();
  const field = definition?.inputSchema.shape[key];
  expect(field).toBeDefined();
  return field as { safeParse: (value: unknown) => { success: boolean } };
}

function toolDescription(toolName: string): string {
  const definition = vaultCollabToolDefinitions.find((tool) => tool.name === toolName);
  expect(definition).toBeDefined();
  return definition?.description ?? "";
}

const discoveryTypedPayload = {
  schema_version: "vault_collab.discovery_handoff.v1",
  handoff_type: "qa",
  objective: "Verify typed handoff payload support through MCP.",
  scope: {
    include: ["vault_collab_publish_handoff typed_payload"],
    exclude: ["short_prompt removal"],
    workspace: "Vault Collab",
    write_policy: "workspace_write"
  },
  context_refs: {
    vault_memory_uids: ["vm_7QnQrGsiJo3nu3sz"],
    related_files: ["src/mcp/tools.ts"],
    graph_nodes: [],
    discussion_threads: []
  },
  evidence_contract: {
    method: "MCP tool call test.",
    required_sources: ["tests/mcp-tools.test.ts"],
    confidence_required: "high",
    separate_fact_inference: true
  },
  task_steps: [
    {
      id: "call_publish_handoff",
      description: "Publish a handoff with typed_payload.",
      required: true
    }
  ],
  acceptance_criteria: ["typed payload round-trips through MCP"],
  deliverables: {
    vault_memory: {
      memory_type: "handoff",
      title: "QA handoff",
      tags: ["qa"]
    },
    publish_followup_handoff: false
  },
  verification: {
    required: ["MCP call returns typedPayload"],
    not_required: []
  },
  risk_controls: {
    permission_required_for: ["network install"],
    secrets_policy: "never expose tokens"
  },
  completion: {
    resolution_summary_required: true,
    next_handoff_labels: ["qa-pass"]
  },
  suggested_executor: {
    client_type: "codex",
    role: "qa-evaluator",
    capabilities: ["mcp", "testing"]
  }
};

const adapterSecret = "phase-7-adapter-secret";

function validSessionSnapshot(
  sessionUid: string,
  workspacePath: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: "vault_collab.session.v1",
    adapterId: "codex-local:test",
    sessionUid,
    project: "Vault Collab",
    workspace: {
      path: workspacePath,
      projectKey: "vault-collab"
    },
    state: "working",
    context: {
      model: "gpt-5-codex",
      provider: "codex",
      tokensUsed: 86000,
      tokensRemaining: 14000,
      compactionRisk: "medium"
    },
    active_handoffs: [
      {
        handoffUid: "vc_handoff_phase_7",
        status: "in_progress",
        progressNote: "Implementing report_session.",
        claimedAt: "2026-06-04T09:52:45.000Z"
      }
    ],
    progress: {
      currentTask: "Implement Phase 7",
      percentComplete: 40,
      blockers: []
    },
    cost: {
      estimatedUSD: 1.25,
      tokensTotal: 100000
    },
    risk: {
      level: "low",
      reasons: []
    },
    tool_grants: [
      {
        toolName: "vault_collab_report_session",
        scope: "coordination_write",
        grantedAt: "2026-06-04T09:52:45.000Z"
      }
    ],
    capabilities: {
      canMutateHandoffs: false,
      canPublishHandoffs: false,
      canSendMessages: true,
      adapterType: "adapter_backed"
    },
    sync_cursor: {
      lastEventId: 5772,
      lastHeartbeatAt: "2026-06-04T09:52:45.000Z"
    },
    ...overrides
  };
}

function deriveAdapterToken(secret: string, sessionUid: string, adapterId: string): string {
  return createHmac("sha256", secret)
    .update(`${sessionUid}\0${adapterId}`)
    .digest("base64url");
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
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("exposes the neutral tool names without raw-delete or role-based commands", () => {
    expect(vaultCollabToolNames).toEqual([
      "vault_collab_get_agent_guide",
      "vault_collab_register_session",
      "vault_collab_heartbeat_session",
      "vault_collab_acknowledge_attention",
      "vault_collab_update_session_state",
      "vault_collab_ping_session",
      "vault_collab_request_session_permission",
      "vault_collab_list_sessions",
      "vault_collab_get_session_attention",
      "vault_collab_receive",
      "vault_collab_list_attention_delivery_attempts",
      "vault_collab_rename_session",
      "vault_collab_close_session",
      "vault_collab_cleanup_sessions",
      "vault_collab_disconnect_session",
      "vault_collab_create_launch_request",
      "vault_collab_list_launch_requests",
      "vault_collab_get_launch_request",
      "vault_collab_get_launch_request_detail",
      "vault_collab_get_launch_request_actions",
      "vault_collab_approve_launch_request",
      "vault_collab_reject_launch_request",
      "vault_collab_cancel_launch_request",
      "vault_collab_mark_launch_request_launching",
      "vault_collab_mark_launch_request_running",
      "vault_collab_mark_launch_request_stopped",
      "vault_collab_fail_launch_request",
      "vault_collab_list_agent_roles",
      "vault_collab_upsert_agent_profile",
      "vault_collab_list_agent_profiles",
      "vault_collab_publish_handoff",
      "vault_collab_publish_handoff_with_vault_memory",
      "vault_collab_link_vault_memory",
      "vault_collab_list_inbox",
      "vault_collab_get_handoff",
      "vault_collab_get_handoff_detail",
      "vault_collab_get_handoff_actions",
      "vault_collab_update_handoff_metadata",
      "vault_collab_create_discussion_thread",
      "vault_collab_create_handoff_discussion_thread",
      "vault_collab_add_discussion_message",
      "vault_collab_list_discussion_threads",
      "vault_collab_get_discussion_thread",
      "vault_collab_list_events",
      "vault_collab_list_event_types",
      "vault_collab_list_policy_packs",
      "vault_collab_get_policy_pack",
      "vault_collab_activate_policy_pack",
      "vault_collab_deactivate_policy_pack",
      "vault_collab_evaluate_policy",
      "vault_collab_report_runtime_metrics",
      "vault_collab_report_session",
      "vault_collab_detect_stalled_handoffs",
      "vault_collab_sweep_expired_handoffs",
      "vault_collab_claim_handoff",
      "vault_collab_update_handoff",
      "vault_collab_request_user_confirmation",
      "vault_collab_request_handoff_permission",
      "vault_collab_resolve_handoff",
      "vault_collab_recover_handoff",
      "vault_collab_reopen_handoff",
      "vault_collab_release_handoff"
    ]);
    expect(
      vaultCollabToolNames.some((name) =>
        /delete|manager|worker|inspector|auto_claim|auto_execute|assign|interrupt|run_handoff|execute_handoff/i.test(
          name
        )
      )
    ).toBe(false);
  });

  it("hides Vault-linked publish when no Vault memory client is configured", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    expect(tools.definitions.map((tool) => tool.name)).not.toContain(
      "vault_collab_publish_handoff_with_vault_memory"
    );

    const result = await tools.callTool("vault_collab_publish_handoff_with_vault_memory", {
      shortPrompt: "Needs memory-backed publish.",
      fullBrief: "Save this to Vault before publishing the handoff.",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const message = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(message).toMatch(/not available/i);
    expect(message).toMatch(/vault_save_memory/i);
    expect(message).toMatch(/vault_collab_publish_handoff/i);
    expect(message).toMatch(/vaultMemoryUid/i);
  });

  it("returns a provider-neutral agent operating guide through MCP", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const guide = structured<{
      title: string;
      clientType: string | null;
      project: string | null;
      projectKey: string | null;
      loop: string[];
      attentionItems: Record<string, string>;
      safetyRules: string[];
    }>(
      await tools.callTool("vault_collab_get_agent_guide", {
        clientType: "claude-code",
        project: "Vault Collab"
      })
    );

    const loopText = guide.loop.join("\n");
    const safetyText = guide.safetyRules.join("\n");

    expect(guide).toMatchObject({
      title: "Vault Collab provider-neutral agent operating guide",
      clientType: "claude-code",
      project: "Vault Collab",
      projectKey: "vault-collab"
    });
    expect(loopText).toMatch(/vault_collab_register_session/);
    expect(loopText).toMatch(/vault_collab_get_session_attention/);
    expect(loopText).toMatch(/watch-attention/);
    expect(loopText).toMatch(/receive --wait|vault_collab_receive/);
    expect(loopText).toMatch(/pull|drain/i);
    expect(loopText).toMatch(/vault_collab_get_handoff_detail/);
    expect(loopText).toMatch(/vault_collab_claim_handoff/);
    expect(loopText).toMatch(/coordinator/i);
    expect(loopText).toMatch(/managed/i);
    expect(loopText).toMatch(/worker/i);
    expect(guide.attentionItems).toHaveProperty("session_ping");
    expect(guide.attentionItems).toHaveProperty("launch_request");
    expect(safetyText).toMatch(/Do not auto-claim/i);
    expect(safetyText).toMatch(/Do not use vault_collab_list_inbox alone/i);
    expect(safetyText).toMatch(/manual coordinator/i);
    expect(safetyText).toMatch(/worker wakeable/i);
    expect(JSON.stringify(guide)).not.toContain("sessionToken");
  });

  it("lists the stable event type registry through MCP", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const definitions = structured<
      Array<{
        canonicalName: string;
        namespace: string;
        payloadShape: Record<string, unknown>;
        tokenSafety: { forbiddenPayloadKeys: string[] };
        attention: { roleProfileIds: string[]; itemKind: string | null };
      }>
    >(await tools.callTool("vault_collab_list_event_types", {}));

    expect(definitions.map((definition) => definition.canonicalName)).toEqual(
      expect.arrayContaining([
        "tool.call_before",
        "tool.call_after",
        "tool.call_failure",
        "security.finding",
        "context.limit_warning",
        "cost.threshold_warning",
        "session.cleanup",
        "loop.stall_detected"
      ])
    );
    expect(definitions.find((definition) => definition.canonicalName === "session.cleanup"))
      .toMatchObject({
        namespace: "session",
        payloadShape: {
          deletedSessionCount: "number"
        },
        attention: {
          itemKind: null,
          roleProfileIds: []
        }
      });
    expect(definitions.find((definition) => definition.canonicalName === "loop.stall_detected"))
      .toMatchObject({
        namespace: "loop",
        attention: {
          itemKind: "loop_stall",
          roleProfileIds: ["coordinator", "runtime-loop-operator"]
        }
      });
    expect(
      definitions.every((definition) =>
        definition.tokenSafety.forbiddenPayloadKeys.includes("sessionToken")
      )
    ).toBe(true);
  });

  it("publishes token-safe before after and failure events for MCP tool calls", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const session = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Audited MCP caller",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const secretToken = "owner-token-that-must-not-leak";
    const failed = await tools.callTool("vault_collab_heartbeat_session", {
      sessionUid: session.sessionUid,
      sessionToken: secretToken
    });

    expect(failed.isError).toBe(true);

    const beforeEvents = structured<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await tools.callTool("vault_collab_list_events", {
        eventType: "tool.call_before"
      })
    );
    const afterEvents = structured<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await tools.callTool("vault_collab_list_events", {
        eventType: "tool.call_after"
      })
    );
    const failureEvents = structured<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await tools.callTool("vault_collab_list_events", {
        eventType: "tool.call_failure"
      })
    );

    expect(beforeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "tool.call_before",
          payload: expect.objectContaining({
            toolName: "vault_collab_register_session",
            project: "Vault Collab",
            redactedArgumentKeys: []
          })
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            toolName: "vault_collab_heartbeat_session",
            actorSessionUid: session.sessionUid,
            redactedArgumentKeys: ["sessionToken"]
          })
        })
      ])
    );
    expect(afterEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "tool.call_after",
          payload: expect.objectContaining({
            toolName: "vault_collab_register_session",
            ok: true
          })
        })
      ])
    );
    expect(failureEvents).toEqual([
      expect.objectContaining({
        eventType: "tool.call_failure",
        payload: expect.objectContaining({
          toolName: "vault_collab_heartbeat_session",
          actorSessionUid: session.sessionUid,
          ok: false,
          errorClass: "Error"
        })
      })
    ]);
    expect(JSON.stringify(beforeEvents)).not.toContain(session.sessionToken);
    expect(JSON.stringify(beforeEvents)).not.toContain(secretToken);
    expect(JSON.stringify(afterEvents)).not.toContain(session.sessionToken);
    expect(JSON.stringify(failureEvents)).not.toContain(secretToken);
  });

  it("exposes policy pack administration and dry-run evaluation tools", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    expect(tools.definitions.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "vault_collab_list_policy_packs",
        "vault_collab_get_policy_pack",
        "vault_collab_activate_policy_pack",
        "vault_collab_deactivate_policy_pack",
        "vault_collab_evaluate_policy"
      ])
    );

    const admin = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Policy Admin",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        capabilities: {
          policyAdmin: true
        }
      })
    );
    const packs = structured<
      Array<{ uid: string; name: string; active: boolean; isBuiltin: boolean; ruleCount: number }>
    >(await tools.callTool("vault_collab_list_policy_packs", {}));

    expect(packs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "core-safety",
          active: true,
          isBuiltin: true,
          ruleCount: expect.any(Number)
        })
      ])
    );

    const coreSafety = structured<{ name: string; rules: Array<{ uid: string }> }>(
      await tools.callTool("vault_collab_get_policy_pack", {
        name: "core-safety"
      })
    );
    expect(coreSafety.rules.map((rule) => rule.uid)).toContain(
      "core-safety.block-token-exposure"
    );

    const denied = structured<{ allowed: boolean; decision: string }>(
      await tools.callTool("vault_collab_evaluate_policy", {
        actionType: "handoff.publish",
        payload: {
          sessionToken: "hypothetical-token"
        }
      })
    );
    expect(denied).toMatchObject({
      allowed: false,
      decision: "deny"
    });

    const deactivated = structured<{ name: string; active: boolean }>(
      await tools.callTool("vault_collab_deactivate_policy_pack", {
        name: "core-safety",
        sessionUid: admin.sessionUid,
        sessionToken: admin.sessionToken
      })
    );
    expect(deactivated).toMatchObject({
      name: "core-safety",
      active: false
    });

    const allowed = structured<{ allowed: boolean; decision: string }>(
      await tools.callTool("vault_collab_evaluate_policy", {
        actionType: "handoff.publish",
        payload: {
          sessionToken: "hypothetical-token"
        }
      })
    );
    expect(allowed).toMatchObject({
      allowed: true,
      decision: "allow"
    });

    const activated = structured<{ name: string; active: boolean }>(
      await tools.callTool("vault_collab_activate_policy_pack", {
        name: "core-safety",
        sessionUid: admin.sessionUid,
        sessionToken: admin.sessionToken
      })
    );
    expect(activated).toMatchObject({
      name: "core-safety",
      active: true
    });
  });

  it("runs the launch-request broker lifecycle through MCP without spawning processes", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const requester = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Operator",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        capabilities: {
          launchRequests: true
        }
      })
    );
    const approver = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Approver",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        capabilities: {
          launchApproval: true
        }
      })
    );
    const broker = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Local Broker",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        capabilities: {
          launchBroker: true
        }
      })
    );

    const request = structured<{
      launchRequestUid: string;
      status: string;
      provider: string;
      initialInstructions: string;
      sessionToken?: string;
    }>(
      await tools.callTool("vault_collab_create_launch_request", {
        sessionUid: requester.sessionUid,
        sessionToken: requester.sessionToken,
        provider: "codex",
        model: "gpt-5-codex",
        effortLevel: "high",
        project: "Vault Collab",
        workspacePath: cwd,
        role: "implementer",
        initialInstructions: "Implement the broker foundation.",
        permissionMode: "workspace-write",
        commandPreview: "codex --model gpt-5-codex",
        requestedCapabilities: ["filesystem-write"],
        approvalPolicyVersion: "cockpit-v2.0",
        metadata: {
          source: "mcp-test"
        }
      })
    );

    expect(request).toMatchObject({
      status: "requested",
      provider: "codex",
      initialInstructions: "Implement the broker foundation."
    });
    expect(request).not.toHaveProperty("sessionToken");

    const list = structured<Array<{ launchRequestUid: string }>>(
      await tools.callTool("vault_collab_list_launch_requests", {
        project: "vault-collab",
        status: "requested"
      })
    );
    expect(list.map((item) => item.launchRequestUid)).toEqual([request.launchRequestUid]);

    const approverActions = structured<{
      launchRequest: { launchRequestUid: string };
      actions: Array<{ kind: string; enabled: boolean; toolName: string }>;
    }>(
      await tools.callTool("vault_collab_get_launch_request_actions", {
        launchRequestUid: request.launchRequestUid,
        sessionUid: approver.sessionUid,
        sessionToken: approver.sessionToken
      })
    );
    expect(approverActions.launchRequest.launchRequestUid).toBe(request.launchRequestUid);
    expect(approverActions.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "approve",
          enabled: true,
          toolName: "vault_collab_approve_launch_request"
        })
      ])
    );
    expect(JSON.stringify(approverActions)).not.toContain(approver.sessionToken);

    const denied = await tools.callTool("vault_collab_approve_launch_request", {
      launchRequestUid: request.launchRequestUid,
      sessionUid: requester.sessionUid,
      sessionToken: requester.sessionToken,
      detail: "Requester should not self-approve."
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain(requester.sessionToken);

    const approved = structured<{ status: string; approvedBySessionUid: string }>(
      await tools.callTool("vault_collab_approve_launch_request", {
        launchRequestUid: request.launchRequestUid,
        sessionUid: approver.sessionUid,
        sessionToken: approver.sessionToken,
        detail: "Approved for broker pickup."
      })
    );
    expect(approved).toMatchObject({
      status: "approved",
      approvedBySessionUid: approver.sessionUid
    });

    const launching = structured<{ status: string; brokerSessionUid: string }>(
      await tools.callTool("vault_collab_mark_launch_request_launching", {
        launchRequestUid: request.launchRequestUid,
        sessionUid: broker.sessionUid,
        sessionToken: broker.sessionToken,
        detail: "Broker accepted request."
      })
    );
    expect(launching).toMatchObject({
      status: "launching",
      brokerSessionUid: broker.sessionUid
    });

    const launched = structured<{ sessionUid: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Launched Codex",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        capabilities: {
          launchedBy: request.launchRequestUid
        }
      })
    );
    const running = structured<{ status: string; launchedSessionUid: string }>(
      await tools.callTool("vault_collab_mark_launch_request_running", {
        launchRequestUid: request.launchRequestUid,
        sessionUid: broker.sessionUid,
        sessionToken: broker.sessionToken,
        launchedSessionUid: launched.sessionUid,
        detail: "Launched session registered."
      })
    );
    expect(running).toMatchObject({
      status: "running",
      launchedSessionUid: launched.sessionUid
    });

    const stopped = structured<{ status: string; completedAt: string | null; metadata: Record<string, unknown> }>(
      await tools.callTool("vault_collab_mark_launch_request_stopped", {
        launchRequestUid: request.launchRequestUid,
        sessionUid: broker.sessionUid,
        sessionToken: broker.sessionToken,
        detail: "Worker exited after dashboard stop.",
        exitCode: 0
      })
    );
    expect(stopped).toMatchObject({
      status: "stopped",
      completedAt: expect.any(String),
      metadata: {
        source: "mcp-test",
        stopped: {
          detail: "Worker exited after dashboard stop.",
          exitCode: 0,
          brokerSessionUid: broker.sessionUid
        }
      }
    });

    const got = structured<{ launchRequestUid: string; status: string }>(
      await tools.callTool("vault_collab_get_launch_request", {
        launchRequestUid: request.launchRequestUid
      })
    );
    expect(got).toMatchObject({
      launchRequestUid: request.launchRequestUid,
      status: "stopped"
    });
    const detail = structured<{
      launchRequest: { launchRequestUid: string; status: string };
      events: Array<{ eventType: string }>;
    }>(
      await tools.callTool("vault_collab_get_launch_request_detail", {
        launchRequestUid: request.launchRequestUid
      })
    );
    expect(detail.launchRequest).toMatchObject({
      launchRequestUid: request.launchRequestUid,
      status: "stopped"
    });
    expect(detail.events.map((event) => event.eventType)).toEqual([
      "launch_request.requested",
      "launch_request.approved",
      "launch_request.launching",
      "launch_request.running",
      "launch_request.stopped"
    ]);
    expect(JSON.stringify(got)).not.toContain(approver.sessionToken);
    expect(JSON.stringify(got)).not.toContain(broker.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(approver.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(broker.sessionToken);
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
        "role",
        "roleProfileId",
        "role_profile_id",
        "capabilities"
      ])
    );
  });

  it("advertises canonical-only role profile ids for register_session", () => {
    const camel = schemaField("vault_collab_register_session", "roleProfileId");
    const snake = schemaField("vault_collab_register_session", "role_profile_id");

    for (const roleProfileId of coreRoleProfileIds) {
      expect(camel.safeParse(roleProfileId).success, roleProfileId).toBe(true);
      expect(snake.safeParse(roleProfileId).success, roleProfileId).toBe(true);
    }

    for (const invented of ["qa-reviewer", "investigator", "codex-agent"]) {
      expect(camel.safeParse(invented).success, invented).toBe(false);
      expect(snake.safeParse(invented).success, invented).toBe(false);
    }
  });

  it("returns a clear register_session error for non-canonical roleProfileId values", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const rejected = await tools.callTool("vault_collab_register_session", {
      displayName: "Alias QA terminal",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath: cwd,
      roleProfileId: "qa-reviewer"
    });

    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]).toMatchObject({ type: "text" });
    const message = rejected.content[0]?.type === "text" ? rejected.content[0].text : "";
    expect(message).toMatch(/Session roleProfileId must be one of the canonical role profile IDs/);
    expect(message).toContain("qa-evaluator");
    expect(message).toContain("loop-resolver");
    expect(message).toContain("qa-reviewer");
  });

  it("documents role profile id inputs on write-path tools", () => {
    expect(schemaKeys("vault_collab_create_launch_request")).toEqual(
      expect.arrayContaining(["roleProfileId", "role_profile_id"])
    );
    expect(schemaKeys("vault_collab_upsert_agent_profile")).toEqual(
      expect.arrayContaining(["roleProfileId", "role_profile_id"])
    );
    expect(schemaKeys("vault_collab_publish_handoff")).toEqual(
      expect.arrayContaining([
        "suggestedRoleProfileId",
        "suggested_role_profile_id",
        "typedPayload",
        "typed_payload"
      ])
    );
  });

  it("publishes typed discovery handoff payloads through MCP and validates schema_version", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const published = structured<{
      handoffUid: string;
      shortPrompt: string;
      typedPayload: typeof discoveryTypedPayload;
    }>(
      await tools.callTool("vault_collab_publish_handoff", {
        shortPrompt: "Keep this short prompt visible in inbox.",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab",
        typed_payload: discoveryTypedPayload
      })
    );

    expect(published).toMatchObject({
      shortPrompt: "Keep this short prompt visible in inbox.",
      typedPayload: discoveryTypedPayload
    });

    const got = structured<{ typedPayload: typeof discoveryTypedPayload }>(
      await tools.callTool("vault_collab_get_handoff", {
        handoffUid: published.handoffUid
      })
    );
    expect(got.typedPayload).toEqual(discoveryTypedPayload);

    const rejected = await tools.callTool("vault_collab_publish_handoff", {
      shortPrompt: "Reject invalid schema version.",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      typedPayload: {
        schema_version: "vault_collab.discovery_handoff.v2"
      }
    });

    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toMatch(/unsupported typed payload schema_version/i);
  });

  it("returns the expanded 13-role catalog through MCP", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const roles = structured<Array<{ roleProfileId: string; role: string; defaultMutation: string }>>(
      await tools.callTool("vault_collab_list_agent_roles", {})
    );

    expect(roles.map((role) => role.roleProfileId)).toEqual([
      "coordinator",
      "explorer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
      "qa-evaluator",
      "security-reviewer",
      "documentation-agent",
      "runtime-loop-operator",
      "release-agent",
      "pattern-mining-agent",
      "loop-resolver"
    ]);
    expect(roles).toContainEqual(
      expect.objectContaining({
        roleProfileId: "loop-resolver",
        role: "loop-resolver",
        defaultMutation: "read_only"
      })
    );
  });

  it("documents attention as the required active-session discovery surface", () => {
    const register = vaultCollabToolDefinitions.find(
      (tool) => tool.name === "vault_collab_register_session"
    );
    const inbox = vaultCollabToolDefinitions.find((tool) => tool.name === "vault_collab_list_inbox");

    expect(register?.description).toMatch(/vault_collab_get_session_attention/);
    expect(register?.description).toMatch(/after registering/i);
    expect(inbox?.description).toMatch(/project queue snapshot/i);
    expect(inbox?.description).toMatch(/vault_collab_get_session_attention/);
  });

  it("marks wake and broker execution tools deprecated without deprecating launch coordination", () => {
    const deprecatedTools = [
      "vault_collab_ping_session",
      "vault_collab_list_attention_delivery_attempts",
      "vault_collab_mark_launch_request_launching",
      "vault_collab_mark_launch_request_running",
      "vault_collab_mark_launch_request_stopped",
      "vault_collab_fail_launch_request"
    ];
    const coordinationTools = [
      "vault_collab_create_launch_request",
      "vault_collab_approve_launch_request",
      "vault_collab_reject_launch_request",
      "vault_collab_cancel_launch_request"
    ];

    for (const toolName of deprecatedTools) {
      expect(toolDescription(toolName)).toMatch(/^\[DEPRECATED .*vault_collab_receive\]/);
    }

    for (const toolName of coordinationTools) {
      expect(toolDescription(toolName)).not.toMatch(/^\[DEPRECATED/);
    }
  });

  it("advertises only progress statuses for update_handoff", () => {
    const status = schemaField("vault_collab_update_handoff", "status");

    for (const value of ["in_progress", "blocked", "awaiting_user", "verification_needed"]) {
      expect(status.safeParse(value).success, value).toBe(true);
    }

    for (const value of ["available", "claimed", "resolved", "abandoned", "stale"]) {
      expect(status.safeParse(value).success, value).toBe(false);
    }
  });

  it("returns token-safe handoff action affordances for dashboards", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const source = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Source",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const worker = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Worker",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const handoff = structured<{ handoffUid: string }>(
      await tools.callTool("vault_collab_publish_handoff", {
        shortPrompt: "Render dashboard handoff buttons.",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab",
        sourceSessionUid: source.sessionUid
      })
    );

    const actions = structured<{
      handoff: { handoffUid: string };
      actingSessionUid: string;
      actions: Array<{ kind: string; enabled: boolean; toolName: string }>;
    }>(
      await tools.callTool("vault_collab_get_handoff_actions", {
        handoffUid: handoff.handoffUid,
        sessionUid: worker.sessionUid,
        sessionToken: worker.sessionToken
      })
    );

    expect(actions).toMatchObject({
      handoff: {
        handoffUid: handoff.handoffUid
      },
      actingSessionUid: worker.sessionUid
    });
    expect(actions.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "claim",
          enabled: true,
          toolName: "vault_collab_claim_handoff"
        }),
        expect.objectContaining({
          kind: "resolve",
          enabled: false,
          toolName: "vault_collab_resolve_handoff"
        })
      ])
    );
    expect(JSON.stringify(actions)).not.toContain(worker.sessionToken);
  });

  it("does not expose empty passthrough-only schemas for any MCP tool", () => {
    for (const definition of vaultCollabToolDefinitions) {
      if (definition.name === "vault_collab_sweep_expired_handoffs") {
        expect(Object.keys(definition.inputSchema.shape), definition.name).toHaveLength(0);
        continue;
      }
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

    const session = structured<{
      sessionUid: string;
      sessionToken: string;
      nextActions: Array<{ tool: string; args: { sessionUid: string; includeCurrentHandoffs: boolean } }>;
    }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Codex",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    expect(session.nextActions).toEqual([
      {
        tool: "vault_collab_get_session_attention",
        args: {
          sessionUid: session.sessionUid,
          includeCurrentHandoffs: true
        },
        reason: "Discover pings, permission requests, suggested handoffs, claimed work, and available project handoffs for this active session."
      }
    ]);

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

  it("registers session delivery metadata through MCP fields", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const session = structured<{
      delivery: {
        mode: string;
        wakeable: boolean;
        lastAckEventId: number | null;
        lastAckAt: string | null;
      };
    }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Watched Codex",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        deliveryMode: "local_watch",
        deliveryWakeable: false
      })
    );

    expect(session.delivery).toEqual({
      mode: "local_watch",
      wakeable: false,
      lastAckEventId: null,
      lastAckAt: null
    });
  });

  it("registers a first-class session role through MCP", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const session = structured<{ role: string; agentRole: string | null }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Reviewer",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        role: "reviewer"
      })
    );

    expect(session).toMatchObject({
      role: "reviewer",
      agentRole: null
    });
  });

  it("acknowledges attention through MCP without leaking tokens", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const session = structured<{
      sessionUid: string;
      sessionToken: string;
    }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Watched Codex",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        deliveryMode: "local_watch"
      })
    );

    const acknowledged = structured<{
      delivery: {
        mode: string;
        wakeable: boolean;
        lastAckEventId: number | null;
        lastAckAt: string | null;
      };
    }>(
      await tools.callTool("vault_collab_acknowledge_attention", {
        sessionUid: session.sessionUid,
        sessionToken: session.sessionToken,
        latestEventId: 42
      })
    );
    const events = structured<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await tools.callTool("vault_collab_list_events", {
        sessionUid: session.sessionUid
      })
    );

    expect(acknowledged.delivery).toMatchObject({
      mode: "local_watch",
      wakeable: false,
      lastAckEventId: 42
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "session.registered",
      "session.attention_acknowledged"
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      latestEventId: 42
    });
    expect(JSON.stringify(acknowledged)).not.toContain(session.sessionToken);
    expect(JSON.stringify(events)).not.toContain(session.sessionToken);
  });

  it("receives pull-based attention through MCP and advances the cursor", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const worker = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Pull MCP Receiver",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const ping = structured<{ event: { eventId: number } }>(
      await tools.callTool("vault_collab_ping_session", {
        targetSessionUid: worker.sessionUid,
        message: "Pull this from MCP."
      })
    );

    const received = structured<{
      fromEventId: number;
      toEventId: number;
      drained: boolean;
      items: Array<{ kind: string; event: { eventId: number } | null }>;
    }>(
      await tools.callTool("vault_collab_receive", {
        sessionUid: worker.sessionUid,
        sessionToken: worker.sessionToken,
        includeCurrentHandoffs: false
      })
    );
    const secondReceive = structured<{ items: unknown[] }>(
      await tools.callTool("vault_collab_receive", {
        sessionUid: worker.sessionUid,
        sessionToken: worker.sessionToken,
        includeCurrentHandoffs: false
      })
    );

    expect(received).toMatchObject({
      fromEventId: 0,
      toEventId: ping.event.eventId,
      drained: true
    });
    expect(received.items).toEqual([
      expect.objectContaining({
        kind: "session_ping",
        event: expect.objectContaining({
          eventId: ping.event.eventId
        })
      })
    ]);
    expect(secondReceive.items).toEqual([]);
    expect(JSON.stringify(received)).not.toContain(worker.sessionToken);
  });

  it("reports runtime metrics and emits context and cost warnings into attention", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const worker = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Metrics Worker",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        role: "implementer"
      })
    );
    const runtime = structured<{ sessionUid: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Runtime Operator",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        role: "runtime-loop-operator"
      })
    );
    const cursor = structured<{ latestEventId: number }>(
      await tools.callTool("vault_collab_get_session_attention", {
        sessionUid: runtime.sessionUid,
        includeCurrentHandoffs: false
      })
    ).latestEventId;

    const report = structured<{
      emittedEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
    }>(
      await tools.callTool("vault_collab_report_runtime_metrics", {
        sessionUid: worker.sessionUid,
        sessionToken: worker.sessionToken,
        contextUsedTokens: 86000,
        contextLimitTokens: 100000,
        contextThresholdRatio: 0.8,
        costUsd: 18.25,
        costThresholdUsd: 15
      })
    );
    const attention = structured<{
      items: Array<{ kind: string; event: { eventType: string; payload: Record<string, unknown> } }>;
    }>(
      await tools.callTool("vault_collab_get_session_attention", {
        sessionUid: runtime.sessionUid,
        sinceEventId: cursor,
        includeCurrentHandoffs: false
      })
    );

    expect(report.emittedEvents.map((event) => event.eventType)).toEqual([
      "context.limit_warning",
      "cost.threshold_warning"
    ]);
    expect(attention.items.map((item) => item.kind)).toEqual([
      "context_warning",
      "cost_warning"
    ]);
    expect(attention.items[0].event.payload).toMatchObject({
      project: "Vault Collab",
      usageRatio: 0.86,
      thresholdRatio: 0.8,
      remainingTokens: 14000
    });
    expect(attention.items[1].event.payload).toMatchObject({
      project: "Vault Collab",
      costUsd: 18.25,
      thresholdUsd: 15
    });
    expect(JSON.stringify(report)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(attention)).not.toContain(worker.sessionToken);
  });

  it("reports session snapshots with an owner token and routes critical risk attention", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const worker = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Snapshot Worker",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        role: "implementer"
      })
    );
    const coordinator = structured<{ sessionUid: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Coordinator",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        role: "coordinator"
      })
    );
    const runtime = structured<{ sessionUid: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Runtime Operator",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        role: "runtime-loop-operator"
      })
    );
    const coordinatorCursor = structured<{ latestEventId: number }>(
      await tools.callTool("vault_collab_get_session_attention", {
        sessionUid: coordinator.sessionUid,
        includeCurrentHandoffs: false
      })
    ).latestEventId;
    const runtimeCursor = structured<{ latestEventId: number }>(
      await tools.callTool("vault_collab_get_session_attention", {
        sessionUid: runtime.sessionUid,
        includeCurrentHandoffs: false
      })
    ).latestEventId;

    const report = structured<{
      session: {
        sessionUid: string;
        status: string;
        adapterType: string;
        snapshotReportedAt: string | null;
        lastSnapshot: { state: string; risk: { level: string } } | null;
      };
      snapshot: { state: string; risk: { level: string } };
      emittedEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
    }>(
      await tools.callTool("vault_collab_report_session", {
        sessionUid: worker.sessionUid,
        sessionToken: worker.sessionToken,
        snapshot: validSessionSnapshot(worker.sessionUid, cwd, {
          risk: {
            level: "critical",
            reasons: ["Adapter reports context exhaustion."]
          }
        })
      })
    );
    const listed = structured<
      Array<{
        sessionUid: string;
        status: string;
        adapterType: string;
        lastSnapshot: { state: string; risk: { level: string } } | null;
        snapshotReportedAt: string | null;
      }>
    >(
      await tools.callTool("vault_collab_list_sessions", {
        project: "Vault Collab"
      })
    );
    const snapshotEvents = structured<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await tools.callTool("vault_collab_list_events", {
        eventType: "session.snapshot_reported"
      })
    );
    const coordinatorAttention = structured<{
      items: Array<{ kind: string; event: { eventType: string; payload: Record<string, unknown> } }>;
    }>(
      await tools.callTool("vault_collab_get_session_attention", {
        sessionUid: coordinator.sessionUid,
        sinceEventId: coordinatorCursor,
        includeCurrentHandoffs: false
      })
    );
    const runtimeAttention = structured<{
      items: Array<{ kind: string; event: { eventType: string; payload: Record<string, unknown> } }>;
    }>(
      await tools.callTool("vault_collab_get_session_attention", {
        sessionUid: runtime.sessionUid,
        sinceEventId: runtimeCursor,
        includeCurrentHandoffs: false
      })
    );

    expect(report.session).toMatchObject({
      sessionUid: worker.sessionUid,
      status: "idle",
      adapterType: "adapter_backed",
      lastSnapshot: {
        state: "working",
        risk: {
          level: "critical"
        }
      }
    });
    expect(report.session.snapshotReportedAt).toEqual(expect.any(String));
    expect(report.emittedEvents.map((event) => event.eventType)).toEqual([
      "session.snapshot_reported",
      "risk.critical_reported"
    ]);
    expect(snapshotEvents).toHaveLength(1);
    expect(snapshotEvents[0].payload).toMatchObject({
      schemaVersion: "vault_collab.session.v1",
      adapterId: "codex-local:test",
      adapterType: "adapter_backed",
      state: "working",
      riskLevel: "critical",
      activeHandoffCount: 1,
      progressPercent: 40
    });
    expect(snapshotEvents[0].payload).not.toHaveProperty("snapshot");
    expect(listed.find((session) => session.sessionUid === worker.sessionUid)).toMatchObject({
      status: "idle",
      adapterType: "adapter_backed",
      lastSnapshot: {
        state: "working",
        risk: {
          level: "critical"
        }
      }
    });
    expect(coordinatorAttention.items).toEqual([
      expect.objectContaining({
        kind: "risk_critical",
        event: expect.objectContaining({
          eventType: "risk.critical_reported"
        })
      })
    ]);
    expect(runtimeAttention.items).toEqual([
      expect.objectContaining({
        kind: "risk_critical",
        event: expect.objectContaining({
          eventType: "risk.critical_reported"
        })
      })
    ]);
    expect(JSON.stringify(report)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(snapshotEvents)).not.toContain(worker.sessionToken);
  });

  it("accepts HMAC adapter tokens only for vault_collab_report_session", async () => {
    vi.stubEnv("VAULT_COLLAB_ADAPTER_TOKEN_SECRET", adapterSecret);
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const worker = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Adapter Worker",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        role: "implementer"
      })
    );
    const adapterToken = deriveAdapterToken(
      adapterSecret,
      worker.sessionUid,
      "codex-local:test"
    );

    const keys = schemaKeys("vault_collab_report_session");
    expect(keys).toEqual(
      expect.arrayContaining([
        "sessionUid",
        "session_uid",
        "sessionToken",
        "session_token",
        "adapterToken",
        "adapter_token",
        "snapshot"
      ])
    );

    const report = structured<{ session: { adapterType: string }; snapshot: { adapterId: string } }>(
      await tools.callTool("vault_collab_report_session", {
        sessionUid: worker.sessionUid,
        adapterToken,
        snapshot: validSessionSnapshot(worker.sessionUid, cwd)
      })
    );
    const lifecycleAttempt = await tools.callTool("vault_collab_update_session_state", {
      sessionUid: worker.sessionUid,
      adapterToken,
      status: "working"
    });
    const bothTokensAttempt = await tools.callTool("vault_collab_report_session", {
      sessionUid: worker.sessionUid,
      sessionToken: worker.sessionToken,
      adapterToken,
      snapshot: validSessionSnapshot(worker.sessionUid, cwd)
    });

    expect(report).toMatchObject({
      session: {
        adapterType: "adapter_backed"
      },
      snapshot: {
        adapterId: "codex-local:test"
      }
    });
    expect(lifecycleAttempt.isError).toBe(true);
    expect(lifecycleAttempt.content[0]?.type === "text" ? lifecycleAttempt.content[0].text : "")
      .toMatch(/sessionToken|owner token|required string/i);
    expect(bothTokensAttempt.isError).toBe(true);
    expect(bothTokensAttempt.content[0]?.type === "text" ? bothTokensAttempt.content[0].text : "")
      .toMatch(/exactly one/i);
    expect(JSON.stringify(report)).not.toContain(adapterToken);
    expect(JSON.stringify(lifecycleAttempt)).not.toContain(adapterToken);
    expect(JSON.stringify(bothTokensAttempt)).not.toContain(adapterToken);
  });

  it("renames, closes, and cleans up roster sessions through MCP without leaking tokens", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const admin = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Dashboard Admin",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        capabilities: {
          sessionAdmin: true
        }
      })
    );
    const worker = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Codex",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );

    const renamed = structured<{ displayName: string; sessionToken?: string }>(
      await tools.callTool("vault_collab_rename_session", {
        sessionUid: worker.sessionUid,
        sessionToken: worker.sessionToken,
        displayName: "Codex Receiver - terminal 2"
      })
    );
    const closed = structured<{ status: string; statusDetail: string; sessionToken?: string }>(
      await tools.callTool("vault_collab_close_session", {
        targetSessionUid: worker.sessionUid,
        actorSessionUid: admin.sessionUid,
        actorSessionToken: admin.sessionToken,
        reason: "Closed from dashboard roster"
      })
    );
    const cleanup = structured<{
      deletedSessionCount: number;
      deletedSessionUids: string[];
      sessionToken?: string;
    }>(
      await tools.callTool("vault_collab_cleanup_sessions", {
        actorSessionUid: admin.sessionUid,
        actorSessionToken: admin.sessionToken
      })
    );

    expect(renamed).toMatchObject({
      displayName: "Codex Receiver - terminal 2"
    });
    expect(closed).toMatchObject({
      status: "disconnected",
      statusDetail: "Closed from dashboard roster"
    });
    expect(cleanup).toMatchObject({
      deletedSessionCount: 1,
      deletedSessionUids: [worker.sessionUid]
    });
    expect(renamed).not.toHaveProperty("sessionToken");
    expect(closed).not.toHaveProperty("sessionToken");
    expect(cleanup).not.toHaveProperty("sessionToken");
    expect(JSON.stringify({ renamed, closed, cleanup })).not.toContain(worker.sessionToken);
    expect(JSON.stringify({ renamed, closed, cleanup })).not.toContain(admin.sessionToken);
  });

  it("lists attention delivery attempts through MCP without leaking tokens", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const session = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Managed Receiver",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd,
        deliveryMode: "managed_process",
        deliveryWakeable: true
      })
    );
    const acknowledged = structured<{ delivery: { lastAckEventId: number | null } }>(
      await tools.callTool("vault_collab_acknowledge_attention", {
        sessionUid: session.sessionUid,
        sessionToken: session.sessionToken,
        latestEventId: 42
      })
    );
    expect(acknowledged.delivery.lastAckEventId).toBe(42);

    const attempts = structured<Array<{ sessionUid: string; status: string }>>(
      await tools.callTool("vault_collab_list_attention_delivery_attempts", {
        sessionUid: session.sessionUid,
        status: "delivered"
      })
    );

    expect(attempts).toEqual([]);
    expect(JSON.stringify(attempts)).not.toContain(session.sessionToken);
  });

  it("sweeps expired handoff leases through MCP", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const worker = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Lease Owner",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const handoff = structured<{ handoffUid: string }>(
      await tools.callTool("vault_collab_publish_handoff", {
        shortPrompt: "Sweep from MCP",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab"
      })
    );
    await tools.callTool("vault_collab_claim_handoff", {
      handoffUid: handoff.handoffUid,
      sessionUid: worker.sessionUid,
      sessionToken: worker.sessionToken
    });
    const db = createCollabDatabase(dbPath);
    db.prepare("UPDATE handoffs SET lease_expires_at = ? WHERE handoff_uid = ?").run(
      "1970-01-01T00:00:00.000Z",
      handoff.handoffUid
    );
    db.close();

    const swept = structured<{ released: string[]; count: number }>(
      await tools.callTool("vault_collab_sweep_expired_handoffs", {})
    );

    expect(swept).toEqual({
      released: [handoff.handoffUid],
      count: 1
    });
  });

  it("records soft pings and permission requests through MCP without leaking tokens", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const coordinator = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Coordinator",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const worker = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Worker",
        clientType: "claude-code",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const ping = structured<{
      event: { eventType: string; sessionUid: string };
      targetSession: { sessionUid: string; delivery: { mode: string; wakeable: boolean } };
      delivery: { mode: string; wakeable: boolean; delivered: boolean; nextStep: string };
    }>(
      await tools.callTool("vault_collab_ping_session", {
        targetSessionUid: worker.sessionUid,
        actorSessionUid: coordinator.sessionUid,
        message: "Check the inbox when active."
      })
    );
    const awaitingSession = structured<{ status: string; statusDetail: string }>(
      await tools.callTool("vault_collab_request_session_permission", {
        sessionUid: worker.sessionUid,
        sessionToken: worker.sessionToken,
        question: "Allow filesystem write?",
        requestedCapability: "filesystem-write",
        commandPreview: "npm run build",
        source: "claude-code"
      })
    );
    const handoff = structured<{ handoffUid: string }>(
      await tools.callTool("vault_collab_publish_handoff", {
        shortPrompt: "Needs permission",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab"
      })
    );

    await tools.callTool("vault_collab_claim_handoff", {
      handoffUid: handoff.handoffUid,
      sessionUid: worker.sessionUid,
      sessionToken: worker.sessionToken
    });
    const awaitingHandoff = structured<{ status: string; progressNote: string }>(
      await tools.callTool("vault_collab_request_handoff_permission", {
        handoffUid: handoff.handoffUid,
        sessionUid: worker.sessionUid,
        sessionToken: worker.sessionToken,
        question: "Allow network access?",
        requestedCapability: "network",
        commandPreview: "git push origin main",
        source: "claude-code"
      })
    );
    const sessionPermissionEvents = structured<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await tools.callTool("vault_collab_list_events", {
        sessionUid: worker.sessionUid,
        eventType: "session.permission_requested"
      })
    );
    const handoffPermissionEvents = structured<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await tools.callTool("vault_collab_list_events", {
        handoffUid: handoff.handoffUid,
        eventType: "handoff.permission_requested"
      })
    );
    const attention = structured<{
      session: { sessionUid: string };
      items: Array<{ kind: string; event?: { eventType: string }; handoff?: { handoffUid: string } }>;
    }>(
      await tools.callTool("vault_collab_get_session_attention", {
        sessionUid: worker.sessionUid
      })
    );

    expect(ping).toMatchObject({
      event: {
        eventType: "session.pinged",
        sessionUid: worker.sessionUid
      },
      targetSession: {
        sessionUid: worker.sessionUid,
        delivery: {
          mode: "manual_poll",
          wakeable: false
        }
      },
      delivery: {
        mode: "manual_poll",
        wakeable: false,
        delivered: false,
        nextStep: "Target session must poll attention manually or run a watcher."
      }
    });
    expect(JSON.stringify(ping)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(ping)).not.toContain(coordinator.sessionToken);
    const busyPing = structured<{ event: { eventType: string; sessionUid: string } }>(
      await tools.callTool("vault_collab_ping_session", {
        targetSessionUid: worker.sessionUid,
        actorSessionUid: coordinator.sessionUid,
        message: "This should not interrupt an awaiting_user session."
      })
    );
    expect(busyPing).toMatchObject({
      event: {
        eventType: "session.pinged",
        sessionUid: worker.sessionUid
      }
    });
    expect(awaitingSession).toMatchObject({
      status: "awaiting_user",
      statusDetail: "Allow filesystem write?"
    });
    expect(awaitingHandoff).toMatchObject({
      status: "awaiting_user",
      progressNote: "Allow network access?"
    });
    expect(sessionPermissionEvents).toHaveLength(1);
    expect(handoffPermissionEvents).toHaveLength(1);
    expect(attention.session.sessionUid).toBe(worker.sessionUid);
    expect(attention.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["session_ping", "session_permission", "handoff_permission"])
    );
    expect(JSON.stringify(sessionPermissionEvents)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(handoffPermissionEvents)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(attention)).not.toContain(worker.sessionToken);
  });

  it("runs a provider-neutral agent, queue, and discussion workflow through MCP tools", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const roles = structured<Array<{ role: string; roleProfileId: string }>>(
      await tools.callTool("vault_collab_list_agent_roles", {})
    );
    expect(roles.map((role) => role.roleProfileId)).toEqual([
      "coordinator",
      "explorer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
      "qa-evaluator",
      "security-reviewer",
      "documentation-agent",
      "runtime-loop-operator",
      "release-agent",
      "pattern-mining-agent",
      "loop-resolver"
    ]);

    const reviewer = structured<{ agentUid: string; clientType: string; roleProfileId: string }>(
      await tools.callTool("vault_collab_upsert_agent_profile", {
        stableName: "claude-reviewer",
        displayName: "Claude Reviewer",
        role: "reviewer",
        roleProfileId: "reviewer",
        clientType: "claude-code",
        project: "Vault Collab",
        capabilities: {
          review: true
        }
      })
    );
    const implementer = structured<{ agentUid: string; clientType: string; roleProfileId: string }>(
      await tools.callTool("vault_collab_upsert_agent_profile", {
        stable_name: "opencode-implementer",
        display_name: "OpenCode Implementer",
        role: "implementer",
        role_profile_id: "implementer",
        client_type: "opencode",
        project: "Vault Collab"
      })
    );

    expect(reviewer).toMatchObject({
      clientType: "claude-code",
      roleProfileId: "reviewer"
    });
    expect(implementer).toMatchObject({
      clientType: "opencode",
      roleProfileId: "implementer"
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
      suggestedRoleProfileId: string | null;
    }>(
      await tools.callTool("vault_collab_publish_handoff", {
        shortPrompt: "Discuss MCP contract",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab",
        sourceSessionUid: claude.sessionUid,
        suggested_role_profile_id: "reviewer",
        queueKey: "phase-1",
        labels: ["mcp", "discussion"],
        queuePosition: 500
      })
    );

    expect(published).toMatchObject({
      queueKey: "phase-1",
      labels: ["mcp", "discussion"],
      queuePosition: 500,
      suggestedRoleProfileId: "reviewer"
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

  it("creates handoff-linked discussion threads without requiring a project argument", async () => {
    const keys = schemaKeys("vault_collab_create_handoff_discussion_thread");
    expect(keys).toEqual(
      expect.arrayContaining(["handoffUid", "handoff_uid", "title", "sessionUid", "sessionToken"])
    );
    expect(keys).not.toContain("project");

    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const coordinator = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Coordinator",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const handoff = structured<{ handoffUid: string }>(
      await tools.callTool("vault_collab_publish_handoff", {
        shortPrompt: "Discuss the handoff",
        sourceProject: "Source Project",
        targetProject: "Vault Collab"
      })
    );

    const thread = structured<{ threadUid: string; handoffUid: string | null; project: string }>(
      await tools.callTool("vault_collab_create_handoff_discussion_thread", {
        handoffUid: handoff.handoffUid,
        title: "Handoff-linked discussion",
        sessionUid: coordinator.sessionUid,
        sessionToken: coordinator.sessionToken
      })
    );
    const detail = structured<{
      discussionThreads: Array<{ threadUid: string; handoffUid: string | null; project: string }>;
    }>(
      await tools.callTool("vault_collab_get_handoff_detail", {
        handoffUid: handoff.handoffUid
      })
    );

    expect(thread).toMatchObject({
      handoffUid: handoff.handoffUid,
      project: "Vault Collab"
    });
    expect(detail.discussionThreads).toEqual([
      expect.objectContaining({
        threadUid: thread.threadUid,
        handoffUid: handoff.handoffUid,
        project: "Vault Collab"
      })
    ]);
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

  it("recovers a stranded handoff through MCP without leaking tokens", async () => {
    const tools = createVaultCollabMcpTools({ dbPath });
    closeTools = tools.close;

    const source = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Source",
        clientType: "codex",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const implementer = structured<{ sessionUid: string; sessionToken: string }>(
      await tools.callTool("vault_collab_register_session", {
        displayName: "Implementer",
        clientType: "claude-code",
        project: "Vault Collab",
        workspacePath: cwd
      })
    );
    const handoff = structured<{ handoffUid: string }>(
      await tools.callTool("vault_collab_publish_handoff", {
        shortPrompt: "Recover from MCP",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab",
        sourceSessionUid: source.sessionUid
      })
    );

    await tools.callTool("vault_collab_claim_handoff", {
      handoffUid: handoff.handoffUid,
      sessionUid: implementer.sessionUid,
      sessionToken: implementer.sessionToken
    });
    await tools.callTool("vault_collab_update_handoff", {
      handoffUid: handoff.handoffUid,
      sessionUid: implementer.sessionUid,
      sessionToken: implementer.sessionToken,
      status: "in_progress",
      progressNote: "Work complete but owner token was lost."
    });

    const recovered = structured<{ status: string; claimedBySessionUid: string }>(
      await tools.callTool("vault_collab_recover_handoff", {
        handoffUid: handoff.handoffUid,
        actorSessionUid: source.sessionUid,
        actorSessionToken: source.sessionToken,
        reason: "Owner token unavailable after restart.",
        summary: "Completion evidence accepted.",
        evidenceVaultMemoryUid: "vm_recovery_evidence"
      })
    );

    expect(recovered).toMatchObject({
      status: "resolved",
      claimedBySessionUid: implementer.sessionUid
    });
    const failedRelease = await tools.callTool("vault_collab_release_handoff", {
      handoffUid: handoff.handoffUid,
      sessionUid: implementer.sessionUid,
      sessionToken: implementer.sessionToken
    });
    expect(failedRelease.isError).toBe(true);
    expect(JSON.stringify(failedRelease)).not.toContain(implementer.sessionToken);

    const events = structured<Array<{ eventType: string; payload: Record<string, unknown> }>>(
      await tools.callTool("vault_collab_list_events", {
        handoffUid: handoff.handoffUid
      })
    );
    expect(events.map((event) => event.eventType)).toEqual([
      "handoff.published",
      "handoff.claimed",
      "handoff.updated",
      "handoff.recovery_resolved"
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      reason: "Owner token unavailable after restart.",
      summary: "Completion evidence accepted.",
      evidenceVaultMemoryUid: "vm_recovery_evidence",
      previousClaimedBySessionUid: implementer.sessionUid,
      previousStatus: "in_progress",
      actorAuthorizedBy: "source_session"
    });
    expect(JSON.stringify(events)).not.toContain(source.sessionToken);
    expect(JSON.stringify(events)).not.toContain(implementer.sessionToken);
  });
});
