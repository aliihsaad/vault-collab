import { describe, expect, it } from "vitest";
import { validateVaultCollabSessionSnapshot } from "../src/services/snapshot-validator.js";

const sessionUid = "vc_sess_snapshot_validator";

function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "vault_collab.session.v1",
    adapterId: "codex-local:test",
    sessionUid,
    project: "Vault Collab",
    workspace: {
      path: "C:\\workspace\\vault-collab",
      projectKey: "vault-collab"
    },
    state: "working",
    context: {
      model: "gpt-5-codex",
      provider: "codex",
      tokensUsed: 86000,
      tokensRemaining: 14000,
      compactionRisk: "medium"
    },
    active_handoffs: [
      {
        handoffUid: "vc_handoff_phase_7",
        status: "in_progress",
        progressNote: "Implementing report_session.",
        claimedAt: "2026-06-04T09:52:45.000Z"
      }
    ],
    progress: {
      currentTask: "Implement Phase 7",
      percentComplete: 40,
      blockers: []
    },
    cost: {
      estimatedUSD: 1.25,
      tokensTotal: 100000
    },
    risk: {
      level: "low",
      reasons: []
    },
    tool_grants: [
      {
        toolName: "vault_collab_report_session",
        scope: "coordination_write",
        grantedAt: "2026-06-04T09:52:45.000Z"
      }
    ],
    capabilities: {
      canMutateHandoffs: false,
      canPublishHandoffs: false,
      canSendMessages: true,
      adapterType: "adapter_backed"
    },
    sync_cursor: {
      lastEventId: 5772,
      lastHeartbeatAt: "2026-06-04T09:52:45.000Z"
    },
    ...overrides
  };
}

describe("vault_collab.session.v1 snapshot validation", () => {
  it("accepts a complete snapshot and preserves nullable optional values", () => {
    const snapshot = validSnapshot({
      context: {
        model: null,
        provider: null,
        tokensUsed: null,
        tokensRemaining: null,
        compactionRisk: "unknown"
      },
      active_handoffs: [],
      progress: {
        currentTask: null,
        percentComplete: null,
        blockers: []
      },
      cost: {
        estimatedUSD: null,
        tokensTotal: null
      },
      sync_cursor: {
        lastEventId: null,
        lastHeartbeatAt: null
      }
    });

    expect(
      validateVaultCollabSessionSnapshot(snapshot, {
        sessionUid,
        project: "vault-collab"
      })
    ).toMatchObject({
      schemaVersion: "vault_collab.session.v1",
      sessionUid,
      project: "Vault Collab",
      capabilities: {
        adapterType: "adapter_backed"
      }
    });
  });

  it("rejects missing required top-level fields", () => {
    const requiredFields = [
      "schemaVersion",
      "adapterId",
      "sessionUid",
      "project",
      "workspace",
      "state",
      "context",
      "active_handoffs",
      "progress",
      "cost",
      "risk",
      "tool_grants",
      "capabilities",
      "sync_cursor"
    ];

    for (const field of requiredFields) {
      const snapshot = validSnapshot();
      delete snapshot[field];

      expect(() =>
        validateVaultCollabSessionSnapshot(snapshot, {
          sessionUid,
          project: "Vault Collab"
        })
      ).toThrow(new RegExp(field));
    }
  });

  it("rejects unknown schema versions, invalid enums, and unknown fields", () => {
    expect(() =>
      validateVaultCollabSessionSnapshot(validSnapshot({ schemaVersion: "ecc.session.v1" }), {
        sessionUid,
        project: "Vault Collab"
      })
    ).toThrow(/schemaVersion/i);

    expect(() =>
      validateVaultCollabSessionSnapshot(validSnapshot({ state: "executing" }), {
        sessionUid,
        project: "Vault Collab"
      })
    ).toThrow(/state/i);

    expect(() =>
      validateVaultCollabSessionSnapshot(
        validSnapshot({
          risk: {
            level: "severe",
            reasons: []
          }
        }),
        {
          sessionUid,
          project: "Vault Collab"
        }
      )
    ).toThrow(/risk/i);

    expect(() =>
      validateVaultCollabSessionSnapshot(validSnapshot({ surprise: true }), {
        sessionUid,
        project: "Vault Collab"
      })
    ).toThrow(/surprise/i);
  });

  it("rejects invalid numeric ranges and non-finite values", () => {
    expect(() =>
      validateVaultCollabSessionSnapshot(
        validSnapshot({
          context: {
            model: "gpt-5-codex",
            provider: "codex",
            tokensUsed: -1,
            tokensRemaining: 10,
            compactionRisk: "low"
          }
        }),
        {
          sessionUid,
          project: "Vault Collab"
        }
      )
    ).toThrow(/tokensUsed/i);

    expect(() =>
      validateVaultCollabSessionSnapshot(
        validSnapshot({
          progress: {
            currentTask: "Implement Phase 7",
            percentComplete: 101,
            blockers: []
          }
        }),
        {
          sessionUid,
          project: "Vault Collab"
        }
      )
    ).toThrow(/percentComplete/i);

    expect(() =>
      validateVaultCollabSessionSnapshot(
        validSnapshot({
          cost: {
            estimatedUSD: Number.POSITIVE_INFINITY,
            tokensTotal: 100
          }
        }),
        {
          sessionUid,
          project: "Vault Collab"
        }
      )
    ).toThrow(/estimatedUSD/i);
  });

  it("rejects session/project mismatches, token-like keys, and overlong text", () => {
    expect(() =>
      validateVaultCollabSessionSnapshot(validSnapshot({ sessionUid: "vc_sess_other" }), {
        sessionUid,
        project: "Vault Collab"
      })
    ).toThrow(/sessionUid/i);

    expect(() =>
      validateVaultCollabSessionSnapshot(validSnapshot({ project: "Other Project" }), {
        sessionUid,
        project: "Vault Collab"
      })
    ).toThrow(/project/i);

    expect(() =>
      validateVaultCollabSessionSnapshot(
        validSnapshot({
          progress: {
            currentTask: "Implement Phase 7",
            percentComplete: 10,
            blockers: [
              {
                adapterToken: "must-not-be-accepted"
              }
            ]
          }
        }),
        {
          sessionUid,
          project: "Vault Collab"
        }
      )
    ).toThrow(/adapterToken/i);

    expect(() =>
      validateVaultCollabSessionSnapshot(
        validSnapshot({
          progress: {
            currentTask: "x".repeat(301),
            percentComplete: 10,
            blockers: []
          }
        }),
        {
          sessionUid,
          project: "Vault Collab"
        }
      )
    ).toThrow(/currentTask/i);
  });
});
