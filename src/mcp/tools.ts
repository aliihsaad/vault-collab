import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAgentOperatingGuide } from "../agent-guide.js";
import { createCollabDatabase, type CollabDatabase } from "../database/connection.js";
import { isForbiddenTokenKey } from "../event-registry.js";
import { withAttentionNextAction } from "../next-actions.js";
import { AgentProfileService } from "../services/agent-profile.service.js";
import { AttentionService } from "../services/attention.service.js";
import { DiscussionService } from "../services/discussion.service.js";
import { EventService } from "../services/event.service.js";
import { HandoffDetailService } from "../services/handoff-detail.service.js";
import { HandoffService } from "../services/handoff.service.js";
import { LaunchRequestService } from "../services/launch-request.service.js";
import { PolicyEngine } from "../services/policy-engine.service.js";
import { SecurityScanner } from "../services/security-scanner.service.js";
import { AttentionReceiverService, type ReceiverAdapter } from "../services/attention-receiver.service.js";
import { SessionService } from "../services/session.service.js";
import { ToolService } from "../services/tool.service.js";
import { VaultLinkedHandoffService, type VaultMemoryClient } from "../services/vault-link.service.js";
import { launchRequestStatuses, progressHandoffStatuses } from "../types.js";
import type {
  AgentProfileStatus,
  AttentionDeliveryAttemptStatus,
  ClientType,
  DiscussionMessageType,
  DiscussionThreadStatus,
  HandoffPriority,
  HandoffStatus,
  JsonRecord,
  LaunchRequestStatus,
  SessionDeliveryMode,
  SessionStatus
} from "../types.js";

export const vaultCollabToolNames = [
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
] as const;

export type VaultCollabToolName = (typeof vaultCollabToolNames)[number];

const vaultMemoryLinkedPublishToolName: VaultCollabToolName =
  "vault_collab_publish_handoff_with_vault_memory";

export interface VaultCollabToolResult extends CallToolResult {
  structuredContent: {
    result: unknown;
  };
}

export interface VaultCollabToolDefinition {
  name: VaultCollabToolName;
  title: string;
  description: string;
  inputSchema: z.AnyZodObject;
}

export interface VaultCollabMcpTools {
  definitions: VaultCollabToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<VaultCollabToolResult>;
  close: () => void;
}

export interface CreateVaultCollabMcpToolsOptions {
  dbPath?: string;
  db?: CollabDatabase;
  vaultMemoryClient?: VaultMemoryClient;
  clock?: () => Date;
  heartbeatIntervalMs?: number;
}

const defaultHeartbeatIntervalMs = 75_000;

type HeartbeatTimer = ReturnType<typeof setInterval>;

class AutoHeartbeatManager {
  private readonly timers = new Map<string, HeartbeatTimer>();

  constructor(
    private readonly sessions: SessionService,
    private readonly intervalMs: number
  ) {}

  start(sessionUid: string, sessionToken: string): void {
    this.stop(sessionUid);

    const timer = setInterval(() => {
      try {
        this.sessions.heartbeatSessionSilently(sessionUid, sessionToken);
      } catch {
        this.stop(sessionUid);
      }
    }, this.intervalMs);
    const maybeUnref = timer as HeartbeatTimer & { unref?: () => void };
    maybeUnref.unref?.();
    this.timers.set(sessionUid, timer);
  }

  stop(sessionUid: string): void {
    const timer = this.timers.get(sessionUid);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.timers.delete(sessionUid);
  }

  close(): void {
    for (const sessionUid of Array.from(this.timers.keys())) {
      this.stop(sessionUid);
    }
  }
}

const clientTypeValues = [
  "codex",
  "claude-code",
  "claude-desktop",
  "octogent",
  "gemini",
  "opencode",
  "other"
] as const satisfies readonly ClientType[];
const sessionStatusValues = [
  "idle",
  "working",
  "blocked",
  "awaiting_user",
  "awaiting_verification",
  "complete",
  "disconnected"
] as const satisfies readonly SessionStatus[];
const sessionDeliveryModeValues = [
  "manual_poll",
  "local_watch",
  "mcp_notification",
  "managed_process"
] as const satisfies readonly SessionDeliveryMode[];
const attentionDeliveryAttemptStatusValues = [
  "delivered",
  "failed"
] as const satisfies readonly AttentionDeliveryAttemptStatus[];
const handoffStatusValues = [
  "available",
  "claimed",
  "in_progress",
  "blocked",
  "awaiting_user",
  "verification_needed",
  "resolved",
  "abandoned",
  "stale"
] as const satisfies readonly HandoffStatus[];
const handoffPriorityValues = [
  "low",
  "normal",
  "high",
  "urgent"
] as const satisfies readonly HandoffPriority[];
const launchRequestStatusValues = launchRequestStatuses;
const agentProfileStatusValues = ["active", "archived"] as const satisfies readonly AgentProfileStatus[];
const discussionThreadStatusValues = [
  "open",
  "resolved"
] as const satisfies readonly DiscussionThreadStatus[];
const discussionMessageTypeValues = [
  "note",
  "question",
  "proposal",
  "concern",
  "decision",
  "system"
] as const satisfies readonly DiscussionMessageType[];

const deprecatedReceivePrefix = "[DEPRECATED - use vault_collab_receive] ";

const clientTypeSchema = z.enum(clientTypeValues);
const sessionStatusSchema = z.enum(sessionStatusValues);
const sessionDeliveryModeSchema = z.enum(sessionDeliveryModeValues);
const attentionDeliveryAttemptStatusSchema = z.enum(attentionDeliveryAttemptStatusValues);
const handoffStatusSchema = z.enum(handoffStatusValues);
const progressHandoffStatusSchema = z.enum(progressHandoffStatuses);
const handoffPrioritySchema = z.enum(handoffPriorityValues);
const launchRequestStatusSchema = z.enum(launchRequestStatusValues);
const agentProfileStatusSchema = z.enum(agentProfileStatusValues);
const discussionThreadStatusSchema = z.enum(discussionThreadStatusValues);
const discussionMessageTypeSchema = z.enum(discussionMessageTypeValues);

const agentGuideInputSchema = z.object({
  clientType: clientTypeSchema.describe("Optional provider/client identifier for tailoring examples.").optional(),
  client_type: clientTypeSchema.describe("Snake_case alias for clientType.").optional(),
  project: optionalStringSchema("Optional project name for guide context.")
});

function requiredStringSchema(description: string): z.ZodString {
  return z.string().min(1).describe(description);
}

function optionalStringSchema(description: string): z.ZodOptional<z.ZodString> {
  return z.string().min(1).describe(description).optional();
}

function optionalStringArraySchema(description: string): z.ZodOptional<z.ZodArray<z.ZodString>> {
  return z.array(z.string()).describe(description).optional();
}

function optionalBooleanSchema(description: string): z.ZodOptional<z.ZodBoolean> {
  return z.boolean().describe(description).optional();
}

function optionalNumberSchema(description: string): z.ZodOptional<z.ZodNumber> {
  return z.number().int().describe(description).optional();
}

const registerSessionInputSchema = z.object({
  displayName: optionalStringSchema("Required if display_name is omitted. Human-readable session name."),
  display_name: optionalStringSchema("Snake_case alias for displayName."),
  clientType: clientTypeSchema.describe("Required if client_type is omitted. Provider/client identifier.").optional(),
  client_type: clientTypeSchema.describe("Snake_case alias for clientType.").optional(),
  project: requiredStringSchema("Project name this session is working in."),
  workspacePath: optionalStringSchema("Required if workspace_path is omitted. Local workspace path."),
  workspace_path: optionalStringSchema("Snake_case alias for workspacePath."),
  role: optionalStringSchema("Optional session role label; defaults to implementer."),
  roleProfileId: optionalStringSchema("Optional canonical role profile id or alias."),
  role_profile_id: optionalStringSchema("Snake_case alias for roleProfileId."),
  agentUid: optionalStringSchema("Optional durable agent profile identifier."),
  agent_uid: optionalStringSchema("Snake_case alias for agentUid."),
  deliveryMode: sessionDeliveryModeSchema.describe("Optional attention delivery mode.").optional(),
  delivery_mode: sessionDeliveryModeSchema.describe("Snake_case alias for deliveryMode.").optional(),
  deliveryWakeable: optionalBooleanSchema("Whether this session has a verified wake/delivery path."),
  delivery_wakeable: optionalBooleanSchema("Snake_case alias for deliveryWakeable."),
  capabilities: z.record(z.unknown()).describe("Optional provider-neutral capability flags.").optional()
});

const ownedSessionInputSchema = z.object({
  sessionUid: optionalStringSchema("Required if session_uid is omitted. Session identifier."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid."),
  sessionToken: optionalStringSchema("Required if session_token is omitted. Private owner token."),
  session_token: optionalStringSchema("Snake_case alias for sessionToken.")
});

const acknowledgeAttentionInputSchema = ownedSessionInputSchema.extend({
  latestEventId: optionalNumberSchema("Required if latest_event_id is omitted. Latest attention event id observed by the receiver."),
  latest_event_id: optionalNumberSchema("Snake_case alias for latestEventId.")
});

const updateSessionStateInputSchema = ownedSessionInputSchema.extend({
  status: sessionStatusSchema.describe("New session status."),
  detail: optionalStringSchema("Optional status detail."),
  statusDetail: optionalStringSchema("Alias for detail."),
  status_detail: optionalStringSchema("Snake_case alias for statusDetail.")
});

const pingSessionInputSchema = z.object({
  targetSessionUid: optionalStringSchema("Required if target_session_uid is omitted. Target session identifier."),
  target_session_uid: optionalStringSchema("Snake_case alias for targetSessionUid."),
  actorSessionUid: optionalStringSchema("Optional session identifier for the actor sending the ping."),
  actor_session_uid: optionalStringSchema("Snake_case alias for actorSessionUid."),
  message: optionalStringSchema("Optional ping message.")
});

const permissionRequestInputSchema = ownedSessionInputSchema.extend({
  question: requiredStringSchema("Permission question or approval prompt."),
  requestedCapability: optionalStringSchema("Optional requested capability label."),
  requested_capability: optionalStringSchema("Snake_case alias for requestedCapability."),
  commandPreview: optionalStringSchema("Optional command or action preview."),
  command_preview: optionalStringSchema("Snake_case alias for commandPreview."),
  source: optionalStringSchema("Optional client/source label.")
});

const renameSessionInputSchema = ownedSessionInputSchema.extend({
  displayName: optionalStringSchema("Required if display_name is omitted. Replacement session display name."),
  display_name: optionalStringSchema("Snake_case alias for displayName.")
});

const closeSessionInputSchema = z.object({
  targetSessionUid: optionalStringSchema("Required if target_session_uid is omitted. Session to mark disconnected."),
  target_session_uid: optionalStringSchema("Snake_case alias for targetSessionUid."),
  actorSessionUid: optionalStringSchema("Required if actor_session_uid is omitted. Acting session identifier."),
  actor_session_uid: optionalStringSchema("Snake_case alias for actorSessionUid."),
  actorSessionToken: optionalStringSchema("Required if actor_session_token is omitted. Acting session owner token."),
  actor_session_token: optionalStringSchema("Snake_case alias for actorSessionToken."),
  reason: optionalStringSchema("Optional roster close reason.")
});

const listSessionsInputSchema = z.object({
  project: optionalStringSchema("Optional project filter."),
  clientType: clientTypeSchema.describe("Optional client type filter.").optional(),
  client_type: clientTypeSchema.describe("Snake_case alias for clientType.").optional(),
  status: sessionStatusSchema.describe("Optional session status filter.").optional()
});

const getSessionAttentionInputSchema = z.object({
  sessionUid: optionalStringSchema("Required if session_uid is omitted. Session identifier."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid."),
  sinceEventId: optionalNumberSchema("Only include event-backed attention after this event id."),
  since_event_id: optionalNumberSchema("Snake_case alias for sinceEventId."),
  includeCurrentHandoffs: optionalBooleanSchema("Include current claimed/suggested/available handoffs."),
  include_current_handoffs: optionalBooleanSchema("Snake_case alias for includeCurrentHandoffs.")
});

const receiveInputSchema = ownedSessionInputSchema.extend({
  includeCurrentHandoffs: optionalBooleanSchema("Include current claimed/suggested/available handoffs."),
  include_current_handoffs: optionalBooleanSchema("Snake_case alias for includeCurrentHandoffs."),
  advanceCursor: optionalBooleanSchema("Advance the session attention cursor after draining items."),
  advance_cursor: optionalBooleanSchema("Snake_case alias for advanceCursor.")
});

const listAttentionDeliveryAttemptsInputSchema = z.object({
  sessionUid: optionalStringSchema("Optional session identifier filter."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid."),
  status: attentionDeliveryAttemptStatusSchema.describe("Optional delivery attempt status filter.").optional()
});

const createLaunchRequestInputSchema = ownedSessionInputSchema.extend({
  provider: clientTypeSchema.describe("Provider/client type to launch."),
  model: requiredStringSchema("Model identifier to request."),
  effortLevel: optionalStringSchema("Optional effort level."),
  effort_level: optionalStringSchema("Snake_case alias for effortLevel."),
  project: requiredStringSchema("Project the launched agent should join."),
  workspacePath: optionalStringSchema("Required if workspace_path is omitted. Workspace path to open."),
  workspace_path: optionalStringSchema("Snake_case alias for workspacePath."),
  role: optionalStringSchema("Optional requested agent role."),
  roleProfileId: optionalStringSchema("Optional canonical requested role profile id or alias."),
  role_profile_id: optionalStringSchema("Snake_case alias for roleProfileId."),
  initialInstructions: optionalStringSchema("Required if initial_instructions is omitted. Initial instructions."),
  initial_instructions: optionalStringSchema("Snake_case alias for initialInstructions."),
  permissionMode: optionalStringSchema("Required if permission_mode is omitted. Requested permission mode."),
  permission_mode: optionalStringSchema("Snake_case alias for permissionMode."),
  commandPreview: optionalStringSchema("Optional non-executing command/action preview."),
  command_preview: optionalStringSchema("Snake_case alias for commandPreview."),
  requestedCapabilities: optionalStringArraySchema("Optional requested capability labels."),
  requested_capabilities: optionalStringArraySchema("Snake_case alias for requestedCapabilities."),
  approvalPolicyVersion: optionalStringSchema("Optional approval policy version."),
  approval_policy_version: optionalStringSchema("Snake_case alias for approvalPolicyVersion."),
  metadata: z.record(z.unknown()).describe("Optional structured launch metadata.").optional()
});

const listLaunchRequestsInputSchema = z.object({
  project: optionalStringSchema("Optional project filter."),
  provider: clientTypeSchema.describe("Optional provider/client filter.").optional(),
  status: launchRequestStatusSchema.describe("Optional launch request status filter.").optional(),
  requestedBySessionUid: optionalStringSchema("Optional requester session filter."),
  requested_by_session_uid: optionalStringSchema("Snake_case alias for requestedBySessionUid.")
});

const launchRequestUidInputSchema = z.object({
  launchRequestUid: optionalStringSchema("Required if launch_request_uid is omitted. Launch request identifier."),
  launch_request_uid: optionalStringSchema("Snake_case alias for launchRequestUid.")
});

const ownedLaunchRequestInputSchema = launchRequestUidInputSchema.extend({
  sessionUid: optionalStringSchema("Required if session_uid is omitted. Acting session identifier."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid."),
  sessionToken: optionalStringSchema("Required if session_token is omitted. Acting session owner token."),
  session_token: optionalStringSchema("Snake_case alias for sessionToken.")
});

const approveLaunchRequestInputSchema = ownedLaunchRequestInputSchema.extend({
  detail: optionalStringSchema("Optional approval detail.")
});

const rejectLaunchRequestInputSchema = ownedLaunchRequestInputSchema.extend({
  reason: requiredStringSchema("Rejection reason.")
});

const cancelLaunchRequestInputSchema = ownedLaunchRequestInputSchema.extend({
  reason: requiredStringSchema("Cancellation reason.")
});

const markLaunchRequestLaunchingInputSchema = ownedLaunchRequestInputSchema.extend({
  detail: optionalStringSchema("Optional broker transition detail.")
});

const markLaunchRequestRunningInputSchema = ownedLaunchRequestInputSchema.extend({
  launchedSessionUid: optionalStringSchema("Required if launched_session_uid is omitted. Registered launched session identifier."),
  launched_session_uid: optionalStringSchema("Snake_case alias for launchedSessionUid."),
  detail: optionalStringSchema("Optional running transition detail.")
});

const markLaunchRequestStoppedInputSchema = ownedLaunchRequestInputSchema.extend({
  detail: optionalStringSchema("Optional stopped transition detail."),
  exitCode: optionalNumberSchema("Optional worker process exit code."),
  exit_code: optionalNumberSchema("Snake_case alias for exitCode.")
});

const failLaunchRequestInputSchema = ownedLaunchRequestInputSchema.extend({
  reason: requiredStringSchema("Failure reason.")
});

const listAgentRolesInputSchema = z.object({
  includeCustom: optionalBooleanSchema("Reserved for future custom role discovery."),
  include_custom: optionalBooleanSchema("Snake_case alias for includeCustom.")
});

const upsertAgentProfileInputSchema = z.object({
  stableName: optionalStringSchema("Required if stable_name is omitted. Durable agent stable name."),
  stable_name: optionalStringSchema("Snake_case alias for stableName."),
  displayName: optionalStringSchema("Required if display_name is omitted. Durable agent display name."),
  display_name: optionalStringSchema("Snake_case alias for displayName."),
  role: optionalStringSchema("Agent role label. Built-in roles and custom strings are accepted."),
  roleProfileId: optionalStringSchema("Optional canonical role profile id or alias."),
  role_profile_id: optionalStringSchema("Snake_case alias for roleProfileId."),
  clientType: clientTypeSchema.describe("Optional preferred provider/client identifier.").optional(),
  client_type: clientTypeSchema.describe("Snake_case alias for clientType.").optional(),
  project: optionalStringSchema("Optional home project."),
  description: optionalStringSchema("Optional profile description."),
  capabilities: z.record(z.unknown()).describe("Optional provider-neutral capability flags.").optional(),
  status: agentProfileStatusSchema.describe("Optional profile lifecycle status.").optional(),
  createdBySessionUid: optionalStringSchema("Optional creating session identifier."),
  created_by_session_uid: optionalStringSchema("Snake_case alias for createdBySessionUid.")
});

const listAgentProfilesInputSchema = z.object({
  project: optionalStringSchema("Optional home project filter."),
  role: optionalStringSchema("Optional role filter."),
  status: agentProfileStatusSchema.describe("Optional profile status filter.").optional()
});

const publishHandoffInputSchema = z.object({
  shortPrompt: optionalStringSchema("Required if short_prompt is omitted. Short handoff prompt."),
  short_prompt: optionalStringSchema("Snake_case alias for shortPrompt."),
  sourceProject: optionalStringSchema("Required if source_project is omitted. Source project name."),
  source_project: optionalStringSchema("Snake_case alias for sourceProject."),
  targetProject: optionalStringSchema("Required if target_project is omitted. Target project inbox."),
  target_project: optionalStringSchema("Snake_case alias for targetProject."),
  relatedProjects: optionalStringArraySchema("Optional related project names."),
  related_projects: optionalStringArraySchema("Snake_case alias for relatedProjects."),
  relatedFiles: optionalStringArraySchema("Optional related file paths."),
  related_files: optionalStringArraySchema("Snake_case alias for relatedFiles."),
  sourceSessionUid: optionalStringSchema("Optional source session identifier."),
  source_session_uid: optionalStringSchema("Snake_case alias for sourceSessionUid."),
  suggestedSessionUid: optionalStringSchema("Optional suggested target session identifier."),
  suggested_session_uid: optionalStringSchema("Snake_case alias for suggestedSessionUid."),
  suggestedClientType: clientTypeSchema.describe("Optional suggested target client type.").optional(),
  suggested_client_type: clientTypeSchema.describe("Snake_case alias for suggestedClientType.").optional(),
  suggestedRoleProfileId: optionalStringSchema("Optional advisory suggested role profile id or alias."),
  suggested_role_profile_id: optionalStringSchema("Snake_case alias for suggestedRoleProfileId."),
  vaultMemoryUid: optionalStringSchema("Optional existing Vault memory item UID for a full brief."),
  vault_memory_uid: optionalStringSchema("Snake_case alias for vaultMemoryUid."),
  queueKey: optionalStringSchema("Optional handoff queue key."),
  queue_key: optionalStringSchema("Snake_case alias for queueKey."),
  labels: optionalStringArraySchema("Optional handoff labels."),
  queuePosition: optionalNumberSchema("Optional handoff queue position."),
  queue_position: optionalNumberSchema("Snake_case alias for queuePosition."),
  dependsOnHandoffUid: optionalStringSchema("Optional preceding handoff dependency."),
  depends_on_handoff_uid: optionalStringSchema("Snake_case alias for dependsOnHandoffUid."),
  priority: handoffPrioritySchema.describe("Optional priority. Defaults to normal.").optional(),
  urgent: optionalBooleanSchema("Optional urgent flag."),
  typedPayload: z.record(z.unknown()).describe("Optional typed handoff payload.").optional(),
  typed_payload: z.record(z.unknown()).describe("Snake_case alias for typedPayload.").optional()
});

const publishVaultLinkedHandoffInputSchema = publishHandoffInputSchema
  .omit({
    vaultMemoryUid: true,
    vault_memory_uid: true
  })
  .extend({
    fullBrief: optionalStringSchema("Required if full_brief is omitted. Full brief saved to Vault memory."),
    full_brief: optionalStringSchema("Snake_case alias for fullBrief."),
    vaultProject: optionalStringSchema("Optional Vault project override for the saved memory."),
    vault_project: optionalStringSchema("Snake_case alias for vaultProject."),
    vaultTitle: optionalStringSchema("Optional Vault memory title."),
    vault_title: optionalStringSchema("Snake_case alias for vaultTitle."),
    vaultSubject: optionalStringSchema("Optional Vault memory subject."),
    vault_subject: optionalStringSchema("Snake_case alias for vaultSubject."),
    keywords: optionalStringArraySchema("Optional Vault memory keywords."),
    tags: optionalStringArraySchema("Optional Vault memory tags."),
    nextSteps: optionalStringArraySchema("Optional follow-up steps for the Vault memory."),
    next_steps: optionalStringArraySchema("Snake_case alias for nextSteps.")
  });

const handoffUidInputSchema = z.object({
  handoffUid: optionalStringSchema("Required if handoff_uid is omitted. Handoff identifier."),
  handoff_uid: optionalStringSchema("Snake_case alias for handoffUid.")
});

const ownedHandoffInputSchema = handoffUidInputSchema.extend({
  sessionUid: optionalStringSchema("Required if session_uid is omitted. Owning session identifier."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid."),
  sessionToken: optionalStringSchema("Required if session_token is omitted. Private owner token."),
  session_token: optionalStringSchema("Snake_case alias for sessionToken.")
});

const linkVaultMemoryInputSchema = ownedHandoffInputSchema.extend({
  vaultMemoryUid: optionalStringSchema("Required if vault_memory_uid is omitted. Existing Vault memory item UID."),
  vault_memory_uid: optionalStringSchema("Snake_case alias for vaultMemoryUid.")
});

const listInboxInputSchema = z.object({
  sourceProject: optionalStringSchema("Optional source project filter."),
  source_project: optionalStringSchema("Snake_case alias for sourceProject."),
  targetProject: optionalStringSchema("Optional target project filter."),
  target_project: optionalStringSchema("Snake_case alias for targetProject."),
  queueKey: optionalStringSchema("Optional queue key filter."),
  queue_key: optionalStringSchema("Snake_case alias for queueKey."),
  label: optionalStringSchema("Optional label filter."),
  status: handoffStatusSchema.describe("Optional handoff status filter.").optional(),
  includeResolved: optionalBooleanSchema("Include resolved handoffs when listing."),
  include_resolved: optionalBooleanSchema("Snake_case alias for includeResolved.")
});

const updateHandoffMetadataInputSchema = ownedHandoffInputSchema.extend({
  queueKey: optionalStringSchema("Optional replacement queue key."),
  queue_key: optionalStringSchema("Snake_case alias for queueKey."),
  labels: optionalStringArraySchema("Optional replacement labels."),
  queuePosition: optionalNumberSchema("Optional replacement queue position."),
  queue_position: optionalNumberSchema("Snake_case alias for queuePosition."),
  dependsOnHandoffUid: optionalStringSchema("Optional replacement dependency handoff UID."),
  depends_on_handoff_uid: optionalStringSchema("Snake_case alias for dependsOnHandoffUid.")
});

const threadUidInputSchema = z.object({
  threadUid: optionalStringSchema("Required if thread_uid is omitted. Discussion thread identifier."),
  thread_uid: optionalStringSchema("Snake_case alias for threadUid.")
});

const createDiscussionThreadInputSchema = ownedSessionInputSchema.extend({
  project: requiredStringSchema("Project the discussion belongs to."),
  handoffUid: optionalStringSchema(
    "Optional linked handoff identifier. For handoff discussions, prefer vault_collab_create_handoff_discussion_thread so get_handoff_detail includes the thread."
  ),
  handoff_uid: optionalStringSchema("Snake_case alias for handoffUid."),
  title: requiredStringSchema("Discussion title.")
});

const createHandoffDiscussionThreadInputSchema = ownedSessionInputSchema.extend({
  handoffUid: optionalStringSchema("Required if handoff_uid is omitted. Handoff to link the discussion to."),
  handoff_uid: optionalStringSchema("Snake_case alias for handoffUid."),
  title: requiredStringSchema("Discussion title.")
});

const addDiscussionMessageInputSchema = threadUidInputSchema.extend({
  sessionUid: optionalStringSchema("Required if session_uid is omitted. Authoring session identifier."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid."),
  sessionToken: optionalStringSchema("Required if session_token is omitted. Authoring session owner token."),
  session_token: optionalStringSchema("Snake_case alias for sessionToken."),
  messageType: discussionMessageTypeSchema.describe("Message type.").optional(),
  message_type: discussionMessageTypeSchema.describe("Snake_case alias for messageType.").optional(),
  body: requiredStringSchema("Message body."),
  metadata: z.record(z.unknown()).describe("Optional structured message metadata.").optional()
});

const listDiscussionThreadsInputSchema = z.object({
  project: optionalStringSchema("Optional project filter."),
  handoffUid: optionalStringSchema("Optional handoff filter."),
  handoff_uid: optionalStringSchema("Snake_case alias for handoffUid."),
  status: discussionThreadStatusSchema.describe("Optional thread status filter.").optional()
});

const listEventsInputSchema = z.object({
  handoffUid: optionalStringSchema("Optional handoff event filter."),
  handoff_uid: optionalStringSchema("Snake_case alias for handoffUid."),
  sessionUid: optionalStringSchema("Optional session event filter."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid."),
  eventType: optionalStringSchema("Optional event type filter."),
  event_type: optionalStringSchema("Snake_case alias for eventType.")
});

const listEventTypesInputSchema = z.object({
  namespace: optionalStringSchema("Optional event namespace filter.")
});

const listPolicyPacksInputSchema = z.object({
  includeInactive: optionalBooleanSchema("Include inactive policy packs."),
  include_inactive: optionalBooleanSchema("Snake_case alias for includeInactive.")
});

const policyPackIdentifierInputSchema = z.object({
  uid: optionalStringSchema("Required if name is omitted. Policy pack UID."),
  name: optionalStringSchema("Required if uid is omitted. Policy pack name.")
});

const ownedPolicyPackInputSchema = ownedSessionInputSchema.extend({
  uid: optionalStringSchema("Required if name is omitted. Policy pack UID."),
  name: optionalStringSchema("Required if uid is omitted. Policy pack name.")
});

const evaluatePolicyInputSchema = z.object({
  actionType: optionalStringSchema("Required if action_type is omitted. Action type to evaluate."),
  action_type: optionalStringSchema("Snake_case alias for actionType."),
  eventType: optionalStringSchema("Optional event type to evaluate."),
  event_type: optionalStringSchema("Snake_case alias for eventType."),
  payload: z.record(z.unknown()).describe("Token-safe hypothetical payload for dry-run evaluation.").optional()
});

const reportRuntimeMetricsInputSchema = ownedSessionInputSchema.extend({
  contextUsedTokens: optionalNumberSchema("Context tokens consumed by this session."),
  context_used_tokens: optionalNumberSchema("Snake_case alias for contextUsedTokens."),
  contextLimitTokens: optionalNumberSchema("Context window limit for this session."),
  context_limit_tokens: optionalNumberSchema("Snake_case alias for contextLimitTokens."),
  contextThresholdRatio: optionalNumberSchema("Warn when used / limit reaches this ratio."),
  context_threshold_ratio: optionalNumberSchema("Snake_case alias for contextThresholdRatio."),
  costUsd: optionalNumberSchema("Current estimated cost in USD."),
  cost_usd: optionalNumberSchema("Snake_case alias for costUsd."),
  costThresholdUsd: optionalNumberSchema("Warn when current estimated cost reaches this USD threshold."),
  cost_threshold_usd: optionalNumberSchema("Snake_case alias for costThresholdUsd.")
});

const detectStalledHandoffsInputSchema = z.object({
  thresholdMs: optionalNumberSchema("Progress inactivity threshold in milliseconds."),
  threshold_ms: optionalNumberSchema("Snake_case alias for thresholdMs.")
});

const sweepExpiredHandoffsInputSchema = z.object({});

const updateHandoffInputSchema = ownedHandoffInputSchema.extend({
  status: progressHandoffStatusSchema.describe(
    "New progress status. Use claim_handoff, release_handoff, resolve_handoff, recover_handoff, or reopen_handoff for lifecycle transitions."
  ),
  progressNote: optionalStringSchema("Required if progress_note is omitted. Progress note."),
  progress_note: optionalStringSchema("Snake_case alias for progressNote.")
});

const requestUserConfirmationInputSchema = ownedHandoffInputSchema.extend({
  question: requiredStringSchema("Question that needs user confirmation.")
});

const requestHandoffPermissionInputSchema = ownedHandoffInputSchema.extend({
  question: requiredStringSchema("Permission question or approval prompt."),
  requestedCapability: optionalStringSchema("Optional requested capability label."),
  requested_capability: optionalStringSchema("Snake_case alias for requestedCapability."),
  commandPreview: optionalStringSchema("Optional command or action preview."),
  command_preview: optionalStringSchema("Snake_case alias for commandPreview."),
  source: optionalStringSchema("Optional client/source label.")
});

const resolveHandoffInputSchema = ownedHandoffInputSchema.extend({
  summary: requiredStringSchema("Resolution summary.")
});

const recoverHandoffInputSchema = handoffUidInputSchema.extend({
  actorSessionUid: optionalStringSchema("Required if actor_session_uid is omitted. Recovery actor session identifier."),
  actor_session_uid: optionalStringSchema("Snake_case alias for actorSessionUid."),
  actorSessionToken: optionalStringSchema("Required if actor_session_token is omitted. Recovery actor session token."),
  actor_session_token: optionalStringSchema("Snake_case alias for actorSessionToken."),
  reason: requiredStringSchema("Recovery reason."),
  summary: optionalStringSchema("Required if resolution_summary is omitted. Recovery resolution summary."),
  resolutionSummary: optionalStringSchema("Alias for summary."),
  resolution_summary: optionalStringSchema("Snake_case alias for resolutionSummary."),
  evidenceVaultMemoryUid: optionalStringSchema("Required if evidence_vault_memory_uid is omitted. Vault memory evidence UID."),
  evidence_vault_memory_uid: optionalStringSchema("Snake_case alias for evidenceVaultMemoryUid.")
});

const reopenHandoffInputSchema = handoffUidInputSchema.extend({
  reason: requiredStringSchema("Reason for reopening the handoff."),
  status: handoffStatusSchema.describe("Status to reopen as. Defaults to available.").optional()
});

export const vaultCollabToolDefinitions: VaultCollabToolDefinition[] = [
  {
    name: "vault_collab_get_agent_guide",
    title: "Get Agent Guide",
    description:
      "Read the provider-neutral Vault Collab operating loop for any active agent before registering, claiming, or reporting no work.",
    inputSchema: agentGuideInputSchema
  },
  {
    name: "vault_collab_register_session",
    title: "Register Session",
    description:
      "Register a provider-neutral collaboration session and return its owner token. After registering, immediately call vault_collab_get_session_attention for this session; active sessions should use that attention feed for pings, suggested handoffs, and inbox notices.",
    inputSchema: registerSessionInputSchema
  },
  {
    name: "vault_collab_heartbeat_session",
    title: "Heartbeat Session",
    description: "Update a session heartbeat when the caller presents the owner token.",
    inputSchema: ownedSessionInputSchema
  },
  {
    name: "vault_collab_acknowledge_attention",
    title: "Acknowledge Attention",
    description: "Record the latest attention event observed by the owning session receiver.",
    inputSchema: acknowledgeAttentionInputSchema
  },
  {
    name: "vault_collab_update_session_state",
    title: "Update Session State",
    description: "Update a session status and detail when the caller presents the owner token.",
    inputSchema: updateSessionStateInputSchema
  },
  {
    name: "vault_collab_ping_session",
    title: "Ping Session",
    description:
      `${deprecatedReceivePrefix}Record a soft attention ping for a non-terminal session without waking, interrupting, or auto-claiming.`,
    inputSchema: pingSessionInputSchema
  },
  {
    name: "vault_collab_request_session_permission",
    title: "Request Session Permission",
    description: "Mark a session as awaiting user permission with a token-safe event.",
    inputSchema: permissionRequestInputSchema
  },
  {
    name: "vault_collab_list_sessions",
    title: "List Sessions",
    description: "List collaboration sessions without exposing owner tokens.",
    inputSchema: listSessionsInputSchema
  },
  {
    name: "vault_collab_get_session_attention",
    title: "Get Session Attention",
    description: "Read a token-safe attention feed for an active session without claiming or executing work.",
    inputSchema: getSessionAttentionInputSchema
  },
  {
    name: "vault_collab_receive",
    title: "Receive Attention",
    description:
      "Drain the owning session's attention feed once and advance its cursor. This is non-blocking; callers should poll or loop externally for long waits.",
    inputSchema: receiveInputSchema
  },
  {
    name: "vault_collab_list_attention_delivery_attempts",
    title: "List Attention Delivery Attempts",
    description:
      `${deprecatedReceivePrefix}List token-safe receiver delivery attempts for dashboard delivery history and failure reasons.`,
    inputSchema: listAttentionDeliveryAttemptsInputSchema
  },
  {
    name: "vault_collab_rename_session",
    title: "Rename Session",
    description: "Rename a session when the caller presents that session's owner token.",
    inputSchema: renameSessionInputSchema
  },
  {
    name: "vault_collab_close_session",
    title: "Close Session",
    description:
      "Mark a roster session disconnected as itself or as a sessionAdmin/admin actor; this does not kill external processes.",
    inputSchema: closeSessionInputSchema
  },
  {
    name: "vault_collab_disconnect_session",
    title: "Disconnect Session",
    description: "Mark a session disconnected without deleting its record.",
    inputSchema: ownedSessionInputSchema
  },
  {
    name: "vault_collab_create_launch_request",
    title: "Create Launch Request",
    description:
      "Create a durable, token-audited launch request for later approval. This records intent only; it does not spawn a process.",
    inputSchema: createLaunchRequestInputSchema
  },
  {
    name: "vault_collab_list_launch_requests",
    title: "List Launch Requests",
    description: "List durable launch requests without exposing owner tokens.",
    inputSchema: listLaunchRequestsInputSchema
  },
  {
    name: "vault_collab_get_launch_request",
    title: "Get Launch Request",
    description: "Read a durable launch request by ID.",
    inputSchema: launchRequestUidInputSchema
  },
  {
    name: "vault_collab_get_launch_request_detail",
    title: "Get Launch Request Detail",
    description: "Read a launch request with token-safe lifecycle events.",
    inputSchema: launchRequestUidInputSchema
  },
  {
    name: "vault_collab_get_launch_request_actions",
    title: "Get Launch Request Actions",
    description:
      "Read token-safe dashboard action affordances for an acting session and launch request.",
    inputSchema: ownedLaunchRequestInputSchema
  },
  {
    name: "vault_collab_approve_launch_request",
    title: "Approve Launch Request",
    description: "Approve a requested launch when the actor has launchApproval capability.",
    inputSchema: approveLaunchRequestInputSchema
  },
  {
    name: "vault_collab_reject_launch_request",
    title: "Reject Launch Request",
    description: "Reject a requested launch when the actor has launchApproval capability.",
    inputSchema: rejectLaunchRequestInputSchema
  },
  {
    name: "vault_collab_cancel_launch_request",
    title: "Cancel Launch Request",
    description: "Cancel a requested or approved launch as the requester or a launch approver.",
    inputSchema: cancelLaunchRequestInputSchema
  },
  {
    name: "vault_collab_mark_launch_request_launching",
    title: "Mark Launch Request Launching",
    description:
      `${deprecatedReceivePrefix}Move an approved launch request to launching when the actor has launchBroker capability. This does not spawn a process.`,
    inputSchema: markLaunchRequestLaunchingInputSchema
  },
  {
    name: "vault_collab_mark_launch_request_running",
    title: "Mark Launch Request Running",
    description:
      `${deprecatedReceivePrefix}Attach an already registered launched session to a launching request when the actor has launchBroker capability.`,
    inputSchema: markLaunchRequestRunningInputSchema
  },
  {
    name: "vault_collab_mark_launch_request_stopped",
    title: "Mark Launch Request Stopped",
    description:
      `${deprecatedReceivePrefix}Mark a launching or running launch request stopped after a managed worker exits normally or by user stop.`,
    inputSchema: markLaunchRequestStoppedInputSchema
  },
  {
    name: "vault_collab_fail_launch_request",
    title: "Fail Launch Request",
    description:
      `${deprecatedReceivePrefix}Mark an approved, launching, or running launch request failed as a launch broker.`,
    inputSchema: failLaunchRequestInputSchema
  },
  {
    name: "vault_collab_list_agent_roles",
    title: "List Agent Roles",
    description: "List built-in provider-neutral agent role definitions.",
    inputSchema: listAgentRolesInputSchema
  },
  {
    name: "vault_collab_upsert_agent_profile",
    title: "Upsert Agent Profile",
    description: "Create or update a durable provider-neutral agent profile.",
    inputSchema: upsertAgentProfileInputSchema
  },
  {
    name: "vault_collab_list_agent_profiles",
    title: "List Agent Profiles",
    description: "List durable agent profiles without exposing session tokens.",
    inputSchema: listAgentProfilesInputSchema
  },
  {
    name: "vault_collab_publish_handoff",
    title: "Publish Handoff",
    description: "Publish a local handoff into the target project inbox.",
    inputSchema: publishHandoffInputSchema
  },
  {
    name: "vault_collab_publish_handoff_with_vault_memory",
    title: "Publish Handoff With Vault Memory",
    description: "Save a full handoff brief to Vault memory, then publish the linked local handoff.",
    inputSchema: publishVaultLinkedHandoffInputSchema
  },
  {
    name: "vault_collab_link_vault_memory",
    title: "Link Vault Memory",
    description: "Link an existing handoff to an existing Vault memory item as the source session owner.",
    inputSchema: linkVaultMemoryInputSchema
  },
  {
    name: "vault_collab_list_inbox",
    title: "List Inbox",
    description:
      "List open handoffs for a project or lifecycle filter as a project queue snapshot. For an active registered session, prefer vault_collab_get_session_attention so session pings, suggested handoffs, claimed handoffs, and relevant discussions are not missed.",
    inputSchema: listInboxInputSchema
  },
  {
    name: "vault_collab_get_handoff",
    title: "Get Handoff",
    description: "Read a handoff by ID.",
    inputSchema: handoffUidInputSchema
  },
  {
    name: "vault_collab_get_handoff_detail",
    title: "Get Handoff Detail",
    description: "Read a handoff with lifecycle events and non-token related session snapshots.",
    inputSchema: handoffUidInputSchema
  },
  {
    name: "vault_collab_get_handoff_actions",
    title: "Get Handoff Actions",
    description: "Read token-safe dashboard action affordances for an acting session and handoff.",
    inputSchema: ownedHandoffInputSchema
  },
  {
    name: "vault_collab_update_handoff_metadata",
    title: "Update Handoff Metadata",
    description: "Update labels and queue metadata as the source or claimed session owner.",
    inputSchema: updateHandoffMetadataInputSchema
  },
  {
    name: "vault_collab_create_discussion_thread",
    title: "Create Discussion Thread",
    description:
      "Create an owner-token checked project discussion thread. Include handoffUid only for explicit handoff linkage; project-only threads do not appear in get_handoff_detail.",
    inputSchema: createDiscussionThreadInputSchema
  },
  {
    name: "vault_collab_create_handoff_discussion_thread",
    title: "Create Handoff Discussion Thread",
    description:
      "Create an owner-token checked discussion thread linked to a handoff; derives the project from the handoff so get_handoff_detail shows it.",
    inputSchema: createHandoffDiscussionThreadInputSchema
  },
  {
    name: "vault_collab_add_discussion_message",
    title: "Add Discussion Message",
    description: "Append an owner-token checked discussion message.",
    inputSchema: addDiscussionMessageInputSchema
  },
  {
    name: "vault_collab_list_discussion_threads",
    title: "List Discussion Threads",
    description: "List discussion thread summaries.",
    inputSchema: listDiscussionThreadsInputSchema
  },
  {
    name: "vault_collab_get_discussion_thread",
    title: "Get Discussion Thread",
    description: "Read a discussion thread with append-only messages.",
    inputSchema: threadUidInputSchema
  },
  {
    name: "vault_collab_list_events",
    title: "List Events",
    description: "List inspectable session and handoff event history without mutating state.",
    inputSchema: listEventsInputSchema
  },
  {
    name: "vault_collab_list_event_types",
    title: "List Event Types",
    description:
      "List the stable Vault Collab event type registry with payload shape, token-safety, and attention audience metadata.",
    inputSchema: listEventTypesInputSchema
  },
  {
    name: "vault_collab_list_policy_packs",
    title: "List Policy Packs",
    description: "List policy packs and activation state without exposing rule-editing affordances.",
    inputSchema: listPolicyPacksInputSchema
  },
  {
    name: "vault_collab_get_policy_pack",
    title: "Get Policy Pack",
    description: "Read a policy pack by UID or name, including declarative JSON rules.",
    inputSchema: policyPackIdentifierInputSchema
  },
  {
    name: "vault_collab_activate_policy_pack",
    title: "Activate Policy Pack",
    description: "Activate a policy pack when the caller is coordinator or policyAdmin.",
    inputSchema: ownedPolicyPackInputSchema
  },
  {
    name: "vault_collab_deactivate_policy_pack",
    title: "Deactivate Policy Pack",
    description: "Deactivate a policy pack when the caller is coordinator or policyAdmin.",
    inputSchema: ownedPolicyPackInputSchema
  },
  {
    name: "vault_collab_evaluate_policy",
    title: "Evaluate Policy",
    description: "Dry-run a policy evaluation against active packs without mutating counters or events.",
    inputSchema: evaluatePolicyInputSchema
  },
  {
    name: "vault_collab_report_runtime_metrics",
    title: "Report Runtime Metrics",
    description:
      "Report token-safe context and cost metrics for a session and emit warning events when configured thresholds are reached.",
    inputSchema: reportRuntimeMetricsInputSchema
  },
  {
    name: "vault_collab_detect_stalled_handoffs",
    title: "Detect Stalled Handoffs",
    description:
      "Emit loop.stall_detected events for claimed handoffs with no progress update for the configured threshold.",
    inputSchema: detectStalledHandoffsInputSchema
  },
  {
    name: "vault_collab_sweep_expired_handoffs",
    title: "Sweep Expired Handoffs",
    description:
      "Diagnostic: release handoffs whose claim lease expired and emit handoff.lease_expired events.",
    inputSchema: sweepExpiredHandoffsInputSchema
  },
  {
    name: "vault_collab_claim_handoff",
    title: "Claim Handoff",
    description: "Atomically claim an available handoff for the owning session.",
    inputSchema: ownedHandoffInputSchema
  },
  {
    name: "vault_collab_update_handoff",
    title: "Update Handoff",
    description: "Update progress for a handoff claimed by the owning session.",
    inputSchema: updateHandoffInputSchema
  },
  {
    name: "vault_collab_request_user_confirmation",
    title: "Request User Confirmation",
    description: "Move a claimed handoff to awaiting_user with a question.",
    inputSchema: requestUserConfirmationInputSchema
  },
  {
    name: "vault_collab_request_handoff_permission",
    title: "Request Handoff Permission",
    description: "Mark a claimed handoff as awaiting user permission with a token-safe event.",
    inputSchema: requestHandoffPermissionInputSchema
  },
  {
    name: "vault_collab_resolve_handoff",
    title: "Resolve Handoff",
    description: "Resolve a claimed handoff with a summary.",
    inputSchema: resolveHandoffInputSchema
  },
  {
    name: "vault_collab_recover_handoff",
    title: "Recover Handoff",
    description:
      "Audited recovery resolve for completed handoffs whose claim owner token is unavailable.",
    inputSchema: recoverHandoffInputSchema
  },
  {
    name: "vault_collab_reopen_handoff",
    title: "Reopen Handoff",
    description: "Reopen a handoff as recoverable work.",
    inputSchema: reopenHandoffInputSchema
  },
  {
    name: "vault_collab_release_handoff",
    title: "Release Handoff",
    description: "Release a claimed handoff back to the available inbox.",
    inputSchema: ownedHandoffInputSchema
  }
];

export function createVaultCollabMcpTools(
  options: CreateVaultCollabMcpToolsOptions
): VaultCollabMcpTools {
  const db = options.db ?? createCollabDatabase(options.dbPath ?? ":memory:");
  const ownsDb = !options.db;
  const events = new EventService(db, options.clock);
  const agents = new AgentProfileService(db, events, options.clock);
  const launchRequests = new LaunchRequestService(db, events, options.clock);
  const sessions = new SessionService(db, events, launchRequests, options.clock);
  const policyEngine = new PolicyEngine(db, events, options.clock);
  const toolService = new ToolService(policyEngine);
  const securityScanner = new SecurityScanner(db, events, options.clock);
  const handoffs = new HandoffService(db, events, options.clock, securityScanner, policyEngine);
  const discussions = new DiscussionService(db, events, options.clock);
  const handoffDetails = new HandoffDetailService(handoffs, events, sessions, discussions);
  const attention = new AttentionService(
    db,
    sessions,
    handoffs,
    discussions,
    events,
    launchRequests,
    policyEngine
  );
  const attentionReceiver = new AttentionReceiverService(
    db,
    sessions,
    attention,
    {
      name: "reader",
      canDeliver: () => false,
      deliver: async () => ({
        delivered: false,
        message: "Reader adapter cannot deliver."
      })
    },
    options.clock
  );
  const linkedHandoffs = options.vaultMemoryClient
    ? new VaultLinkedHandoffService(handoffs, options.vaultMemoryClient)
    : null;
  const availableDefinitions = linkedHandoffs
    ? vaultCollabToolDefinitions
    : vaultCollabToolDefinitions.filter(
        (definition) => definition.name !== vaultMemoryLinkedPublishToolName
      );
  const availableToolNames = new Set(availableDefinitions.map((definition) => definition.name));
  const autoHeartbeats = new AutoHeartbeatManager(
    sessions,
    options.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs
  );

  const handlers: Record<
    VaultCollabToolName,
    (args: Record<string, unknown>) => unknown | Promise<unknown>
  > = {
    vault_collab_get_agent_guide: (args) =>
      getAgentOperatingGuide({
        clientType: optionalClientType(args, "clientType", "client_type") ?? null,
        project: optionalString(args, "project") ?? null
      }),
    vault_collab_register_session: (args) => {
      const registered = sessions.registerSession({
        displayName: requiredString(args, "displayName", "display_name"),
        clientType: requiredClientType(args, "clientType", "client_type"),
        project: requiredString(args, "project"),
        workspacePath: requiredString(args, "workspacePath", "workspace_path"),
        role: optionalString(args, "role"),
        roleProfileId: optionalString(args, "roleProfileId", "role_profile_id") ?? null,
        agentUid: optionalString(args, "agentUid", "agent_uid") ?? null,
        capabilities: optionalRecord(args, "capabilities") ?? {},
        delivery: {
          mode:
            optionalSessionDeliveryMode(args, "deliveryMode", "delivery_mode") ?? "manual_poll",
          wakeable:
            optionalBoolean(args, "deliveryWakeable", "delivery_wakeable") ?? false
        }
      });
      autoHeartbeats.start(registered.sessionUid, registered.sessionToken);
      return withAttentionNextAction(registered);
    },
    vault_collab_heartbeat_session: (args) =>
      sessions.heartbeatSession(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token")
      ),
    vault_collab_acknowledge_attention: (args) =>
      sessions.acknowledgeAttention(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredNumber(args, "latestEventId", "latest_event_id")
      ),
    vault_collab_update_session_state: (args) =>
      sessions.updateSessionState(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredSessionStatus(args, "status"),
        optionalString(args, "detail", "statusDetail", "status_detail") ?? null
      ),
    vault_collab_ping_session: (args) =>
      sessions.pingSession(requiredString(args, "targetSessionUid", "target_session_uid"), {
        actorSessionUid: optionalString(args, "actorSessionUid", "actor_session_uid") ?? null,
        message: optionalString(args, "message") ?? null
      }),
    vault_collab_request_session_permission: (args) =>
      sessions.requestSessionPermission(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        {
          question: requiredString(args, "question"),
          requestedCapability:
            optionalString(args, "requestedCapability", "requested_capability") ?? null,
          commandPreview: optionalString(args, "commandPreview", "command_preview") ?? null,
          source: optionalString(args, "source") ?? null
        }
      ),
    vault_collab_list_sessions: (args) =>
      sessions.listSessions({
        project: optionalString(args, "project"),
        clientType: optionalClientType(args, "clientType", "client_type"),
        status: optionalSessionStatus(args, "status")
      }),
    vault_collab_get_session_attention: (args) =>
      attention.getSessionAttention(requiredString(args, "sessionUid", "session_uid"), {
        sinceEventId: optionalNumber(args, "sinceEventId", "since_event_id"),
        includeCurrentHandoffs:
          optionalBoolean(args, "includeCurrentHandoffs", "include_current_handoffs") ?? true
      }),
    vault_collab_receive: (args) =>
      attention.receiveOnce(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        {
          includeCurrentHandoffs:
            optionalBoolean(args, "includeCurrentHandoffs", "include_current_handoffs") ?? true,
          advanceCursor: optionalBoolean(args, "advanceCursor", "advance_cursor") ?? true
        }
      ),
    vault_collab_list_attention_delivery_attempts: (args) =>
      attentionReceiver.listDeliveryAttempts({
        sessionUid: optionalString(args, "sessionUid", "session_uid"),
        status: optionalAttentionDeliveryAttemptStatus(args, "status")
      }),
    vault_collab_rename_session: (args) =>
      sessions.renameSession(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "displayName", "display_name")
      ),
    vault_collab_close_session: (args) =>
      sessions.closeSession(
        requiredString(args, "targetSessionUid", "target_session_uid"),
        requiredString(args, "actorSessionUid", "actor_session_uid"),
        requiredString(args, "actorSessionToken", "actor_session_token"),
        optionalString(args, "reason") ?? null
      ),
    vault_collab_disconnect_session: (args) => {
      const sessionUid = requiredString(args, "sessionUid", "session_uid");
      const disconnected = sessions.disconnectSession(
        sessionUid,
        requiredString(args, "sessionToken", "session_token")
      );
      autoHeartbeats.stop(sessionUid);
      return disconnected;
    },
    vault_collab_create_launch_request: (args) =>
      launchRequests.createLaunchRequest({
        requestedBySessionUid: requiredString(args, "sessionUid", "session_uid"),
        sessionToken: requiredString(args, "sessionToken", "session_token"),
        provider: requiredClientType(args, "provider"),
        model: requiredString(args, "model"),
        effortLevel: optionalString(args, "effortLevel", "effort_level") ?? null,
        project: requiredString(args, "project"),
        workspacePath: requiredString(args, "workspacePath", "workspace_path"),
        role: optionalString(args, "role") ?? null,
        roleProfileId: optionalString(args, "roleProfileId", "role_profile_id") ?? null,
        initialInstructions: requiredString(args, "initialInstructions", "initial_instructions"),
        permissionMode: requiredString(args, "permissionMode", "permission_mode"),
        commandPreview: optionalString(args, "commandPreview", "command_preview") ?? null,
        requestedCapabilities:
          optionalStringArray(args, "requestedCapabilities", "requested_capabilities") ?? [],
        approvalPolicyVersion:
          optionalString(args, "approvalPolicyVersion", "approval_policy_version") ?? null,
        metadata: optionalRecord(args, "metadata") ?? {}
      }),
    vault_collab_list_launch_requests: (args) =>
      launchRequests.listLaunchRequests({
        project: optionalString(args, "project"),
        provider: optionalClientType(args, "provider"),
        status: optionalLaunchRequestStatus(args, "status"),
        requestedBySessionUid:
          optionalString(args, "requestedBySessionUid", "requested_by_session_uid") ?? undefined
      }),
    vault_collab_get_launch_request: (args) =>
      launchRequests.getLaunchRequest(requiredString(args, "launchRequestUid", "launch_request_uid")),
    vault_collab_get_launch_request_detail: (args) =>
      launchRequests.getLaunchRequestDetail(
        requiredString(args, "launchRequestUid", "launch_request_uid")
      ),
    vault_collab_get_launch_request_actions: (args) =>
      launchRequests.getLaunchRequestActions(
        requiredString(args, "launchRequestUid", "launch_request_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token")
      ),
    vault_collab_approve_launch_request: (args) =>
      launchRequests.approveLaunchRequest(
        requiredString(args, "launchRequestUid", "launch_request_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        optionalString(args, "detail") ?? null
      ),
    vault_collab_reject_launch_request: (args) =>
      launchRequests.rejectLaunchRequest(
        requiredString(args, "launchRequestUid", "launch_request_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "reason")
      ),
    vault_collab_cancel_launch_request: (args) =>
      launchRequests.cancelLaunchRequest(
        requiredString(args, "launchRequestUid", "launch_request_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "reason")
      ),
    vault_collab_mark_launch_request_launching: (args) =>
      launchRequests.markLaunchRequestLaunching(
        requiredString(args, "launchRequestUid", "launch_request_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        optionalString(args, "detail") ?? null
      ),
    vault_collab_mark_launch_request_running: (args) =>
      launchRequests.markLaunchRequestRunning(
        requiredString(args, "launchRequestUid", "launch_request_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "launchedSessionUid", "launched_session_uid"),
        optionalString(args, "detail") ?? null
      ),
    vault_collab_mark_launch_request_stopped: (args) =>
      launchRequests.markLaunchRequestStopped(
        requiredString(args, "launchRequestUid", "launch_request_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        optionalString(args, "detail") ?? null,
        optionalNumber(args, "exitCode", "exit_code") ?? null
      ),
    vault_collab_fail_launch_request: (args) =>
      launchRequests.failLaunchRequest(
        requiredString(args, "launchRequestUid", "launch_request_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "reason")
      ),
    vault_collab_list_agent_roles: () => agents.listRoleDefinitions(),
    vault_collab_upsert_agent_profile: (args) =>
      agents.upsertAgentProfile({
        stableName: requiredString(args, "stableName", "stable_name"),
        displayName: requiredString(args, "displayName", "display_name"),
        role: optionalString(args, "role") ?? "implementer",
        roleProfileId: optionalString(args, "roleProfileId", "role_profile_id") ?? null,
        clientType: optionalClientType(args, "clientType", "client_type") ?? null,
        project: optionalString(args, "project") ?? null,
        description: optionalString(args, "description") ?? null,
        capabilities: optionalRecord(args, "capabilities") ?? {},
        status: optionalAgentProfileStatus(args, "status") ?? "active",
        createdBySessionUid:
          optionalString(args, "createdBySessionUid", "created_by_session_uid") ?? null
      }),
    vault_collab_list_agent_profiles: (args) =>
      agents.listAgentProfiles({
        project: optionalString(args, "project"),
        role: optionalString(args, "role"),
        status: optionalAgentProfileStatus(args, "status")
      }),
    vault_collab_publish_handoff: (args) =>
      handoffs.publishHandoff({
        shortPrompt: requiredString(args, "shortPrompt", "short_prompt"),
        sourceProject: requiredString(args, "sourceProject", "source_project"),
        targetProject: requiredString(args, "targetProject", "target_project"),
        relatedProjects: optionalStringArray(args, "relatedProjects", "related_projects") ?? [],
        relatedFiles: optionalStringArray(args, "relatedFiles", "related_files") ?? [],
        sourceSessionUid: optionalString(args, "sourceSessionUid", "source_session_uid") ?? null,
        suggestedSessionUid:
          optionalString(args, "suggestedSessionUid", "suggested_session_uid") ?? null,
        suggestedClientType:
          optionalClientType(args, "suggestedClientType", "suggested_client_type") ?? null,
        suggestedRoleProfileId:
          optionalString(args, "suggestedRoleProfileId", "suggested_role_profile_id") ?? null,
        vaultMemoryUid: optionalString(args, "vaultMemoryUid", "vault_memory_uid") ?? null,
        queueKey: optionalString(args, "queueKey", "queue_key") ?? undefined,
        labels: optionalStringArray(args, "labels") ?? undefined,
        queuePosition: optionalNumber(args, "queuePosition", "queue_position") ?? undefined,
        dependsOnHandoffUid:
          optionalString(args, "dependsOnHandoffUid", "depends_on_handoff_uid") ?? null,
        priority: optionalHandoffPriority(args, "priority") ?? "normal",
        urgent: optionalBoolean(args, "urgent") ?? false,
        typedPayload: optionalRecord(args, "typedPayload", "typed_payload") ?? null
      }),
    vault_collab_publish_handoff_with_vault_memory: (args) => {
      if (!linkedHandoffs) {
        throw new Error(vaultLinkedPublishUnavailableMessage());
      }

      return linkedHandoffs.publishHandoffWithVaultMemory({
        shortPrompt: requiredString(args, "shortPrompt", "short_prompt"),
        fullBrief: requiredString(args, "fullBrief", "full_brief"),
        sourceProject: requiredString(args, "sourceProject", "source_project"),
        targetProject: requiredString(args, "targetProject", "target_project"),
        relatedProjects: optionalStringArray(args, "relatedProjects", "related_projects") ?? [],
        relatedFiles: optionalStringArray(args, "relatedFiles", "related_files") ?? [],
        sourceSessionUid: optionalString(args, "sourceSessionUid", "source_session_uid") ?? null,
        suggestedSessionUid:
          optionalString(args, "suggestedSessionUid", "suggested_session_uid") ?? null,
        suggestedClientType:
          optionalClientType(args, "suggestedClientType", "suggested_client_type") ?? null,
        suggestedRoleProfileId:
          optionalString(args, "suggestedRoleProfileId", "suggested_role_profile_id") ?? null,
        queueKey: optionalString(args, "queueKey", "queue_key") ?? undefined,
        labels: optionalStringArray(args, "labels") ?? undefined,
        queuePosition: optionalNumber(args, "queuePosition", "queue_position") ?? undefined,
        dependsOnHandoffUid:
          optionalString(args, "dependsOnHandoffUid", "depends_on_handoff_uid") ?? null,
        priority: optionalHandoffPriority(args, "priority") ?? "normal",
        urgent: optionalBoolean(args, "urgent") ?? false,
        typedPayload: optionalRecord(args, "typedPayload", "typed_payload") ?? null,
        vaultProject: optionalString(args, "vaultProject", "vault_project"),
        vaultTitle: optionalString(args, "vaultTitle", "vault_title"),
        vaultSubject: optionalString(args, "vaultSubject", "vault_subject"),
        keywords: optionalStringArray(args, "keywords") ?? undefined,
        tags: optionalStringArray(args, "tags") ?? undefined,
        nextSteps: optionalStringArray(args, "nextSteps", "next_steps") ?? undefined
      });
    },
    vault_collab_link_vault_memory: (args) =>
      handoffs.linkVaultMemoryFromSession(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "vaultMemoryUid", "vault_memory_uid")
      ),
    vault_collab_list_inbox: (args) =>
      handoffs.listInbox({
        sourceProject: optionalString(args, "sourceProject", "source_project"),
        targetProject: optionalString(args, "targetProject", "target_project"),
        queueKey: optionalString(args, "queueKey", "queue_key"),
        label: optionalString(args, "label"),
        status: optionalHandoffStatus(args, "status"),
        includeResolved: optionalBoolean(args, "includeResolved", "include_resolved") ?? false
      }),
    vault_collab_get_handoff: (args) =>
      handoffs.getHandoff(requiredString(args, "handoffUid", "handoff_uid")),
    vault_collab_get_handoff_detail: (args) =>
      handoffDetails.getHandoffDetail(requiredString(args, "handoffUid", "handoff_uid")),
    vault_collab_get_handoff_actions: (args) =>
      handoffs.getHandoffActions(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token")
      ),
    vault_collab_update_handoff_metadata: (args) =>
      handoffs.updateHandoffMetadata(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        {
          queueKey: optionalString(args, "queueKey", "queue_key"),
          labels: optionalStringArray(args, "labels"),
          queuePosition: optionalNumber(args, "queuePosition", "queue_position"),
          dependsOnHandoffUid: optionalString(
            args,
            "dependsOnHandoffUid",
            "depends_on_handoff_uid"
          )
        }
      ),
    vault_collab_create_discussion_thread: (args) =>
      discussions.createThread({
        project: requiredString(args, "project"),
        handoffUid: optionalString(args, "handoffUid", "handoff_uid") ?? null,
        title: requiredString(args, "title"),
        createdBySessionUid: requiredString(args, "sessionUid", "session_uid"),
        sessionToken: requiredString(args, "sessionToken", "session_token")
      }),
    vault_collab_create_handoff_discussion_thread: (args) =>
      discussions.createHandoffThread({
        handoffUid: requiredString(args, "handoffUid", "handoff_uid"),
        title: requiredString(args, "title"),
        createdBySessionUid: requiredString(args, "sessionUid", "session_uid"),
        sessionToken: requiredString(args, "sessionToken", "session_token")
      }),
    vault_collab_add_discussion_message: (args) =>
      discussions.addMessage(
        requiredString(args, "threadUid", "thread_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        {
          messageType: requiredDiscussionMessageType(args, "messageType", "message_type"),
          body: requiredString(args, "body"),
          metadata: optionalRecord(args, "metadata") ?? {}
        }
      ),
    vault_collab_list_discussion_threads: (args) =>
      discussions.listThreads({
        project: optionalString(args, "project"),
        handoffUid: optionalString(args, "handoffUid", "handoff_uid"),
        status: optionalDiscussionThreadStatus(args, "status")
      }),
    vault_collab_get_discussion_thread: (args) =>
      discussions.getThread(requiredString(args, "threadUid", "thread_uid")),
    vault_collab_list_events: (args) =>
      events.listEvents({
        handoffUid: optionalString(args, "handoffUid", "handoff_uid"),
        sessionUid: optionalString(args, "sessionUid", "session_uid"),
        eventType: optionalString(args, "eventType", "event_type")
      }),
    vault_collab_list_event_types: (args) => {
      const namespace = optionalString(args, "namespace");
      const eventTypes = events.listEventTypes();
      return namespace
        ? eventTypes.filter((eventType) => eventType.namespace === namespace)
        : eventTypes;
    },
    vault_collab_list_policy_packs: (args) =>
      policyEngine.listPolicyPacks({
        includeInactive: optionalBoolean(args, "includeInactive", "include_inactive") ?? true
      }).map((pack) => ({
        uid: pack.uid,
        name: pack.name,
        version: pack.version,
        active: pack.active,
        isBuiltin: pack.isBuiltin,
        createdAt: pack.createdAt,
        ruleCount: pack.rules.length
      })),
    vault_collab_get_policy_pack: (args) =>
      policyEngine.getPolicyPack({
        uid: optionalString(args, "uid"),
        name: optionalString(args, "name")
      }),
    vault_collab_activate_policy_pack: (args) =>
      policyEngine.activatePolicyPack(
        {
          uid: optionalString(args, "uid"),
          name: optionalString(args, "name")
        },
        {
          sessionUid: requiredString(args, "sessionUid", "session_uid"),
          sessionToken: requiredString(args, "sessionToken", "session_token")
        }
      ),
    vault_collab_deactivate_policy_pack: (args) =>
      policyEngine.deactivatePolicyPack(
        {
          uid: optionalString(args, "uid"),
          name: optionalString(args, "name")
        },
        {
          sessionUid: requiredString(args, "sessionUid", "session_uid"),
          sessionToken: requiredString(args, "sessionToken", "session_token")
        }
      ),
    vault_collab_evaluate_policy: (args) =>
      policyEngine.evaluate({
        actionType: requiredString(args, "actionType", "action_type"),
        eventType: optionalString(args, "eventType", "event_type") ?? null,
        payload: optionalRecord(args, "payload") ?? {},
        dryRun: true
      }),
    vault_collab_report_runtime_metrics: (args) =>
      sessions.reportRuntimeMetrics(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        {
          contextUsedTokens:
            optionalNumber(args, "contextUsedTokens", "context_used_tokens") ?? null,
          contextLimitTokens:
            optionalNumber(args, "contextLimitTokens", "context_limit_tokens") ?? null,
          contextThresholdRatio:
            optionalNumber(args, "contextThresholdRatio", "context_threshold_ratio") ?? null,
          costUsd: optionalNumber(args, "costUsd", "cost_usd") ?? null,
          costThresholdUsd:
            optionalNumber(args, "costThresholdUsd", "cost_threshold_usd") ?? null
        }
      ),
    vault_collab_detect_stalled_handoffs: (args) => {
      const emittedEvents = handoffs.detectStalledHandoffs({
        thresholdMs: optionalNumber(args, "thresholdMs", "threshold_ms") ?? 10 * 60_000
      });
      return {
        emittedEvents,
        count: emittedEvents.length
      };
    },
    vault_collab_sweep_expired_handoffs: () => {
      const released = handoffs.sweepExpiredLeases();
      return {
        released,
        count: released.length
      };
    },
    vault_collab_claim_handoff: (args) =>
      handoffs.claimHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token")
      ),
    vault_collab_update_handoff: (args) =>
      handoffs.updateHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredProgressHandoffStatus(args, "status"),
        requiredString(args, "progressNote", "progress_note")
      ),
    vault_collab_request_user_confirmation: (args) =>
      handoffs.requestUserConfirmation(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "question")
      ),
    vault_collab_request_handoff_permission: (args) =>
      handoffs.requestHandoffPermission(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        {
          question: requiredString(args, "question"),
          requestedCapability:
            optionalString(args, "requestedCapability", "requested_capability") ?? null,
          commandPreview: optionalString(args, "commandPreview", "command_preview") ?? null,
          source: optionalString(args, "source") ?? null
        }
      ),
    vault_collab_resolve_handoff: (args) =>
      handoffs.resolveHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "summary")
      ),
    vault_collab_recover_handoff: (args) =>
      handoffs.recoverHandoff(requiredString(args, "handoffUid", "handoff_uid"), {
        actorSessionUid: requiredString(args, "actorSessionUid", "actor_session_uid"),
        actorSessionToken: requiredString(args, "actorSessionToken", "actor_session_token"),
        reason: requiredString(args, "reason"),
        resolutionSummary: requiredString(args, "summary", "resolutionSummary", "resolution_summary"),
        evidenceVaultMemoryUid: requiredString(
          args,
          "evidenceVaultMemoryUid",
          "evidence_vault_memory_uid"
        )
      }),
    vault_collab_reopen_handoff: (args) =>
      handoffs.reopenHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "reason"),
        optionalHandoffStatus(args, "status") ?? "available"
      ),
    vault_collab_release_handoff: (args) =>
      handoffs.releaseHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token")
      )
  };

  return {
    definitions: availableDefinitions,
    callTool: async (name, args) => {
      recordToolCallEvent(events, "tool.call_before", name, args);
      if (!isVaultCollabToolName(name)) {
        recordToolCallEvent(events, "tool.call_failure", name, args, {
          ok: false,
          errorClass: "UnknownTool"
        });
        return errorResult(`Unknown Vault Collab tool: ${name}`);
      }
      if (!availableToolNames.has(name)) {
        recordToolCallEvent(events, "tool.call_failure", name, args, {
          ok: false,
          errorClass: "UnavailableTool"
        });
        return errorResult(vaultLinkedPublishUnavailableMessage());
      }

      try {
        toolService.enforceBeforeExecution(name, args);
        const result = await handlers[name](args);
        recordToolCallEvent(events, "tool.call_after", name, args, {
          ok: true
        });
        return successResult(result);
      } catch (error) {
        recordToolCallEvent(events, "tool.call_failure", name, args, {
          ok: false,
          errorClass: error instanceof Error ? error.name : typeof error
        });
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
    close: () => {
      autoHeartbeats.close();
      if (ownsDb) {
        db.close();
      }
    }
  };
}

function recordToolCallEvent(
  events: EventService,
  eventType: "tool.call_before" | "tool.call_after" | "tool.call_failure",
  toolName: string,
  args: Record<string, unknown>,
  extra: JsonRecord = {}
): void {
  events.recordEvent({
    eventType,
    payload: {
      toolName,
      ...toolAuditPayload(args),
      ...extra
    }
  });
}

function toolAuditPayload(args: Record<string, unknown>): JsonRecord {
  const argumentKeys: string[] = [];
  const redactedArgumentKeys: string[] = [];

  for (const key of Object.keys(args)) {
    if (isForbiddenTokenKey(key)) {
      redactedArgumentKeys.push(key);
    } else {
      argumentKeys.push(key);
    }
  }

  return {
    actorSessionUid: firstStringArg(args, "sessionUid", "session_uid", "actorSessionUid", "actor_session_uid") ?? null,
    project:
      firstStringArg(args, "project", "targetProject", "target_project", "sourceProject", "source_project") ??
      null,
    argumentKeys,
    redactedArgumentKeys
  };
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

function isVaultCollabToolName(name: string): name is VaultCollabToolName {
  return (vaultCollabToolNames as readonly string[]).includes(name);
}

function vaultLinkedPublishUnavailableMessage(): string {
  return [
    "Vault-linked handoff publishing is not available because this server was started without a VaultMemoryClient.",
    "Use vault_save_memory through Vault MCP to save the full brief, then call vault_collab_publish_handoff with vaultMemoryUid."
  ].join(" ");
}

function successResult(result: unknown): VaultCollabToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: {
      result
    }
  };
}

function errorResult(message: string): VaultCollabToolResult {
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    structuredContent: {
      result: {
        error: message
      }
    },
    isError: true
  };
}

function requiredString(args: Record<string, unknown>, ...keys: string[]): string {
  const value = optionalValue(args, keys);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required string: ${keys[0]}`);
  }

  return value;
}

function optionalString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = optionalValue(args, keys);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected string: ${keys[0]}`);
  }

  return value;
}

function optionalBoolean(args: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  const value = optionalValue(args, keys);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean: ${keys[0]}`);
  }

  return value;
}

function optionalNumber(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = optionalValue(args, keys);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected number: ${keys[0]}`);
  }

  return value;
}

function requiredNumber(args: Record<string, unknown>, ...keys: string[]): number {
  const value = optionalNumber(args, ...keys);
  if (value === undefined) {
    throw new Error(`Missing required number: ${keys[0]}`);
  }

  return value;
}

function optionalStringArray(args: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  const value = optionalValue(args, keys);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected string array: ${keys[0]}`);
  }

  return value;
}

function optionalRecord(args: Record<string, unknown>, ...keys: string[]): JsonRecord | undefined {
  const value = optionalValue(args, keys);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`Expected object: ${keys[0]}`);
  }

  return value;
}

function optionalValue(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      return args[key];
    }
  }

  return undefined;
}

function requiredClientType(args: Record<string, unknown>, ...keys: string[]): ClientType {
  return parseClientType(requiredString(args, ...keys));
}

function optionalClientType(args: Record<string, unknown>, ...keys: string[]): ClientType | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseClientType(value) : undefined;
}

function parseClientType(value: string): ClientType {
  if (!clientTypeValues.includes(value as (typeof clientTypeValues)[number])) {
    throw new Error(`Invalid client type: ${value}`);
  }

  return value as ClientType;
}

function requiredSessionStatus(args: Record<string, unknown>, ...keys: string[]): SessionStatus {
  return parseSessionStatus(requiredString(args, ...keys));
}

function optionalSessionStatus(
  args: Record<string, unknown>,
  ...keys: string[]
): SessionStatus | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseSessionStatus(value) : undefined;
}

function parseSessionStatus(value: string): SessionStatus {
  if (!sessionStatusValues.includes(value as (typeof sessionStatusValues)[number])) {
    throw new Error(`Invalid session status: ${value}`);
  }

  return value as SessionStatus;
}

function optionalSessionDeliveryMode(
  args: Record<string, unknown>,
  ...keys: string[]
): SessionDeliveryMode | undefined {
  const value = optionalString(args, ...keys);
  if (!value) {
    return undefined;
  }

  if (!sessionDeliveryModeValues.includes(value as (typeof sessionDeliveryModeValues)[number])) {
    throw new Error(`Invalid session delivery mode: ${value}`);
  }

  return value as SessionDeliveryMode;
}

function optionalAttentionDeliveryAttemptStatus(
  args: Record<string, unknown>,
  ...keys: string[]
): AttentionDeliveryAttemptStatus | undefined {
  const value = optionalString(args, ...keys);
  if (!value) {
    return undefined;
  }

  if (
    !attentionDeliveryAttemptStatusValues.includes(
      value as (typeof attentionDeliveryAttemptStatusValues)[number]
    )
  ) {
    throw new Error(`Invalid attention delivery attempt status: ${value}`);
  }

  return value as AttentionDeliveryAttemptStatus;
}

function requiredHandoffStatus(args: Record<string, unknown>, ...keys: string[]): HandoffStatus {
  return parseHandoffStatus(requiredString(args, ...keys));
}

function requiredProgressHandoffStatus(
  args: Record<string, unknown>,
  ...keys: string[]
): HandoffStatus {
  const value = requiredString(args, ...keys);
  if (!progressHandoffStatuses.includes(value as (typeof progressHandoffStatuses)[number])) {
    throw new Error(
      `Invalid handoff progress status: ${value}. Use the dedicated lifecycle handoff tools for available, claimed, resolved, abandoned, or stale.`
    );
  }

  return value as HandoffStatus;
}

function optionalHandoffStatus(
  args: Record<string, unknown>,
  ...keys: string[]
): HandoffStatus | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseHandoffStatus(value) : undefined;
}

function parseHandoffStatus(value: string): HandoffStatus {
  if (!handoffStatusValues.includes(value as (typeof handoffStatusValues)[number])) {
    throw new Error(`Invalid handoff status: ${value}`);
  }

  return value as HandoffStatus;
}

function optionalHandoffPriority(
  args: Record<string, unknown>,
  ...keys: string[]
): HandoffPriority | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseHandoffPriority(value) : undefined;
}

function parseHandoffPriority(value: string): HandoffPriority {
  if (!handoffPriorityValues.includes(value as (typeof handoffPriorityValues)[number])) {
    throw new Error(`Invalid handoff priority: ${value}`);
  }

  return value as HandoffPriority;
}

function optionalLaunchRequestStatus(
  args: Record<string, unknown>,
  ...keys: string[]
): LaunchRequestStatus | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseLaunchRequestStatus(value) : undefined;
}

function parseLaunchRequestStatus(value: string): LaunchRequestStatus {
  if (!launchRequestStatusValues.includes(value as (typeof launchRequestStatusValues)[number])) {
    throw new Error(`Invalid launch request status: ${value}`);
  }

  return value as LaunchRequestStatus;
}

function optionalAgentProfileStatus(
  args: Record<string, unknown>,
  ...keys: string[]
): AgentProfileStatus | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseAgentProfileStatus(value) : undefined;
}

function parseAgentProfileStatus(value: string): AgentProfileStatus {
  if (!agentProfileStatusValues.includes(value as (typeof agentProfileStatusValues)[number])) {
    throw new Error(`Invalid agent profile status: ${value}`);
  }

  return value as AgentProfileStatus;
}

function optionalDiscussionThreadStatus(
  args: Record<string, unknown>,
  ...keys: string[]
): DiscussionThreadStatus | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseDiscussionThreadStatus(value) : undefined;
}

function parseDiscussionThreadStatus(value: string): DiscussionThreadStatus {
  if (
    !discussionThreadStatusValues.includes(value as (typeof discussionThreadStatusValues)[number])
  ) {
    throw new Error(`Invalid discussion thread status: ${value}`);
  }

  return value as DiscussionThreadStatus;
}

function requiredDiscussionMessageType(
  args: Record<string, unknown>,
  ...keys: string[]
): DiscussionMessageType {
  const value = requiredString(args, ...keys);
  if (
    !discussionMessageTypeValues.includes(value as (typeof discussionMessageTypeValues)[number])
  ) {
    throw new Error(`Invalid discussion message type: ${value}`);
  }

  return value as DiscussionMessageType;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
