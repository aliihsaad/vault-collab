import type { AttentionItemKind, CoreRoleProfileId, JsonRecord } from "./types.js";

export type EventNamespace =
  | "session"
  | "handoff"
  | "tool"
  | "permission"
  | "discussion"
  | "memory"
  | "security"
  | "policy"
  | "context"
  | "cost"
  | "risk"
  | "loop"
  | "launch_request"
  | "agent_profile";

export type EventAttentionScope =
  | "none"
  | "session"
  | "handoff"
  | "project"
  | "project_role";

export interface EventTypeDefinition {
  canonicalName: string;
  namespace: EventNamespace;
  summary: string;
  payloadShape: JsonRecord;
  tokenSafety: {
    forbiddenPayloadKeys: string[];
    rules: string[];
  };
  attention: {
    scope: EventAttentionScope;
    itemKind: AttentionItemKind | null;
    roleProfileIds: CoreRoleProfileId[];
  };
  legacyAliases: string[];
}

const forbiddenPayloadKeys = [
  "sessionToken",
  "session_token",
  "ownerToken",
  "owner_token",
  "claimToken",
  "claim_token",
  "actorSessionToken",
  "actor_session_token",
  "adapterToken",
  "adapter_token"
];

const tokenSafety = {
  forbiddenPayloadKeys,
  rules: [
    "Never include owner tokens, session tokens, claim tokens, or adapter tokens in event payloads.",
    "Payloads may include stable UIDs, project labels, statuses, counts, thresholds, and redacted argument-key metadata.",
    "Tool events must never include raw arguments, raw results, or exception text that contains owner-token values."
  ]
};

function define(
  canonicalName: string,
  namespace: EventNamespace,
  summary: string,
  payloadShape: JsonRecord,
  attention: EventTypeDefinition["attention"],
  legacyAliases: string[] = []
): EventTypeDefinition {
  return {
    canonicalName,
    namespace,
    summary,
    payloadShape,
    tokenSafety,
    attention,
    legacyAliases
  };
}

const noAttention = {
  scope: "none",
  itemKind: null,
  roleProfileIds: []
} as const satisfies EventTypeDefinition["attention"];

const sessionAttention = (itemKind: AttentionItemKind): EventTypeDefinition["attention"] => ({
  scope: "session",
  itemKind,
  roleProfileIds: []
});

const handoffAttention = (itemKind: AttentionItemKind): EventTypeDefinition["attention"] => ({
  scope: "handoff",
  itemKind,
  roleProfileIds: []
});

const roleAttention = (
  itemKind: AttentionItemKind,
  roleProfileIds: CoreRoleProfileId[]
): EventTypeDefinition["attention"] => ({
  scope: "project_role",
  itemKind,
  roleProfileIds
});

export const eventTypeRegistry: EventTypeDefinition[] = [
  define("session.registered", "session", "A provider-neutral session joined a project.", {
    clientType: "ClientType",
    project: "string"
  }, noAttention),
  define("session.heartbeat", "session", "A session heartbeat was recorded.", {
    heartbeatAt: "ISO timestamp, optional"
  }, noAttention),
  define("session.state_updated", "session", "A session status/detail changed.", {
    status: "SessionStatus",
    detail: "string | null"
  }, noAttention),
  define("session.attention_acknowledged", "session", "A session receiver advanced its attention cursor.", {
    latestEventId: "number",
    acknowledgedAt: "ISO timestamp"
  }, noAttention),
  define("session.pinged", "session", "A passive soft ping targets a session.", {
    actorSessionUid: "vc_sess_* | null",
    message: "string | null",
    createdAt: "ISO timestamp"
  }, sessionAttention("session_ping")),
  define(
    "permission.session_requested",
    "permission",
    "A session needs user permission before continuing.",
    {
      permissionRequest: "Token-safe question/capability/action preview"
    },
    sessionAttention("session_permission"),
    ["session.permission_requested"]
  ),
  define("session.disconnected", "session", "A session was marked disconnected.", {
    actorSessionUid: "vc_sess_* | null",
    reason: "string | null"
  }, noAttention),
  define("session.cleanup", "session", "Inactive session records were removed from the roster.", {
    actorSessionUid: "vc_sess_*",
    statuses: "SessionStatus[]",
    deletedSessionUids: "vc_sess_*[]",
    deletedSessionCount: "number",
    deletedCursorCount: "number",
    deletedDeliveryAttemptCount: "number"
  }, noAttention),
  define("session.renamed", "session", "A session display name changed.", {
    previousDisplayName: "string",
    displayName: "string"
  }, noAttention),
  define("session.snapshot_reported", "session", "A session or adapter reported its latest HUD snapshot.", {
    schemaVersion: "vault_collab.session.v1",
    adapterId: "string",
    adapterType: "native | adapter_backed | instruction_backed",
    project: "string",
    state: "string",
    riskLevel: "low | medium | high | critical | unknown",
    activeHandoffCount: "number",
    progressPercent: "number | null",
    snapshotReportedAt: "ISO timestamp",
    payloadKeys: "string[]"
  }, noAttention),

  define("handoff.published", "handoff", "A handoff was published to an inbox.", {
    sourceProject: "string",
    targetProject: "string",
    priority: "HandoffPriority",
    urgent: "boolean",
    typedPayloadSchemaVersion: "string | null"
  }, noAttention),
  define("handoff.claimed", "handoff", "A session claimed available work.", {
    claimedBySessionUid: "vc_sess_*, optional legacy payload may be empty"
  }, noAttention),
  define("handoff.updated", "handoff", "Claimed handoff progress/status changed.", {
    status: "HandoffStatus",
    progressNote: "string"
  }, noAttention),
  define("handoff.metadata_updated", "handoff", "Queue labels or dependency metadata changed.", {
    queueKey: "string | undefined",
    labels: "string[] | undefined",
    queuePosition: "number | null | undefined",
    dependsOnHandoffUid: "vc_handoff_* | null | undefined"
  }, noAttention),
  define("handoff.user_confirmation_requested", "handoff", "A claimed handoff needs user confirmation.", {
    question: "string"
  }, handoffAttention("handoff_permission")),
  define(
    "permission.handoff_requested",
    "permission",
    "A claimed handoff needs user permission before continuing.",
    {
      permissionRequest: "Token-safe question/capability/action preview"
    },
    handoffAttention("handoff_permission"),
    ["handoff.permission_requested"]
  ),
  define("handoff.released", "handoff", "A claimed handoff was released back to the inbox.", {
    reason: "string | null, optional legacy payload may be empty"
  }, noAttention),
  define("handoff.resolved", "handoff", "A claimed handoff completed.", {
    summary: "string"
  }, noAttention),
  define("handoff.recovery_resolved", "handoff", "A source or recovery-capable session resolved stranded work.", {
    reason: "string",
    summary: "string",
    evidenceVaultMemoryUid: "vm_*",
    previousClaimedBySessionUid: "vc_sess_* | null",
    previousStatus: "HandoffStatus",
    actorAuthorizedBy: "source_session | recovery_capability"
  }, noAttention),
  define("handoff.reopened", "handoff", "A closed handoff was reopened as recoverable work.", {
    reason: "string",
    targetStatus: "HandoffStatus"
  }, noAttention),
  define("handoff.lease_expired", "handoff", "A claim lease expired and the handoff returned to available.", {
    priorClaimedBySessionUid: "vc_sess_* | null",
    reason: "lease_expired",
    sweptAt: "ISO timestamp"
  }, noAttention),

  define("tool.call_before", "tool", "An MCP tool call is about to run.", {
    toolName: "string",
    actorSessionUid: "vc_sess_* | null",
    project: "string | null",
    argumentKeys: "string[]",
    redactedArgumentKeys: "string[]"
  }, noAttention),
  define("tool.call_after", "tool", "An MCP tool call completed successfully.", {
    toolName: "string",
    actorSessionUid: "vc_sess_* | null",
    project: "string | null",
    ok: "true"
  }, noAttention),
  define("tool.call_failure", "tool", "An MCP tool call failed.", {
    toolName: "string",
    actorSessionUid: "vc_sess_* | null",
    project: "string | null",
    ok: "false",
    errorClass: "string"
  }, roleAttention("tool_failure", ["coordinator", "runtime-loop-operator"])),

  define("discussion.thread_created", "discussion", "A discussion thread was created.", {
    project: "string",
    handoffUid: "vc_handoff_* | null",
    title: "string"
  }, noAttention),
  define("discussion.message_added", "discussion", "A discussion message was appended.", {
    threadUid: "vc_thread_*",
    messageUid: "vc_msg_*",
    messageType: "DiscussionMessageType"
  }, handoffAttention("discussion_message")),

  define(
    "memory.handoff_linked",
    "memory",
    "A Vault memory item was linked to a handoff.",
    {
      vaultMemoryUid: "vm_*"
    },
    noAttention,
    ["handoff.vault_memory_linked"]
  ),
  define("memory.save_requested", "memory", "A Vault-linked handoff save was requested.", {
    project: "string",
    memoryType: "string",
    title: "string"
  }, noAttention),

  define("security.finding", "security", "A deterministic security scan finding needs review.", {
    project: "string",
    scanUid: "security scan identifier",
    domain: "SecurityScanDomain",
    severity: "low | medium | high | critical",
    findingCode: "stable finding code",
    findingSummary: "token-safe summary",
    evidenceCount: "number",
    evidencePackVaultMemoryUid: "vm_* | null, optional"
  }, roleAttention("security_finding", ["coordinator", "security-reviewer"])),

  define(
    "policy.agent_profile_upserted",
    "policy",
    "An agent profile or role-policy surface changed.",
    {
      agentUid: "vc_agent_*"
    },
    noAttention,
    ["agent_profile.upserted"]
  ),
  define("policy.security_notice", "policy", "A security or governance notice needs review.", {
    project: "string",
    severity: "low | medium | high | critical",
    finding: "string"
  }, roleAttention("policy_notice", ["coordinator", "security-reviewer"])),
  define("policy.rule_triggered", "policy", "A policy rule matched an action or event payload.", {
    actionType: "string",
    eventType: "string | null",
    decision: "PolicyDecisionKind",
    policyPackUid: "policy_pack_*",
    policyPackName: "string",
    policyRuleUid: "string",
    enforcement: "allow | deny | warn | require_approval | rate_limit",
    reason: "string",
    payloadKeys: "string[]"
  }, noAttention),
  define("policy.violation", "policy", "A policy rule denied, gated, or rate-limited an action.", {
    actionType: "string",
    eventType: "string | null",
    decision: "deny | require_approval | rate_limited",
    policyPackUid: "policy_pack_*",
    policyPackName: "string",
    policyRuleUid: "string",
    enforcement: "deny | require_approval | rate_limit",
    reason: "string",
    payloadKeys: "string[]"
  }, roleAttention("policy_notice", ["coordinator", "security-reviewer"])),
  define("policy.approved", "policy", "A coordinator-approved policy-gated action was accepted.", {
    actionType: "string",
    eventType: "string | null",
    decision: "approved",
    approvedBySessionUid: "vc_sess_* | null"
  }, noAttention),

  define("context.limit_warning", "context", "A session is approaching its context limit.", {
    project: "string",
    usageRatio: "number",
    thresholdRatio: "number",
    remainingTokens: "number"
  }, roleAttention("context_warning", ["coordinator", "runtime-loop-operator"])),
  define("cost.threshold_warning", "cost", "A session crossed or approached a configured cost threshold.", {
    project: "string",
    costUsd: "number",
    thresholdUsd: "number"
  }, roleAttention("cost_warning", ["coordinator", "runtime-loop-operator", "release-agent"])),
  define("risk.critical_reported", "risk", "A session snapshot reported critical risk.", {
    project: "string",
    reportedSessionUid: "vc_sess_*",
    adapterId: "string",
    adapterType: "native | adapter_backed | instruction_backed",
    riskLevel: "critical",
    reasons: "string[]",
    snapshotReportedAt: "ISO timestamp"
  }, roleAttention("risk_critical", ["coordinator", "runtime-loop-operator"])),
  define("loop.stall_detected", "loop", "A claimed handoff has not received progress for the configured threshold.", {
    project: "string",
    handoffUid: "vc_handoff_*",
    claimedBySessionUid: "vc_sess_* | null",
    status: "HandoffStatus",
    lastProgressAt: "ISO timestamp",
    stalledForMs: "number",
    thresholdMs: "number"
  }, roleAttention("loop_stall", ["coordinator", "runtime-loop-operator"])),

  define("launch_request.requested", "launch_request", "Legacy launch request lifecycle event.", {
    launchRequestUid: "vc_launch_*"
  }, noAttention),
  define("launch_request.approved", "launch_request", "Legacy launch request lifecycle event.", {
    launchRequestUid: "vc_launch_*"
  }, noAttention),
  define("launch_request.rejected", "launch_request", "Legacy launch request lifecycle event.", {
    launchRequestUid: "vc_launch_*"
  }, noAttention),
  define("launch_request.cancelled", "launch_request", "Legacy launch request lifecycle event.", {
    launchRequestUid: "vc_launch_*"
  }, noAttention),
  define("launch_request.launching", "launch_request", "Legacy launch request lifecycle event.", {
    launchRequestUid: "vc_launch_*"
  }, noAttention),
  define("launch_request.running", "launch_request", "Legacy launch request lifecycle event.", {
    launchRequestUid: "vc_launch_*"
  }, noAttention),
  define("launch_request.stopped", "launch_request", "Legacy launch request lifecycle event.", {
    launchRequestUid: "vc_launch_*"
  }, noAttention),
  define("launch_request.failed", "launch_request", "Legacy launch request lifecycle event.", {
    launchRequestUid: "vc_launch_*"
  }, noAttention),
  define("agent_profile.upserted", "agent_profile", "Legacy agent profile policy event.", {
    agentUid: "vc_agent_*"
  }, noAttention)
];

const eventTypesByName = new Map<string, EventTypeDefinition>();
for (const definition of eventTypeRegistry) {
  eventTypesByName.set(definition.canonicalName, definition);
  for (const alias of definition.legacyAliases) {
    eventTypesByName.set(alias, definition);
  }
}

export function getEventTypeDefinition(eventType: string): EventTypeDefinition | null {
  return eventTypesByName.get(eventType) ?? null;
}

export function assertTokenSafePayload(payload: unknown): void {
  assertTokenSafeValue(payload, "payload");
}

export function redactTokenUnsafeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactTokenUnsafeValue(item));
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const redacted: JsonRecord = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = isForbiddenTokenKey(key)
      ? "[REDACTED]"
      : redactTokenUnsafeValue(nestedValue);
  }
  return redacted;
}

export function isForbiddenTokenKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return new Set([
    "token",
    "sessiontoken",
    "ownertoken",
    "claimtoken",
    "actorsessiontoken",
    "adaptertoken"
  ]).has(normalized);
}

function assertTokenSafeValue(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertTokenSafeValue(item, `${path}[${index}]`));
    return;
  }

  if (!isPlainRecord(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (isForbiddenTokenKey(key)) {
      throw new Error(`Event payload contains forbidden token key: ${nestedPath}`);
    }
    assertTokenSafeValue(nestedValue, nestedPath);
  }
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
