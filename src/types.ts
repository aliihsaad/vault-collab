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

export interface RegisterSessionInput {
  displayName: string;
  clientType: ClientType;
  project: string;
  workspacePath: string;
  capabilities?: JsonRecord;
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

export interface HandoffFilters {
  sourceProject?: string;
  targetProject?: string;
  status?: HandoffStatus;
  includeResolved?: boolean;
}
