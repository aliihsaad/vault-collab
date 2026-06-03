import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { AttentionService } from "../src/services/attention.service.js";
import { DiscussionService } from "../src/services/discussion.service.js";
import { EventService } from "../src/services/event.service.js";
import { HandoffService } from "../src/services/handoff.service.js";
import { LaunchRequestService } from "../src/services/launch-request.service.js";
import { PolicyEngine } from "../src/services/policy-engine.service.js";
import { SessionService } from "../src/services/session.service.js";

const workspacePath = "C:\\workspace\\vault-collab";

describe("PolicyEngine", () => {
  let db: CollabDatabase;
  let now: Date;
  let events: EventService;
  let policy: PolicyEngine;

  beforeEach(() => {
    now = new Date("2026-06-03T12:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    events = new EventService(db, clock);
    policy = new PolicyEngine(db, events, clock);
  });

  afterEach(() => {
    db.close();
  });

  it("seeds the immutable built-in policy packs as active database records", () => {
    const packs = policy.listPolicyPacks();

    expect(packs.map((pack) => pack.name)).toEqual([
      "approval-gates",
      "core-safety",
      "rate-limiting"
    ]);
    expect(packs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "core-safety",
          version: "1.0.0",
          active: true,
          isBuiltin: true,
          rules: expect.arrayContaining([
            expect.objectContaining({
              uid: "core-safety.block-token-exposure",
              enforcement: "deny"
            })
          ])
        }),
        expect.objectContaining({
          name: "rate-limiting",
          isBuiltin: true,
          active: true
        }),
        expect.objectContaining({
          name: "approval-gates",
          isBuiltin: true,
          active: true
        })
      ])
    );

    const rows = db
      .prepare("SELECT name, active, is_builtin FROM policy_packs ORDER BY name ASC")
      .all() as Array<{ name: string; active: 0 | 1; is_builtin: 0 | 1 }>;

    expect(rows).toEqual([
      { name: "approval-gates", active: 1, is_builtin: 1 },
      { name: "core-safety", active: 1, is_builtin: 1 },
      { name: "rate-limiting", active: 1, is_builtin: 1 }
    ]);
  });

  it("denies token-bearing payloads and records only token-safe policy events", () => {
    const decision = policy.evaluate({
      actionType: "handoff.publish",
      payload: {
        project: "Vault Collab",
        nested: {
          sessionToken: "secret-token-that-must-not-be-persisted"
        }
      }
    });

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      triggeredRules: [
        expect.objectContaining({
          packName: "core-safety",
          ruleUid: "core-safety.block-token-exposure",
          enforcement: "deny"
        })
      ]
    });

    const policyEvents = events
      .listEvents()
      .filter((event) => event.eventType.startsWith("policy."));
    expect(policyEvents.map((event) => event.eventType)).toEqual([
      "policy.rule_triggered",
      "policy.violation"
    ]);
    expect(JSON.stringify(policyEvents)).not.toContain("secret-token-that-must-not-be-persisted");

    const linkedRows = db
      .prepare(
        "SELECT event_id, policy_pack_uid, policy_rule_uid, action_type, decision FROM policy_events ORDER BY event_id ASC"
      )
      .all();
    expect(linkedRows).toEqual([
      expect.objectContaining({
        policy_rule_uid: "core-safety.block-token-exposure",
        action_type: "handoff.publish",
        decision: "deny"
      }),
      expect.objectContaining({
        policy_rule_uid: "core-safety.block-token-exposure",
        action_type: "handoff.publish",
        decision: "deny"
      })
    ]);
  });

  it("requires approval for high-risk actions and records approved decisions", () => {
    const gated = policy.evaluate({
      actionType: "agent.spawn",
      payload: {
        project: "Vault Collab",
        provider: "codex"
      }
    });

    expect(gated).toMatchObject({
      allowed: false,
      decision: "require_approval",
      approvalRequired: true,
      triggeredRules: [
        expect.objectContaining({
          packName: "approval-gates",
          ruleUid: "approval-gates.require-agent-spawn-approval"
        })
      ]
    });

    const approved = policy.evaluate({
      actionType: "agent.spawn",
      payload: {
        project: "Vault Collab",
        provider: "codex",
        policyApproval: {
          approved: true,
          approvedBySessionUid: "vc_sess_coordinator"
        }
      }
    });

    expect(approved).toMatchObject({
      allowed: true,
      decision: "approved",
      approvalRequired: false
    });
    expect(events.listEvents({ eventType: "policy.approved" })).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          actionType: "agent.spawn",
          approvedBySessionUid: "vc_sess_coordinator"
        })
      })
    ]);
  });

  it("rate-limits per-session tool calls synchronously", () => {
    let lastDecision = policy.evaluate({
      actionType: "tool.execute",
      payload: {
        toolName: "vault_collab_list_sessions",
        actorSessionUid: "vc_sess_busy"
      }
    });

    for (let index = 1; index < 60; index += 1) {
      lastDecision = policy.evaluate({
        actionType: "tool.execute",
        payload: {
          toolName: "vault_collab_list_sessions",
          actorSessionUid: "vc_sess_busy"
        }
      });
    }

    const limited = policy.evaluate({
      actionType: "tool.execute",
      payload: {
        toolName: "vault_collab_list_sessions",
        actorSessionUid: "vc_sess_busy"
      }
    });

    expect(lastDecision).toMatchObject({
      allowed: true,
      decision: "allow"
    });
    expect(limited).toMatchObject({
      allowed: false,
      decision: "rate_limited",
      rateLimited: true
    });
    expect(limited.triggeredRules).toEqual([
      expect.objectContaining({
        packName: "rate-limiting",
        ruleUid: "rate-limiting.per-session-tool-calls"
      })
    ]);
  });

  it("lets handoff policy enforcement block unsafe publishes before insertion", () => {
    const handoffs = new HandoffService(db, events, () => now, undefined, policy);

    expect(() =>
      handoffs.publishHandoff({
        shortPrompt: "Unsafe handoff",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab",
        typedPayload: {
          sessionToken: "must-not-persist"
        }
      })
    ).toThrow(/policy denied/i);

    expect(db.prepare("SELECT COUNT(*) AS count FROM handoffs").get()).toEqual({ count: 0 });
    expect(events.listEvents({ eventType: "policy.violation" })).toHaveLength(1);
  });

  it("lets attention policy enforcement suppress denied sensitive event routes", () => {
    const launchRequests = new LaunchRequestService(db, events, () => now);
    const sessions = new SessionService(db, events, launchRequests, () => now);
    const handoffs = new HandoffService(db, events, () => now);
    const discussions = new DiscussionService(db, events, () => now);
    const attention = new AttentionService(
      db,
      sessions,
      handoffs,
      discussions,
      events,
      launchRequests,
      policy
    );
    const coordinator = sessions.registerSession({
      displayName: "Coordinator",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "coordinator",
      capabilities: {}
    });
    db.prepare(
      `
      INSERT INTO policy_packs (uid, name, version, rules_json, active, created_at, is_builtin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      "policy_pack_test_attention",
      "test-attention-route-deny",
      "1.0.0",
      JSON.stringify([
        {
          uid: "test-attention-route-deny.security-findings",
          description: "Test-only attention route block.",
          trigger: { actionType: "attention.route" },
          condition: {
            op: "equals",
            path: "eventType",
            value: "security.finding"
          },
          enforcement: "deny"
        }
      ]),
      1,
      now.toISOString(),
      0
    );

    events.recordEvent({
      eventType: "security.finding",
      payload: {
        project: "Vault Collab",
        scanUid: "sec_scan_policy_test",
        domain: "owner-token-handling",
        severity: "high",
        findingCode: "owner_token.event_payload",
        findingSummary: "Unsafe token key was found in persisted event payload metadata.",
        evidenceCount: 1
      }
    });

    expect(
      attention
        .getSessionAttention(coordinator.sessionUid, { includeCurrentHandoffs: false })
        .items.map((item) => item.kind)
    ).not.toContain("security_finding");
  });
});
