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

export const SessionAdapterType = {
  Native: "native",
  AdapterBacked: "adapter_backed",
  InstructionBacked: "instruction_backed"
} as const;

export type SessionAdapterType =
  (typeof SessionAdapterType)[keyof typeof SessionAdapterType];

export const sessionAdapterTypes = [
  SessionAdapterType.Native,
  SessionAdapterType.AdapterBacked,
  SessionAdapterType.InstructionBacked
] as const;

export type SessionSnapshotState = SessionStatus | "unknown";
export type SessionSnapshotRiskLevel = "low" | "medium" | "high" | "critical" | "unknown";
export type SessionSnapshotCompactionRisk = SessionSnapshotRiskLevel;

export type JsonRecord = Record<string, unknown>;

export type SecurityFindingSeverity = "low" | "medium" | "high" | "critical";

export type SecurityScanDomain =
  | "sessions"
  | "handoffs"
  | "discussions"
  | "vault-memory-links"
  | "mcp-configs"
  | "connector-permissions"
  | "dashboard-affordances"
  | "owner-token-handling"
  | "launch-broker-actions"
  | "direct-db-writers"
  | "external-action-settings";

export interface GateGuardAssessment {
  required: boolean;
  riskLevel: SecurityFindingSeverity;
  reason: string;
  factsRequired: string[];
  findingCodes: string[];
}

/**
 * @deprecated Push/wake delivery modes are superseded by the pull-based receive
 * loop. Keep these values for dashboard compatibility until the push broker is
 * removed in a later migration.
 */
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

export const coreRoleProfileIds = [
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
] as const;

export type CoreRoleProfileId = (typeof coreRoleProfileIds)[number];
export type RoleProfileStatus = "active" | "archived";
export type RoleMutationPolicy =
  | "read_only"
  | "coordination_write"
  | "workspace_write"
  | "approval_required";
export type RoleSupportLevel =
  | "native"
  | "adapter_backed"
  | "instruction_backed"
  | "reference_only";
export type RoleCapability =
  | "read_files"
  | "search_files"
  | "inspect_graph"
  | "vault_memory_read"
  | "vault_memory_write"
  | "vault_collab_read"
  | "vault_collab_write"
  | "sessionAdmin"
  | "publish_handoff"
  | "claim_handoff"
  | "create_discussion"
  | "run_tests"
  | "browser_check"
  | "edit_files"
  | "shell_commands"
  | "security_scan"
  | "release_coordination"
  | "pattern_mining"
  | "external_connector_review"
  | "resolve_loop";

export type EvidenceKind =
  | "source_files"
  | "vault_memory"
  | "graph_context"
  | "test_output"
  | "diff_summary"
  | "runtime_artifact"
  | "security_findings"
  | "acceptance_criteria"
  | "discussion_decision";

export interface RoleToolGrant {
  capability: RoleCapability;
  defaultAllowed: boolean;
  approvalRequired: boolean;
  notes?: string;
}

export interface RoleOutputContract {
  primary: string;
  requiredFields: string[];
  vaultMemoryType?: "artifact" | "plan" | "decision" | "handoff" | "summary" | "session";
  publishesHandoff?: boolean;
}

export interface RoleDependencyRule {
  roleProfileId: CoreRoleProfileId;
  reason: string;
  blocksCompletionUntil?: boolean;
}

export interface RoleConfidenceGate {
  gate: string;
  required: boolean;
  failureStatus?: "blocked" | "awaiting_user" | "verification_needed";
}

export interface RoleProviderSupport {
  clientType: ClientType;
  supportLevel: RoleSupportLevel;
  defaultPermissionMode?: string | null;
  notes?: string | null;
}

export interface RoleSkillReference {
  skill: string;
  path: string;
  triggerCondition: string;
}

export interface RoleProfileSkills {
  primary: RoleSkillReference[];
  secondary: RoleSkillReference[];
}

export interface RoleProfile {
  roleProfileId: CoreRoleProfileId;
  schemaVersion: "vault_collab.role_profile.v1";
  displayName: string;
  purpose: string;
  lifecycleStage:
    | "coordination"
    | "discovery"
    | "planning"
    | "implementation"
    | "review"
    | "verification"
    | "operations"
    | "release"
    | "learning";
  defaultMutation: RoleMutationPolicy;
  capabilitySet: RoleCapability[];
  toolGrants: RoleToolGrant[];
  triggerLabels: string[];
  requiresEvidence: EvidenceKind[];
  outputContract: RoleOutputContract;
  stopConditions: string[];
  confidenceGates: RoleConfidenceGate[];
  requiresRoles: RoleDependencyRule[];
  suggestedRoles: RoleDependencyRule[];
  suggestedNextRoles: CoreRoleProfileId[];
  skills: RoleProfileSkills;
  providerSupport: RoleProviderSupport[];
  status: RoleProfileStatus;
}

export interface RoleLabelRoute {
  routeUid: string;
  label: string;
  roleProfileId: CoreRoleProfileId;
  requirementKind: "suggested" | "required";
  priority: number;
  evidenceRequired: EvidenceKind[];
  blocksCompletion: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentProfileStatus = "active" | "archived";

export interface AgentRoleDefinition {
  role: string;
  roleProfileId: string;
  label: string;
  description: string;
  defaultMutation: RoleMutationPolicy;
  triggerLabels: string[];
}

export interface UpsertAgentProfileInput {
  stableName: string;
  displayName: string;
  role?: string;
  roleProfileId?: string | null;
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
  roleProfileId: string | null;
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
  role?: string;
  roleProfileId?: string | null;
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
  role: string;
  roleProfileId: string | null;
  status: SessionStatus;
  statusDetail: string | null;
  capabilities: JsonRecord;
  agentUid: string | null;
  agentName: string | null;
  agentDisplayName: string | null;
  agentRole: string | null;
  currentHandoffUid: string | null;
  delivery: SessionDeliveryState;
  adapterType: SessionAdapterType;
  lastSnapshot: VaultCollabSessionSnapshotV1 | null;
  snapshotReportedAt: string | null;
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

export interface RuntimeMetricsInput {
  contextUsedTokens?: number | null;
  contextLimitTokens?: number | null;
  contextThresholdRatio?: number | null;
  costUsd?: number | null;
  costThresholdUsd?: number | null;
}

export interface VaultCollabSessionSnapshotWorkspaceV1 {
  path: string;
  projectKey?: string | null;
}

export interface VaultCollabSessionSnapshotContextV1 {
  model: string | null;
  provider: string | null;
  tokensUsed: number | null;
  tokensRemaining: number | null;
  compactionRisk: SessionSnapshotCompactionRisk;
}

export interface VaultCollabSessionSnapshotHandoffV1 {
  handoffUid: string;
  status: HandoffStatus | "unknown";
  progressNote: string | null;
  claimedAt: string | null;
}

export interface VaultCollabSessionSnapshotProgressV1 {
  currentTask: string | null;
  percentComplete: number | null;
  blockers: string[];
}

export interface VaultCollabSessionSnapshotCostV1 {
  estimatedUSD: number | null;
  tokensTotal: number | null;
}

export interface VaultCollabSessionSnapshotRiskV1 {
  level: SessionSnapshotRiskLevel;
  reasons: string[];
}

export interface VaultCollabSessionSnapshotToolGrantV1 {
  toolName: string;
  scope: string;
  grantedAt: string | null;
}

export interface VaultCollabSessionSnapshotCapabilitiesV1 {
  canMutateHandoffs: boolean;
  canPublishHandoffs: boolean;
  canSendMessages: boolean;
  adapterType: SessionAdapterType;
}

export interface VaultCollabSessionSnapshotSyncCursorV1 {
  lastEventId: number | null;
  lastHeartbeatAt: string | null;
}

export interface VaultCollabSessionSnapshotV1 {
  schemaVersion: "vault_collab.session.v1";
  adapterId: string;
  sessionUid: string;
  project: string;
  workspace: VaultCollabSessionSnapshotWorkspaceV1;
  state: SessionSnapshotState;
  context: VaultCollabSessionSnapshotContextV1;
  active_handoffs: VaultCollabSessionSnapshotHandoffV1[];
  progress: VaultCollabSessionSnapshotProgressV1;
  cost: VaultCollabSessionSnapshotCostV1;
  risk: VaultCollabSessionSnapshotRiskV1;
  tool_grants: VaultCollabSessionSnapshotToolGrantV1[];
  capabilities: VaultCollabSessionSnapshotCapabilitiesV1;
  sync_cursor: VaultCollabSessionSnapshotSyncCursorV1;
}

export interface ReportSessionInput {
  sessionUid: string;
  sessionToken?: string | null;
  adapterToken?: string | null;
  snapshot: unknown;
}

export interface ReportSessionResult {
  session: SessionSnapshot;
  snapshot: VaultCollabSessionSnapshotV1;
  emittedEvents: EventRecord[];
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
  | "tool_failure"
  | "policy_notice"
  | "security_finding"
  | "context_warning"
  | "cost_warning"
  | "risk_critical"
  | "loop_stall"
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

export interface ReceiveOptions extends SessionAttentionOptions {
  advanceCursor?: boolean;
}

export interface WaitForAttentionOptions extends ReceiveOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ReceiveResult {
  session: SessionSnapshot;
  fromEventId: number;
  toEventId: number;
  items: SessionAttentionItem[];
  drained: boolean;
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
  roleProfileId?: string | null;
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
  roleProfileId: string | null;
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

/**
 * @deprecated Broker execution transitions are superseded by pull-based session
 * coordination. Creation, approval, rejection, and cancellation remain active
 * control-plane coordination records.
 */
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

export const discoveryHandoffSchemaVersion = "vault_collab.discovery_handoff.v1" as const;

export type DiscoveryHandoffSchemaVersion = typeof discoveryHandoffSchemaVersion;
export type DiscoveryHandoffType =
  | "discovery"
  | "research"
  | "implementation"
  | "review"
  | "qa"
  | "architecture";
export type DiscoveryHandoffWritePolicy = "read_only" | "workspace_write" | "approval_required";
export type DiscoveryHandoffConfidence = "low" | "medium" | "high";

export interface DiscoveryHandoffScope {
  include: string[];
  exclude: string[];
  workspace: string;
  write_policy: DiscoveryHandoffWritePolicy;
}

export interface DiscoveryHandoffContextRefs {
  vault_memory_uids: string[];
  related_files: string[];
  graph_nodes: string[];
  discussion_threads: string[];
}

export interface DiscoveryHandoffEvidenceContract {
  method: string;
  required_sources: string[];
  confidence_required: DiscoveryHandoffConfidence;
  separate_fact_inference: boolean;
}

export interface DiscoveryHandoffTaskStep {
  id: string;
  description: string;
  required: boolean;
}

export interface DiscoveryHandoffDeliverables {
  vault_memory: {
    memory_type: "artifact" | "handoff" | "decision" | "session" | "plan" | "summary" | "reference";
    title: string;
    tags: string[];
  };
  publish_followup_handoff: boolean;
}

export interface DiscoveryHandoffVerification {
  required: string[];
  not_required: string[];
}

export interface DiscoveryHandoffRiskControls {
  permission_required_for: string[];
  secrets_policy: string;
}

export interface DiscoveryHandoffCompletion {
  resolution_summary_required: boolean;
  next_handoff_labels: string[];
}

export interface DiscoveryHandoffSuggestedExecutor {
  client_type: ClientType;
  role: string;
  capabilities: string[];
}

export interface DiscoveryHandoffPayload {
  schema_version: DiscoveryHandoffSchemaVersion;
  handoff_type: DiscoveryHandoffType;
  objective: string;
  scope: DiscoveryHandoffScope;
  context_refs: DiscoveryHandoffContextRefs;
  evidence_contract: DiscoveryHandoffEvidenceContract;
  task_steps: DiscoveryHandoffTaskStep[];
  acceptance_criteria: string[];
  deliverables: DiscoveryHandoffDeliverables;
  verification: DiscoveryHandoffVerification;
  risk_controls: DiscoveryHandoffRiskControls;
  completion: DiscoveryHandoffCompletion;
  suggested_executor: DiscoveryHandoffSuggestedExecutor;
}

export type HandoffTypedPayload = DiscoveryHandoffPayload | JsonRecord;

export interface HandoffTemplateRecord {
  templateUid: string;
  schemaVersion: "vault_collab.handoff_template.v1";
  templateKey: string;
  roleProfileId: string | null;
  name: string;
  description: string | null;
  handoffType: DiscoveryHandoffType;
  typedPayload: HandoffTypedPayload;
  labels: string[];
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

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
  suggestedRoleProfileId?: string | null;
  vaultMemoryUid?: string | null;
  queueKey?: string;
  labels?: string[];
  queuePosition?: number | null;
  dependsOnHandoffUid?: string | null;
  priority?: HandoffPriority;
  urgent?: boolean;
  typedPayload?: HandoffTypedPayload | null;
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
  suggestedRoleProfileId: string | null;
  queueKey: string;
  labels: string[];
  queuePosition: number | null;
  dependsOnHandoffUid: string | null;
  typedPayload: HandoffTypedPayload | null;
  status: HandoffStatus;
  priority: HandoffPriority;
  urgent: boolean;
  claimedBySessionUid: string | null;
  /**
   * ISO timestamp for the claim lease. Defaults to now + VAULT_COLLAB_LEASE_TTL_MS,
   * or five minutes when the environment variable is unset or invalid.
   */
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
  gateGuard: GateGuardAssessment;
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
