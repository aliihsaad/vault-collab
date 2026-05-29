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

export type HandoffPriority = "low" | "normal" | "high" | "urgent";

export interface PublishHandoffInput {
  shortPrompt: string;
  sourceProject: string;
  targetProject: string;
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
