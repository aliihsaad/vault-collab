import { randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import { isForbiddenTokenKey, redactTokenUnsafeValue } from "../event-registry.js";
import type {
  PolicyDecisionKind,
  PolicyEnforcement,
  PolicyEvaluation,
  PolicyEvaluationInput,
  PolicyPackRecord,
  PolicyRateLimit,
  PolicyRule,
  PolicyRuleEvaluation
} from "../policy-packs.js";
import type { JsonRecord } from "../types.js";
import type { EventService } from "./event.service.js";

interface PolicyPackRow {
  uid: string;
  name: string;
  version: string;
  rules_json: string;
  active: 0 | 1;
  created_at: string;
  is_builtin: 0 | 1;
}

interface RateBucket {
  windowStartedAt: number;
  count: number;
}

interface PolicyAdminSessionRow {
  session_uid: string;
  session_token: string;
  role: string;
  role_profile_id: string | null;
  capabilities_json: string;
}

interface PolicyPackListOptions {
  includeInactive?: boolean;
}

interface PolicyPackActivationInput {
  sessionUid: string;
  sessionToken: string;
}

const highRiskApprovalActions = new Set([
  "agent.spawn",
  "memory.delete",
  "git.push_approval"
]);

export class PolicyEngine {
  private readonly rateBuckets = new Map<string, RateBucket>();

  constructor(
    private readonly db: CollabDatabase,
    private readonly events: EventService,
    private readonly clock: () => Date = () => new Date()
  ) {}

  listPolicyPacks(options: PolicyPackListOptions = {}): PolicyPackRecord[] {
    const where = options.includeInactive ? "" : "WHERE active = 1";
    const rows = this.db
      .prepare(
        `
        SELECT uid, name, version, rules_json, active, created_at, is_builtin
        FROM policy_packs
        ${where}
        ORDER BY name ASC
      `
      )
      .all() as PolicyPackRow[];

    return rows.map((row) => this.mapPackRow(row));
  }

  getPolicyPack(identifier: { uid?: string; name?: string }): PolicyPackRecord {
    const row = this.findPolicyPackRow(identifier);
    if (!row) {
      throw new Error(`Policy pack not found: ${identifier.uid ?? identifier.name ?? "(missing)"}`);
    }

    return this.mapPackRow(row);
  }

  activatePolicyPack(
    identifier: { uid?: string; name?: string },
    input: PolicyPackActivationInput
  ): PolicyPackRecord {
    this.assertPolicyAdmin(input.sessionUid, input.sessionToken);
    return this.setPolicyPackActive(identifier, true);
  }

  deactivatePolicyPack(
    identifier: { uid?: string; name?: string },
    input: PolicyPackActivationInput
  ): PolicyPackRecord {
    this.assertPolicyAdmin(input.sessionUid, input.sessionToken);
    return this.setPolicyPackActive(identifier, false);
  }

  evaluate(input: PolicyEvaluationInput): PolicyEvaluation {
    if (!input.actionType || input.actionType.trim() === "") {
      throw new Error("Policy evaluation requires actionType");
    }

    const payload = input.payload ?? {};
    const triggeredRules: PolicyRuleEvaluation[] = [];
    const warnings: string[] = [];
    const violations: string[] = [];
    let decision: PolicyDecisionKind = "allow";

    for (const pack of this.listPolicyPacks()) {
      for (const rule of pack.rules) {
        if (!this.triggerMatches(rule, input)) {
          continue;
        }

        if (!this.conditionMatches(rule.condition, payload)) {
          continue;
        }

        const triggered = {
          packUid: pack.uid,
          packName: pack.name,
          ruleUid: rule.uid,
          enforcement: rule.enforcement,
          reason: rule.reason ?? rule.description
        };

        if (rule.enforcement === "rate_limit") {
          const limited = this.isRateLimited(rule.rateLimit, payload, rule.uid, input.dryRun === true);
          if (!limited) {
            continue;
          }
        }

        triggeredRules.push(triggered);
        if (rule.enforcement === "warn") {
          warnings.push(triggered.reason);
        } else {
          violations.push(triggered.reason);
        }

        decision = this.mergeDecision(decision, rule.enforcement);
      }
    }

    if (decision === "allow" && this.hasActiveApproval(input.actionType, payload)) {
      decision = "approved";
    }

    const evaluation: PolicyEvaluation = {
      actionType: input.actionType,
      eventType: input.eventType ?? null,
      allowed: decision === "allow" || decision === "approved" || decision === "warn",
      decision,
      approvalRequired: decision === "require_approval",
      rateLimited: decision === "rate_limited",
      warnings,
      violations,
      triggeredRules
    };

    if (input.dryRun !== true) {
      this.recordEvaluationEvents(evaluation, payload);
    }

    return evaluation;
  }

  enforce(input: PolicyEvaluationInput): PolicyEvaluation {
    const evaluation = this.evaluate(input);
    if (!evaluation.allowed) {
      const reason = evaluation.violations[0] ?? evaluation.triggeredRules[0]?.reason ?? evaluation.decision;
      throw new Error(`Policy denied ${input.actionType}: ${reason}`);
    }

    return evaluation;
  }

  private setPolicyPackActive(
    identifier: { uid?: string; name?: string },
    active: boolean
  ): PolicyPackRecord {
    const pack = this.getPolicyPack({ uid: identifier.uid, name: identifier.name });
    this.db
      .prepare(
        `
        UPDATE policy_packs
        SET active = ?
        WHERE uid = ?
      `
      )
      .run(active ? 1 : 0, pack.uid);

    return this.getPolicyPack({ uid: pack.uid });
  }

  private findPolicyPackRow(identifier: { uid?: string; name?: string }): PolicyPackRow | null {
    if (identifier.uid) {
      return (
        (this.db
          .prepare(
            `
            SELECT uid, name, version, rules_json, active, created_at, is_builtin
            FROM policy_packs
            WHERE uid = ?
          `
          )
          .get(identifier.uid) as PolicyPackRow | undefined) ?? null
      );
    }

    if (identifier.name) {
      return (
        (this.db
          .prepare(
            `
            SELECT uid, name, version, rules_json, active, created_at, is_builtin
            FROM policy_packs
            WHERE name = ?
          `
          )
          .get(identifier.name) as PolicyPackRow | undefined) ?? null
      );
    }

    throw new Error("Policy pack identifier requires uid or name");
  }

  private mapPackRow(row: PolicyPackRow): PolicyPackRecord {
    return {
      uid: row.uid,
      name: row.name,
      version: row.version,
      rules: JSON.parse(row.rules_json) as PolicyRule[],
      active: row.active === 1,
      createdAt: row.created_at,
      isBuiltin: row.is_builtin === 1
    };
  }

  private triggerMatches(rule: PolicyRule, input: PolicyEvaluationInput): boolean {
    const actionTrigger = rule.trigger.actionType;
    const eventTrigger = rule.trigger.eventType;

    if (actionTrigger && !this.patternMatches(actionTrigger, input.actionType)) {
      return false;
    }

    if (eventTrigger && !this.patternMatches(eventTrigger, input.eventType ?? "")) {
      return false;
    }

    return Boolean(actionTrigger || eventTrigger);
  }

  private patternMatches(pattern: string, value: string): boolean {
    if (pattern === "*") {
      return true;
    }

    if (pattern.endsWith("*")) {
      return value.startsWith(pattern.slice(0, -1));
    }

    return pattern === value;
  }

  private conditionMatches(condition: PolicyRule["condition"], payload: JsonRecord): boolean {
    switch (condition.op) {
      case "always":
        return true;
      case "never":
        return false;
      case "exists":
        return this.valueAtPath(payload, condition.path) !== undefined;
      case "missing":
        return this.valueAtPath(payload, condition.path) === undefined;
      case "equals":
        return this.valuesEqual(this.valueAtPath(payload, condition.path), condition.value);
      case "not_equals":
        return !this.valuesEqual(this.valueAtPath(payload, condition.path), condition.value);
      case "in":
        return condition.values.some((value) =>
          this.valuesEqual(this.valueAtPath(payload, condition.path), value)
        );
      case "contains":
        return String(this.valueAtPath(payload, condition.path) ?? "").includes(condition.value);
      case "matches": {
        const value = this.valueAtPath(payload, condition.path);
        return typeof value === "string" && new RegExp(condition.pattern, condition.flags).test(value);
      }
      case "has_forbidden_token_key": {
        const value = condition.path ? this.valueAtPath(payload, condition.path) : payload;
        return this.hasForbiddenTokenKey(value);
      }
      case "all":
        return condition.conditions.every((child) => this.conditionMatches(child, payload));
      case "any":
        return condition.conditions.some((child) => this.conditionMatches(child, payload));
      case "not":
        return !this.conditionMatches(condition.condition, payload);
    }
  }

  private valueAtPath(value: unknown, path: string): unknown {
    const parts = path.split(".").filter(Boolean);
    let current = value;

    for (const part of parts) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        return undefined;
      }

      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  private hasForbiddenTokenKey(value: unknown): boolean {
    if (Array.isArray(value)) {
      return value.some((item) => this.hasForbiddenTokenKey(item));
    }

    if (typeof value !== "object" || value === null) {
      return false;
    }

    return Object.entries(value).some(
      ([key, nestedValue]) => isForbiddenTokenKey(key) || this.hasForbiddenTokenKey(nestedValue)
    );
  }

  private valuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private mergeDecision(current: PolicyDecisionKind, enforcement: PolicyEnforcement): PolicyDecisionKind {
    const next = enforcement === "rate_limit" ? "rate_limited" : enforcement;
    const priority: Record<PolicyDecisionKind, number> = {
      allow: 0,
      approved: 0,
      warn: 1,
      rate_limited: 2,
      require_approval: 3,
      deny: 4
    };

    return priority[next] > priority[current] ? next : current;
  }

  private isRateLimited(
    rateLimit: PolicyRateLimit | undefined,
    payload: JsonRecord,
    ruleUid: string,
    dryRun: boolean
  ): boolean {
    if (!rateLimit || rateLimit.limit <= 0 || rateLimit.windowMs <= 0) {
      return true;
    }

    const keyValue = this.valueAtPath(payload, rateLimit.keyPath);
    if (typeof keyValue !== "string" || keyValue.trim() === "") {
      return false;
    }

    const nowMs = this.clock().getTime();
    const bucketKey = `${ruleUid}:${keyValue}`;
    const existing = this.rateBuckets.get(bucketKey);
    const bucket =
      existing && nowMs - existing.windowStartedAt < rateLimit.windowMs
        ? existing
        : { windowStartedAt: nowMs, count: 0 };

    if (bucket.count >= rateLimit.limit) {
      return true;
    }

    if (!dryRun) {
      bucket.count += 1;
      this.rateBuckets.set(bucketKey, bucket);
    }

    return false;
  }

  private hasActiveApproval(actionType: string, payload: JsonRecord): boolean {
    if (!highRiskApprovalActions.has(actionType)) {
      return false;
    }

    const approval = payload.policyApproval;
    return (
      typeof approval === "object" &&
      approval !== null &&
      !Array.isArray(approval) &&
      (approval as Record<string, unknown>).approved === true
    );
  }

  private recordEvaluationEvents(evaluation: PolicyEvaluation, payload: JsonRecord): void {
    for (const rule of evaluation.triggeredRules) {
      this.recordPolicyEvent("policy.rule_triggered", evaluation, rule, payload);
    }

    if (!evaluation.allowed) {
      for (const rule of evaluation.triggeredRules) {
        this.recordPolicyEvent("policy.violation", evaluation, rule, payload);
      }
    }

    if (evaluation.decision === "approved") {
      const approvedBySessionUid = this.approvedBySessionUid(payload);
      const event = this.events.recordEvent({
        eventType: "policy.approved",
        sessionUid: approvedBySessionUid,
        payload: {
          actionType: evaluation.actionType,
          eventType: evaluation.eventType,
          decision: evaluation.decision,
          approvedBySessionUid
        }
      });
      this.insertPolicyEvent({
        eventId: event.eventId,
        policyPackUid: null,
        policyRuleUid: null,
        actionType: evaluation.actionType,
        decision: evaluation.decision
      });
    }
  }

  private recordPolicyEvent(
    eventType: "policy.rule_triggered" | "policy.violation",
    evaluation: PolicyEvaluation,
    rule: PolicyRuleEvaluation,
    payload: JsonRecord
  ): void {
    const redactedPayload = redactTokenUnsafeValue(payload) as JsonRecord;
    const event = this.events.recordEvent({
      eventType,
      payload: {
        actionType: evaluation.actionType,
        eventType: evaluation.eventType,
        decision: evaluation.decision,
        policyPackUid: rule.packUid,
        policyPackName: rule.packName,
        policyRuleUid: rule.ruleUid,
        enforcement: rule.enforcement,
        reason: rule.reason,
        payloadKeys: Object.keys(redactedPayload)
      }
    });
    this.insertPolicyEvent({
      eventId: event.eventId,
      policyPackUid: rule.packUid,
      policyRuleUid: rule.ruleUid,
      actionType: evaluation.actionType,
      decision: evaluation.decision
    });
  }

  private insertPolicyEvent(input: {
    eventId: number;
    policyPackUid: string | null;
    policyRuleUid: string | null;
    actionType: string;
    decision: PolicyDecisionKind;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO policy_events (
          policy_event_uid,
          event_id,
          policy_pack_uid,
          policy_rule_uid,
          action_type,
          decision,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        `vc_policy_event_${randomUUID()}`,
        input.eventId,
        input.policyPackUid,
        input.policyRuleUid,
        input.actionType,
        input.decision,
        this.clock().toISOString()
      );
  }

  private approvedBySessionUid(payload: JsonRecord): string | null {
    const approval = payload.policyApproval;
    if (typeof approval !== "object" || approval === null || Array.isArray(approval)) {
      return null;
    }

    const approvedBySessionUid = (approval as Record<string, unknown>).approvedBySessionUid;
    return typeof approvedBySessionUid === "string" ? approvedBySessionUid : null;
  }

  private assertPolicyAdmin(sessionUid: string, sessionToken: string): void {
    const row = this.db
      .prepare(
        `
        SELECT session_uid, session_token, role, role_profile_id, capabilities_json
        FROM sessions
        WHERE session_uid = ?
      `
      )
      .get(sessionUid) as PolicyAdminSessionRow | undefined;

    if (!row) {
      throw new Error(`Session not found: ${sessionUid}`);
    }

    if (row.session_token !== sessionToken) {
      throw new Error("Invalid session token");
    }

    const capabilities = JSON.parse(row.capabilities_json) as Record<string, unknown>;
    const isCoordinator = row.role === "coordinator" || row.role_profile_id === "coordinator";
    if (capabilities.policyAdmin === true || capabilities.admin === true || isCoordinator) {
      return;
    }

    throw new Error("Policy pack activation requires coordinator or policyAdmin capability");
  }
}
