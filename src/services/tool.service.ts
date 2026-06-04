import type { JsonRecord } from "../types.js";
import type { PolicyEngine } from "./policy-engine.service.js";

const ownerTokenToolNames = new Set([
  "vault_collab_heartbeat_session",
  "vault_collab_acknowledge_attention",
  "vault_collab_update_session_state",
  "vault_collab_request_session_permission",
  "vault_collab_rename_session",
  "vault_collab_close_session",
  "vault_collab_disconnect_session",
  "vault_collab_create_launch_request",
  "vault_collab_get_launch_request_actions",
  "vault_collab_approve_launch_request",
  "vault_collab_reject_launch_request",
  "vault_collab_cancel_launch_request",
  "vault_collab_mark_launch_request_launching",
  "vault_collab_mark_launch_request_running",
  "vault_collab_mark_launch_request_stopped",
  "vault_collab_fail_launch_request",
  "vault_collab_link_vault_memory",
  "vault_collab_get_handoff_actions",
  "vault_collab_update_handoff_metadata",
  "vault_collab_create_discussion_thread",
  "vault_collab_create_handoff_discussion_thread",
  "vault_collab_add_discussion_message",
  "vault_collab_report_runtime_metrics",
  "vault_collab_report_session",
  "vault_collab_claim_handoff",
  "vault_collab_update_handoff",
  "vault_collab_request_user_confirmation",
  "vault_collab_request_handoff_permission",
  "vault_collab_resolve_handoff",
  "vault_collab_recover_handoff",
  "vault_collab_release_handoff",
  "vault_collab_activate_policy_pack",
  "vault_collab_deactivate_policy_pack"
]);

const policyBypassToolNames = new Set(["vault_collab_evaluate_policy"]);

export class ToolService {
  constructor(private readonly policyEngine: PolicyEngine) {}

  enforceBeforeExecution(toolName: string, args: Record<string, unknown>): void {
    if (policyBypassToolNames.has(toolName)) {
      return;
    }

    const hasSessionToken =
      firstStringArg(args, "sessionToken", "session_token", "actorSessionToken", "actor_session_token") !==
      null;
    const hasAdapterToken = firstStringArg(args, "adapterToken", "adapter_token") !== null;
    const isAdapterReportCall =
      toolName === "vault_collab_report_session" && hasAdapterToken && !hasSessionToken;

    this.policyEngine.enforce({
      actionType: "tool.execute",
      payload: {
        toolName,
        actorSessionUid: firstStringArg(
          args,
          "sessionUid",
          "session_uid",
          "actorSessionUid",
          "actor_session_uid"
        ),
        project:
          firstStringArg(args, "project", "targetProject", "target_project", "sourceProject", "source_project") ??
          null,
        requiresOwnerToken: ownerTokenToolNames.has(toolName) && !isAdapterReportCall,
        requiresAdapterToken: toolName === "vault_collab_report_session" && hasAdapterToken,
        hasSessionToken,
        hasAdapterToken,
        sensitiveAction: sensitiveActionForTool(toolName),
        argumentKeys: Object.keys(args)
      } satisfies JsonRecord
    });
  }
}

function sensitiveActionForTool(toolName: string): string | null {
  switch (toolName) {
    case "vault_collab_mark_launch_request_launching":
    case "vault_collab_mark_launch_request_running":
      return "agent_spawning";
    default:
      return null;
  }
}

function firstStringArg(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return null;
}
