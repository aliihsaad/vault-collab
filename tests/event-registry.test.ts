import { describe, expect, it } from "vitest";
import {
  assertTokenSafePayload,
  eventTypeRegistry,
  getEventTypeDefinition,
  redactTokenUnsafeValue
} from "../src/event-registry.js";

const requiredNamespaces = [
  "session",
  "handoff",
  "tool",
  "permission",
  "discussion",
  "memory",
  "security",
  "policy",
  "context",
  "cost",
  "risk",
  "loop"
];

describe("event type registry", () => {
  it("defines canonical token-safe event types for every Phase 3 namespace", () => {
    const namespaces = new Set<string>(eventTypeRegistry.map((eventType) => eventType.namespace));

    for (const namespace of requiredNamespaces) {
      expect(namespaces.has(namespace), `missing namespace ${namespace}`).toBe(true);
    }

    expect(getEventTypeDefinition("tool.call_before")).toMatchObject({
      canonicalName: "tool.call_before",
      namespace: "tool",
      attention: {
        itemKind: null
      }
    });
    expect(getEventTypeDefinition("context.limit_warning")).toMatchObject({
      canonicalName: "context.limit_warning",
      namespace: "context",
      attention: {
        itemKind: "context_warning",
        roleProfileIds: ["coordinator", "runtime-loop-operator"]
      }
    });
    expect(getEventTypeDefinition("cost.threshold_warning")).toMatchObject({
      attention: {
        itemKind: "cost_warning",
        roleProfileIds: ["coordinator", "runtime-loop-operator", "release-agent"]
      }
    });
    expect(getEventTypeDefinition("security.finding")).toMatchObject({
      canonicalName: "security.finding",
      namespace: "security",
      attention: {
        itemKind: "security_finding",
        roleProfileIds: ["coordinator", "security-reviewer"]
      }
    });
    expect(getEventTypeDefinition("policy.rule_triggered")).toMatchObject({
      canonicalName: "policy.rule_triggered",
      namespace: "policy",
      attention: {
        itemKind: null
      }
    });
    expect(getEventTypeDefinition("policy.violation")).toMatchObject({
      canonicalName: "policy.violation",
      namespace: "policy",
      attention: {
        itemKind: "policy_notice",
        roleProfileIds: ["coordinator", "security-reviewer"]
      }
    });
    expect(getEventTypeDefinition("policy.approved")).toMatchObject({
      canonicalName: "policy.approved",
      namespace: "policy",
      attention: {
        itemKind: null
      }
    });
    expect(getEventTypeDefinition("loop.stall_detected")).toMatchObject({
      attention: {
        itemKind: "loop_stall",
        roleProfileIds: ["coordinator", "runtime-loop-operator"]
      }
    });
    expect(getEventTypeDefinition("session.snapshot_reported")).toMatchObject({
      canonicalName: "session.snapshot_reported",
      namespace: "session",
      attention: {
        scope: "none",
        itemKind: null,
        roleProfileIds: []
      }
    });
    expect(getEventTypeDefinition("risk.critical_reported")).toMatchObject({
      canonicalName: "risk.critical_reported",
      namespace: "risk",
      attention: {
        itemKind: "risk_critical",
        roleProfileIds: ["coordinator", "runtime-loop-operator"]
      }
    });

    for (const definition of eventTypeRegistry) {
      expect(definition.canonicalName).toMatch(/^[a-z_]+\.[a-z0-9_]+$/);
      expect(definition.payloadShape).not.toEqual({});
      expect(definition.tokenSafety.forbiddenPayloadKeys).toEqual(
        expect.arrayContaining([
          "sessionToken",
          "session_token",
          "ownerToken",
          "claimToken",
          "adapterToken",
          "adapter_token"
        ])
      );
      expect(definition.tokenSafety.rules.join("\n")).toMatch(/owner tokens/i);
    }
  });

  it("rejects owner token keys anywhere in event payloads", () => {
    expect(() =>
      assertTokenSafePayload({
        nested: {
          sessionToken: "must-not-leak"
        }
      })
    ).toThrow(/token/i);

    expect(() =>
      assertTokenSafePayload({
        safe: true,
        handoff: {
          claim_token: "must-not-leak"
        }
      })
    ).toThrow(/claim_token/i);

    expect(() =>
      assertTokenSafePayload({
        adapter: {
          adapterToken: "must-not-leak"
        }
      })
    ).toThrow(/adapterToken/i);

    expect(() =>
      assertTokenSafePayload({
        sessionUid: "vc_sess_123",
        handoffUid: "vc_handoff_123",
        warningLevel: "high"
      })
    ).not.toThrow();
  });

  it("redacts token-like values from defensive audit metadata", () => {
    expect(
      redactTokenUnsafeValue({
        toolName: "vault_collab_receive",
        sessionToken: "secret",
        nested: {
          owner_token: "secret",
          visible: "ok"
        }
      })
    ).toEqual({
      toolName: "vault_collab_receive",
      sessionToken: "[REDACTED]",
      nested: {
        owner_token: "[REDACTED]",
        visible: "ok"
      }
    });
  });
});
