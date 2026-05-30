export type ClientType =
  | "codex"
  | "claude-code"
  | "claude-desktop"
  | "octogent"
  | "gemini"
  | "opencode"
  | "other";

export type SessionStatus =
  | "idle"
  | "working"
  | "blocked"
  | "awaiting_user"
  | "awaiting_verification"
  | "complete"
  | "disconnected";

export type JsonRecord = Record<string, unknown>;

export type SessionDeliveryMode =
  | "manual_poll"
  | "local_watch"
  | "mcp_notification"
  | "managed_process";

export interface SessionDeliveryState {
  mode: SessionDeliveryMode;
  wakeable: boolean;
  lastAckEventId: number | null;
  lastAckAt: string | null;
}

export type BuiltInAgentRole =
  | "coordinator"
  | "implementer"
  | "reviewer"
  | "sweeper"
  | "observer";

export type AgentProfileStatus = "active" | "archived";

export interface AgentRoleDefinition {
  role: BuiltInAgentRole;
  label: string;
  description: string;
}

export interface UpsertAgentProfileInput {
  stableName: string;
  displayName: string;
  role?: string;
  clientType?: ClientType | null;
  project?: string | null;
  description?: string | null;
  capabilities?: JsonRecord;
  status?: AgentProfileStatus;
  createdBySessionUid?: string | null;
}

export interface AgentProfile {
  agentUid: string;
  stableName: string;
  displayName: string;
  role: string;
  clientType: ClientType | null;
  project: string | null;
  description: string | null;
  capabilities: JsonRecord;
  status: AgentProfileStatus;
  createdBySessionUid: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface AgentProfileFilters {
  project?: string;
  role?: string;
  status?: AgentProfileStatus;
}

export interface RegisterSessionInput {
  displayName: string;
  clientType: ClientType;
  project: string;
  workspacePath: string;
  capabilities?: JsonRecord;
  agentUid?: string | null;
  delivery?: {
    mode?: SessionDeliveryMode;
    wakeable?: boolean;
  };
}

export interface SessionSnapshot {
  sessionUid: string;
  displayName: string;
  clientType: ClientType;
  project: string;
  workspacePath: string;
  status: SessionStatus;
  statusDetail: string | null;
  capabilities: JsonRecord;
  agentUid: string | null;
  agentName: string | null;
  agentDisplayName: string | null;
  agentRole: string | null;
  currentHandoffUid: string | null;
  delivery: SessionDeliveryState;
  lastHeartbeatAt: string;
  createdAt: string;
  updatedAt: string;
  disconnectedAt: string | null;
}

export interface RegisteredSession extends SessionSnapshot {
  sessionToken: string;
}

export interface SessionFilters {
  project?: string;
  clientType?: ClientType;
  status?: SessionStatus;
}

export interface PingSessionInput {
  actorSessionUid?: string | null;
  message?: string | null;
}

export interface PingSessionResult {
  event: EventRecord;
  targetSession: SessionSnapshot;
  delivery: {
    mode: SessionDeliveryMode;
    wakeable: boolean;
    delivered: false;
    nextStep: string;
  };
}

export interface PermissionRequestInput {
  question: string;
  requestedCapability?: string | null;
  commandPreview?: string | null;
  source?: string | null;
}

export interface EventRecord {
  eventId: number;
  handoffUid: string | null;
  sessionUid: string | null;
  eventType: string;
  payload: JsonRecord;
  createdAt: string;
}

export type AttentionItemKind =
  | "session_ping"
  | "session_permission"
  | "handoff_permission"
  | "launch_request"
  | "discussion_message"
  | "suggested_handoff"
  | "claimed_handoff"
  | "claimed_by_other_handoff"
  | "available_handoff";

export interface SessionAttentionOptions {
  sinceEventId?: number;
  includeCurrentHandoffs?: boolean;
}

export interface SessionAttentionItem {
  kind: AttentionItemKind;
  event: EventRecord | null;
  handoff: HandoffRecord | null;
  launchRequest: LaunchRequestRecord | null;
  createdAt: string;
}

export interface SessionAttentionFeed {
  session: SessionSnapshot;
  sinceEventId: number;
  latestEventId: number;
  items: SessionAttentionItem[];
}

export interface AttentionDeliveryBatch {
  session: SessionSnapshot;
  fromEventId: number;
  toEventId: number;
  items: SessionAttentionItem[];
  message: string;
}

export interface AttentionDeliveryAdapterResult {
  delivered: boolean;
  message?: string | null;
}

export type AttentionDeliveryAttemptStatus = "delivered" | "failed";

export interface AttentionDeliveryAttempt {
  attemptUid: string;
  sessionUid: string;
  fromEventId: number;
  toEventId: number;
  deliveryMode: SessionDeliveryMode;
  adapter: string;
  status: AttentionDeliveryAttemptStatus;
  message: string | null;
  createdAt: string;
  deliveredAt: string | null;
  failedAt: string | null;
}

export interface AttentionDeliveryAttemptFilters {
  sessionUid?: string;
  status?: AttentionDeliveryAttemptStatus;
}

export type LaunchRequestStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "cancelled"
  | "launching"
  | "running"
  | "stopped"
  | "failed";

export const launchRequestStatuses = [
  "requested",
  "approved",
  "rejected",
  "cancelled",
  "launching",
  "running",
  "stopped",
  "failed"
] as const satisfies readonly LaunchRequestStatus[];

export interface CreateLaunchRequestInput {
  requestedBySessionUid: string;
  sessionToken: string;
  provider: ClientType;
  model: string;
  effortLevel?: string | null;
  project: string;
  workspacePath: string;
  role?: string | null;
  initialInstructions: string;
  permissionMode: string;
  commandPreview?: string | null;
  requestedCapabilities?: string[];
  approvalPolicyVersion?: string | null;
  metadata?: JsonRecord;
}

export interface LaunchRequestRecord {
  launchRequestUid: string;
  provider: ClientType;
  model: string;
  effortLevel: string | null;
  project: string;
  workspacePath: string;
  role: string | null;
  initialInstructions: string;
  permissionMode: string;
  commandPreview: string | null;
  requestedCapabilities: string[];
  approvalPolicyVersion: string | null;
  approvalSnapshot: JsonRecord | null;
  status: LaunchRequestStatus;
  statusDetail: string | null;
  requestedBySessionUid: string;
  approvedBySessionUid: string | null;
  rejectedBySessionUid: string | null;
  brokerSessionUid: string | null;
  launchedSessionUid: string | null;
  metadata: JsonRecord;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface LaunchRequestFilters {
  project?: string;
  provider?: ClientType;
  status?: LaunchRequestStatus;
  requestedBySessionUid?: string;
}

export interface LaunchRequestDetail {
  launchRequest: LaunchRequestRecord;
  events: EventRecord[];
}

export type LaunchRequestActionKind =
  | "approve"
  | "reject"
  | "cancel"
  | "mark_launching"
  | "mark_running"
  | "stop"
  | "fail";

export interface LaunchRequestActionAffordance {
  kind: LaunchRequestActionKind;
  enabled: boolean;
  reason: string;
  toolName: string;
  requiredCapability: string | null;
  requiresOwnerToken: true;
  requiresReason: boolean;
  requiresLaunchedSessionUid: boolean;
}

export interface LaunchRequestActionSet {
  launchRequest: LaunchRequestRecord;
  actingSessionUid: string;
  actions: LaunchRequestActionAffordance[];
}

export type HandoffStatus =
  | "available"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "awaiting_user"
  | "verification_needed"
  | "resolved"
  | "abandoned"
  | "stale";

export const progressHandoffStatuses = [
  "in_progress",
  "blocked",
  "awaiting_user",
  "verification_needed"
] as const satisfies readonly HandoffStatus[];

export type HandoffPriority = "low" | "normal" | "high" | "urgent";

export interface PublishHandoffInput {
  shortPrompt: string;
  sourceProject: string;
  targetProject: string;
  /**
   * Explicit related project labels for cross-project routing. When omitted or
   * empty, publishing defaults this to sourceProject + targetProject; when
   * provided, this list replaces that default.
   */
  relatedProjects?: string[];
  relatedFiles?: string[];
  sourceSessionUid?: string | null;
  suggestedSessionUid?: string | null;
  suggestedClientType?: ClientType | null;
  vaultMemoryUid?: string | null;
  queueKey?: string;
  labels?: string[];
  queuePosition?: number | null;
  dependsOnHandoffUid?: string | null;
  priority?: HandoffPriority;
  urgent?: boolean;
}

export interface PublishVaultLinkedHandoffInput extends PublishHandoffInput {
  fullBrief: string;
  vaultProject?: string;
  vaultTitle?: string;
  vaultSubject?: string;
  keywords?: string[];
  tags?: string[];
  nextSteps?: string[];
}

export interface HandoffRecord {
  handoffUid: string;
  vaultMemoryUid: string | null;
  shortPrompt: string;
  sourceProject: string;
  targetProject: string;
  relatedProjects: string[];
  relatedFiles: string[];
  sourceSessionUid: string | null;
  suggestedSessionUid: string | null;
  suggestedClientType: ClientType | null;
  queueKey: string;
  labels: string[];
  queuePosition: number | null;
  dependsOnHandoffUid: string | null;
  status: HandoffStatus;
  priority: HandoffPriority;
  urgent: boolean;
  claimedBySessionUid: string | null;
  leaseExpiresAt: string | null;
  progressNote: string | null;
  resolutionSummary: string | null;
  reopenReason: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  staleAt: string | null;
}

export type HandoffActionKind =
  | "claim"
  | "update"
  | "request_user_confirmation"
  | "request_handoff_permission"
  | "release"
  | "resolve"
  | "recover"
  | "reopen";

export interface HandoffActionAffordance {
  kind: HandoffActionKind;
  enabled: boolean;
  reason: string;
  toolName: string;
  requiredCapability: string | null;
  requiresOwnerToken: boolean;
  requiresProgressNote: boolean;
  requiresQuestion: boolean;
  requiresReason: boolean;
  requiresSummary: boolean;
  requiresEvidenceVaultMemoryUid: boolean;
}

export interface HandoffActionSet {
  handoff: HandoffRecord;
  actingSessionUid: string;
  actions: HandoffActionAffordance[];
}

export interface HandoffDetail {
  handoff: HandoffRecord;
  events: EventRecord[];
  discussionThreads: DiscussionThreadSummary[];
  sessions: {
    sourceSession: SessionSnapshot | null;
    suggestedSession: SessionSnapshot | null;
    claimedBySession: SessionSnapshot | null;
  };
}

export interface HandoffFilters {
  sourceProject?: string;
  targetProject?: string;
  queueKey?: string;
  label?: string;
  status?: HandoffStatus;
  includeResolved?: boolean;
}

export interface UpdateHandoffMetadataInput {
  queueKey?: string;
  labels?: string[];
  queuePosition?: number | null;
  dependsOnHandoffUid?: string | null;
}

export interface RecoverHandoffInput {
  actorSessionUid: string;
  actorSessionToken: string;
  reason: string;
  resolutionSummary: string;
  evidenceVaultMemoryUid: string;
}

export type DiscussionThreadStatus = "open" | "resolved";

export type DiscussionMessageType =
  | "note"
  | "question"
  | "proposal"
  | "concern"
  | "decision"
  | "system";

export interface CreateDiscussionThreadInput {
  project: string;
  title: string;
  createdBySessionUid: string;
  sessionToken: string;
  handoffUid?: string | null;
}

export interface CreateHandoffDiscussionThreadInput {
  handoffUid: string;
  title: string;
  createdBySessionUid: string;
  sessionToken: string;
}

export interface AddDiscussionMessageInput {
  messageType: DiscussionMessageType;
  body: string;
  metadata?: JsonRecord;
}

export interface DiscussionThreadFilters {
  project?: string;
  handoffUid?: string;
  status?: DiscussionThreadStatus;
}

export interface DiscussionThreadSummary {
  threadUid: string;
  handoffUid: string | null;
  project: string;
  title: string;
  status: DiscussionThreadStatus;
  createdBySessionUid: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  messageCount: number;
  lastMessageAt: string | null;
}

export interface DiscussionMessage {
  messageUid: string;
  threadUid: string;
  sessionUid: string | null;
  agentUid: string | null;
  messageType: DiscussionMessageType;
  body: string;
  metadata: JsonRecord;
  createdAt: string;
}

export interface DiscussionThreadDetail extends DiscussionThreadSummary {
  messages: DiscussionMessage[];
}
