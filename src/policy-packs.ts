import type { JsonRecord } from "./types.js";

export type PolicyEnforcement = "allow" | "deny" | "warn" | "require_approval" | "rate_limit";

export type PolicyDecisionKind =
  | "allow"
  | "approved"
  | "deny"
  | "warn"
  | "require_approval"
  | "rate_limited";

export type PolicyCondition =
  | { op: "always" }
  | { op: "never" }
  | { op: "exists"; path: string }
  | { op: "missing"; path: string }
  | { op: "equals"; path: string; value: unknown }
  | { op: "not_equals"; path: string; value: unknown }
  | { op: "in"; path: string; values: unknown[] }
  | { op: "contains"; path: string; value: string }
  | { op: "matches"; path: string; pattern: string; flags?: string }
  | { op: "has_forbidden_token_key"; path?: string }
  | { op: "all"; conditions: PolicyCondition[] }
  | { op: "any"; conditions: PolicyCondition[] }
  | { op: "not"; condition: PolicyCondition };

export interface PolicyRuleTrigger {
  actionType?: string;
  eventType?: string;
}

export interface PolicyRateLimit {
  keyPath: string;
  limit: number;
  windowMs: number;
}

export interface PolicyRule {
  uid: string;
  description: string;
  trigger: PolicyRuleTrigger;
  condition: PolicyCondition;
  enforcement: PolicyEnforcement;
  reason?: string;
  rateLimit?: PolicyRateLimit;
}

export interface PolicyPackDefinition {
  uid: string;
  name: string;
  version: string;
  rules: PolicyRule[];
  active: boolean;
  isBuiltin: boolean;
}

export interface PolicyPackRecord extends PolicyPackDefinition {
  createdAt: string;
}

export interface PolicyRuleEvaluation {
  packUid: string;
  packName: string;
  ruleUid: string;
  enforcement: PolicyEnforcement;
  reason: string;
}

export interface PolicyEvaluation {
  actionType: string;
  eventType: string | null;
  allowed: boolean;
  decision: PolicyDecisionKind;
  approvalRequired: boolean;
  rateLimited: boolean;
  warnings: string[];
  violations: string[];
  triggeredRules: PolicyRuleEvaluation[];
}

export interface PolicyEvaluationInput {
  actionType: string;
  eventType?: string | null;
  payload?: JsonRecord;
  dryRun?: boolean;
}

export const builtInPolicyPacks: PolicyPackDefinition[] = [
  {
    uid: "policy_pack_approval_gates",
    name: "approval-gates",
    version: "1.0.0",
    active: true,
    isBuiltin: true,
    rules: [
      {
        uid: "approval-gates.require-agent-spawn-approval",
        description: "Require explicit coordinator approval for direct agent spawning.",
        trigger: { actionType: "agent.spawn" },
        condition: {
          op: "not",
          condition: { op: "equals", path: "policyApproval.approved", value: true }
        },
        enforcement: "require_approval",
        reason: "Agent spawning requires coordinator approval."
      },
      {
        uid: "approval-gates.require-vault-memory-delete-approval",
        description: "Require explicit coordinator approval for Vault memory deletes.",
        trigger: { actionType: "memory.delete" },
        condition: {
          op: "not",
          condition: { op: "equals", path: "policyApproval.approved", value: true }
        },
        enforcement: "require_approval",
        reason: "Vault memory deletes require coordinator approval."
      },
      {
        uid: "approval-gates.require-push-approval",
        description: "Require explicit coordinator approval before approving a push.",
        trigger: { actionType: "git.push_approval" },
        condition: {
          op: "not",
          condition: { op: "equals", path: "policyApproval.approved", value: true }
        },
        enforcement: "require_approval",
        reason: "Push approvals require coordinator approval."
      }
    ]
  },
  {
    uid: "policy_pack_core_safety",
    name: "core-safety",
    version: "1.0.0",
    active: true,
    isBuiltin: true,
    rules: [
      {
        uid: "core-safety.block-token-exposure",
        description: "Deny any action payload containing owner/session/claim token keys.",
        trigger: { actionType: "*" },
        condition: { op: "has_forbidden_token_key" },
        enforcement: "deny",
        reason: "Action payload contains a forbidden token key."
      },
      {
        uid: "core-safety.require-owner-token-for-owned-tool",
        description: "Deny owner-token protected tool calls when no owner token was supplied.",
        trigger: { actionType: "tool.execute" },
        condition: {
          op: "all",
          conditions: [
            { op: "equals", path: "requiresOwnerToken", value: true },
            { op: "not_equals", path: "hasSessionToken", value: true }
          ]
        },
        enforcement: "deny",
        reason: "Owner-token protected tool calls require an owner token."
      },
      {
        uid: "core-safety.require-owner-token-for-handoff-action",
        description: "Deny owner-token protected handoff actions when no owner token was supplied.",
        trigger: { actionType: "handoff.*" },
        condition: {
          op: "all",
          conditions: [
            { op: "equals", path: "requiresOwnerToken", value: true },
            { op: "not_equals", path: "hasSessionToken", value: true }
          ]
        },
        enforcement: "deny",
        reason: "Owner-token protected handoff actions require an owner token."
      }
    ]
  },
  {
    uid: "policy_pack_rate_limiting",
    name: "rate-limiting",
    version: "1.0.0",
    active: true,
    isBuiltin: true,
    rules: [
      {
        uid: "rate-limiting.per-session-tool-calls",
        description: "Limit each session to 60 MCP tool calls per minute.",
        trigger: { actionType: "tool.execute" },
        condition: { op: "exists", path: "actorSessionUid" },
        enforcement: "rate_limit",
        reason: "Per-session MCP tool call rate limit exceeded.",
        rateLimit: {
          keyPath: "actorSessionUid",
          limit: 60,
          windowMs: 60_000
        }
      },
      {
        uid: "rate-limiting.handoff-publish-per-session",
        description: "Limit each source session to 20 handoff publishes per minute.",
        trigger: { actionType: "handoff.publish" },
        condition: { op: "exists", path: "sourceSessionUid" },
        enforcement: "rate_limit",
        reason: "Per-session handoff publish rate limit exceeded.",
        rateLimit: {
          keyPath: "sourceSessionUid",
          limit: 20,
          windowMs: 60_000
        }
      }
    ]
  }
];
