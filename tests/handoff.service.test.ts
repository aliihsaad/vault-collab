import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { EventService } from "../src/services/event.service.js";
import { HandoffService } from "../src/services/handoff.service.js";
import { SessionService } from "../src/services/session.service.js";
import type { RegisteredSession } from "../src/types.js";

const workspacePath = "C:\\workspace\\vault-collab";

describe("HandoffService", () => {
  let db: CollabDatabase;
  let now: Date;
  let events: EventService;
  let sessions: SessionService;
  let handoffs: HandoffService;
  let codex: RegisteredSession;
  let claude: RegisteredSession;

  beforeEach(() => {
    now = new Date("2026-05-28T11:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    events = new EventService(db, clock);
    sessions = new SessionService(db, events, clock);
    handoffs = new HandoffService(db, events, clock);

    codex = sessions.registerSession({
      displayName: "Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        handoffs: true
      }
    });
    claude = sessions.registerSession({
      displayName: "Claude Code",
      clientType: "claude-code",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        handoffs: true
      }
    });
  });

  afterEach(() => {
    db.close();
  });

  it("publishes a provider-neutral handoff and lists it in the target inbox", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Implement the local session service from the failing tests.",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      relatedProjects: ["Codex-brain"],
      relatedFiles: ["src/services/session.service.ts", "tests/session.service.test.ts"],
      sourceSessionUid: codex.sessionUid,
      suggestedClientType: "claude-code",
      vaultMemoryUid: "vm_full_brief",
      priority: "high",
      urgent: true
    });

    expect(handoff.handoffUid).toMatch(/^vc_handoff_/);
    expect(handoff).toMatchObject({
      vaultMemoryUid: "vm_full_brief",
      shortPrompt: "Implement the local session service from the failing tests.",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      relatedProjects: ["Codex-brain"],
      relatedFiles: ["src/services/session.service.ts", "tests/session.service.test.ts"],
      sourceSessionUid: codex.sessionUid,
      suggestedClientType: "claude-code",
      status: "available",
      priority: "high",
      urgent: true,
      claimedBySessionUid: null,
      createdAt: "2026-05-28T11:00:00.000Z"
    });

    const inbox = handoffs.listInbox({ targetProject: "Vault Collab" });

    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      handoffUid: handoff.handoffUid,
      status: "available"
    });
    expect(inbox[0]).not.toHaveProperty("claimToken");
  });

  it("matches target and source projects by deterministic project key", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Project aliases should still route.",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });

    expect(handoffs.listInbox({ targetProject: "vault-collab" })).toHaveLength(1);
    expect(handoffs.listInbox({ sourceProject: "vault_collab" })[0]?.handoffUid).toBe(
      handoff.handoffUid
    );
    expect(handoffs.listInbox({ targetProject: "other-project" })).toEqual([]);
  });

  it("routes inbox handoffs by persisted project keys instead of mutable display labels", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Route by durable key.",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });

    db.prepare("UPDATE handoffs SET source_project = ?, target_project = ? WHERE handoff_uid = ?").run(
      "Renamed Source Label",
      "Renamed Target Label",
      handoff.handoffUid
    );

    expect(handoffs.listInbox({ targetProject: "vault-collab" })[0]?.handoffUid).toBe(
      handoff.handoffUid
    );
    expect(handoffs.listInbox({ sourceProject: "vault_collab" })[0]?.handoffUid).toBe(
      handoff.handoffUid
    );
  });

  it("publishes labeled handoffs with deterministic queue positions", () => {
    const defaultQueue = handoffs.publishHandoff({
      shortPrompt: "Default queue",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    const explicitPosition = handoffs.publishHandoff({
      shortPrompt: "Explicit queue position",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      queueKey: "phase-1",
      labels: ["qa", "phase-1"],
      queuePosition: 500
    });
    const nextPosition = handoffs.publishHandoff({
      shortPrompt: "Next queue position",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      queueKey: "phase-1"
    });
    const aliasPosition = handoffs.publishHandoff({
      shortPrompt: "Alias queue position",
      sourceProject: "Vault Collab",
      targetProject: "vault-collab",
      queueKey: "phase-1"
    });

    expect(defaultQueue).toMatchObject({
      queueKey: "default",
      labels: [],
      queuePosition: 1000,
      dependsOnHandoffUid: null
    });
    expect(explicitPosition).toMatchObject({
      queueKey: "phase-1",
      labels: ["qa", "phase-1"],
      queuePosition: 500,
      dependsOnHandoffUid: null
    });
    expect(nextPosition).toMatchObject({
      queueKey: "phase-1",
      labels: [],
      queuePosition: 1500
    });
    expect(aliasPosition).toMatchObject({
      queueKey: "phase-1",
      labels: [],
      queuePosition: 2500
    });
  });

  it("filters and orders inbox handoffs by queue metadata", () => {
    const laterNormal = handoffs.publishHandoff({
      shortPrompt: "Later normal",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      queueKey: "phase-1",
      queuePosition: 2000
    });
    const earlierNormal = handoffs.publishHandoff({
      shortPrompt: "Earlier normal",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      queueKey: "phase-1",
      queuePosition: 1000
    });
    const urgent = handoffs.publishHandoff({
      shortPrompt: "Urgent",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      queueKey: "phase-1",
      queuePosition: 3000,
      urgent: true
    });
    handoffs.publishHandoff({
      shortPrompt: "Other queue",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      queueKey: "phase-2",
      queuePosition: 100
    });

    expect(
      handoffs
        .listInbox({
          targetProject: "Vault Collab",
          queueKey: "phase-1"
        })
        .map((handoff) => handoff.handoffUid)
    ).toEqual([urgent.handoffUid, earlierNormal.handoffUid, laterNormal.handoffUid]);
  });

  it("updates handoff queue metadata only for the source or claimed session owner", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Metadata update",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: codex.sessionUid
    });

    expect(() =>
      handoffs.updateHandoffMetadata(handoff.handoffUid, claude.sessionUid, claude.sessionToken, {
        labels: ["wrong-owner"]
      })
    ).toThrow(/source session or claimed session/i);
    expect(() =>
      handoffs.updateHandoffMetadata(handoff.handoffUid, codex.sessionUid, "wrong-token", {
        labels: ["wrong-token"]
      })
    ).toThrow(/invalid session token/i);

    const sourceUpdated = handoffs.updateHandoffMetadata(
      handoff.handoffUid,
      codex.sessionUid,
      codex.sessionToken,
      {
        queueKey: "phase-1",
        labels: ["ready"],
        queuePosition: 1200,
        dependsOnHandoffUid: "vc_handoff_previous"
      }
    );

    expect(sourceUpdated).toMatchObject({
      queueKey: "phase-1",
      labels: ["ready"],
      queuePosition: 1200,
      dependsOnHandoffUid: "vc_handoff_previous"
    });

    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    const claimUpdated = handoffs.updateHandoffMetadata(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      {
        labels: ["claimed-review"],
        queuePosition: 1300
      }
    );

    expect(claimUpdated).toMatchObject({
      queueKey: "phase-1",
      labels: ["claimed-review"],
      queuePosition: 1300,
      dependsOnHandoffUid: "vc_handoff_previous"
    });
  });

  it("claims a handoff once and records the claiming session", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Claim me",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: codex.sessionUid
    });
    now = new Date("2026-05-28T11:01:00.000Z");

    const claimed = handoffs.claimHandoff(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken
    );

    expect(claimed).toMatchObject({
      handoffUid: handoff.handoffUid,
      status: "claimed",
      claimedBySessionUid: claude.sessionUid,
      updatedAt: "2026-05-28T11:01:00.000Z"
    });
    expect(sessions.listSessions({ clientType: "claude-code" })[0].currentHandoffUid).toBe(
      handoff.handoffUid
    );
    expect(() =>
      handoffs.claimHandoff(handoff.handoffUid, codex.sessionUid, codex.sessionToken)
    ).toThrow(/already claimed/i);
  });

  it("describes owner-token-aware handoff actions for dashboards", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Render safe dashboard buttons",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: codex.sessionUid
    });

    const availableActions = handoffs.getHandoffActions(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken
    );

    expect(availableActions).toMatchObject({
      handoff: {
        handoffUid: handoff.handoffUid,
        status: "available"
      },
      actingSessionUid: claude.sessionUid
    });
    expect(availableActions.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "claim",
          enabled: true,
          toolName: "vault_collab_claim_handoff",
          requiresOwnerToken: true
        }),
        expect.objectContaining({
          kind: "release",
          enabled: false,
          reason: "Handoff must be claimed by the acting session to release."
        })
      ])
    );
    expect(JSON.stringify(availableActions)).not.toContain(claude.sessionToken);

    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    const claimedActions = handoffs.getHandoffActions(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken
    );

    expect(claimedActions.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "claim",
          enabled: false,
          reason: "Handoff is already claimed by the acting session."
        }),
        expect.objectContaining({
          kind: "update",
          enabled: true,
          toolName: "vault_collab_update_handoff",
          requiresProgressNote: true
        }),
        expect.objectContaining({
          kind: "resolve",
          enabled: true,
          toolName: "vault_collab_resolve_handoff",
          requiresSummary: true
        }),
        expect.objectContaining({
          kind: "release",
          enabled: true,
          toolName: "vault_collab_release_handoff"
        })
      ])
    );

    handoffs.resolveHandoff(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      "Dashboard contract verified."
    );
    const closedActions = handoffs.getHandoffActions(
      handoff.handoffUid,
      codex.sessionUid,
      codex.sessionToken
    );

    expect(closedActions.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "claim",
          enabled: false,
          reason: "Handoff is closed: resolved."
        }),
        expect.objectContaining({
          kind: "reopen",
          enabled: true,
          toolName: "vault_collab_reopen_handoff",
          requiresReason: true,
          requiresOwnerToken: false
        })
      ])
    );
  });

  it("requires the owning session token to claim and update handoffs", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Token check",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });

    expect(() => handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, "wrong-token")).toThrow(
      /invalid session token/i
    );

    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);

    expect(() =>
      handoffs.updateHandoff(
        handoff.handoffUid,
        codex.sessionUid,
        codex.sessionToken,
        "in_progress",
        "not my claim"
      )
    ).toThrow(/not claimed by session/i);
  });

  it("updates a claimed handoff with progress status and note", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Update me",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    now = new Date("2026-05-28T11:02:00.000Z");

    const updated = handoffs.updateHandoff(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      "in_progress",
      "Writing the handoff service tests"
    );

    expect(updated).toMatchObject({
      status: "in_progress",
      progressNote: "Writing the handoff service tests",
      updatedAt: "2026-05-28T11:02:00.000Z"
    });
    expect(handoffs.getHandoff(handoff.handoffUid)?.progressNote).toBe(
      "Writing the handoff service tests"
    );
    expect(sessions.listSessions({ clientType: "claude-code" })[0]).toMatchObject({
      status: "working",
      statusDetail: "Writing the handoff service tests"
    });
  });

  it("keeps the owning session status in sync with handoff lifecycle state", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Keep session state honest",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });

    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    expect(sessions.listSessions({ clientType: "claude-code" })[0]).toMatchObject({
      status: "working",
      statusDetail: `Claimed handoff ${handoff.handoffUid}.`
    });

    handoffs.updateHandoff(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      "blocked",
      "Waiting for dashboard API support."
    );
    expect(sessions.listSessions({ clientType: "claude-code" })[0]).toMatchObject({
      status: "blocked",
      statusDetail: "Waiting for dashboard API support."
    });

    handoffs.requestUserConfirmation(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      "Continue with localhost-only implementation?"
    );
    expect(sessions.listSessions({ clientType: "claude-code" })[0]).toMatchObject({
      status: "awaiting_user",
      statusDetail: "Continue with localhost-only implementation?"
    });

    handoffs.updateHandoff(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      "verification_needed",
      "Ready for operator verification."
    );
    expect(sessions.listSessions({ clientType: "claude-code" })[0]).toMatchObject({
      status: "awaiting_verification",
      statusDetail: "Ready for operator verification."
    });

    handoffs.releaseHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    expect(sessions.listSessions({ clientType: "claude-code" })[0]).toMatchObject({
      status: "idle",
      statusDetail: null,
      currentHandoffUid: null
    });
  });

  it("rejects terminal statuses through the generic progress update path", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Do not terminal-update me",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);

    for (const status of ["abandoned", "stale"] as const) {
      expect(() =>
        handoffs.updateHandoff(
          handoff.handoffUid,
          claude.sessionUid,
          claude.sessionToken,
          status,
          `Attempting ${status}`
        )
      ).toThrow(/dedicated lifecycle method/i);
    }

    expect(handoffs.getHandoff(handoff.handoffUid)).toMatchObject({
      status: "claimed",
      progressNote: null
    });
  });

  it("links Vault memory to an existing handoff only for the source session owner", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Link a saved Vault brief.",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: codex.sessionUid
    });
    now = new Date("2026-05-28T11:02:15.000Z");

    expect(() =>
      handoffs.linkVaultMemoryFromSession(
        handoff.handoffUid,
        claude.sessionUid,
        claude.sessionToken,
        "vm_late_full_brief"
      )
    ).toThrow(/source session/i);
    expect(() =>
      handoffs.linkVaultMemoryFromSession(
        handoff.handoffUid,
        codex.sessionUid,
        "wrong-token",
        "vm_late_full_brief"
      )
    ).toThrow(/invalid session token/i);

    const linked = handoffs.linkVaultMemoryFromSession(
      handoff.handoffUid,
      codex.sessionUid,
      codex.sessionToken,
      "vm_late_full_brief"
    );

    expect(linked).toMatchObject({
      vaultMemoryUid: "vm_late_full_brief",
      updatedAt: "2026-05-28T11:02:15.000Z"
    });
    expect(events.listEvents({ handoffUid: handoff.handoffUid }).at(-1)).toMatchObject({
      eventType: "handoff.vault_memory_linked",
      sessionUid: codex.sessionUid,
      payload: {
        vaultMemoryUid: "vm_late_full_brief"
      }
    });
  });

  it("does not publicly link Vault memory when a handoff has no source session owner", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Anonymous source",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });

    expect(() =>
      handoffs.linkVaultMemoryFromSession(
        handoff.handoffUid,
        codex.sessionUid,
        codex.sessionToken,
        "vm_unowned_brief"
      )
    ).toThrow(/no source session owner/i);
  });

  it("marks a claimed handoff as awaiting user confirmation", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Ask the user",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    now = new Date("2026-05-28T11:02:30.000Z");

    const awaitingUser = handoffs.requestUserConfirmation(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      "Should I merge this branch before MCP wiring?"
    );

    expect(awaitingUser).toMatchObject({
      status: "awaiting_user",
      progressNote: "Should I merge this branch before MCP wiring?",
      updatedAt: "2026-05-28T11:02:30.000Z"
    });
    expect(events.listEvents({ handoffUid: handoff.handoffUid }).at(-1)).toMatchObject({
      eventType: "handoff.user_confirmation_requested",
      sessionUid: claude.sessionUid,
      payload: {
        question: "Should I merge this branch before MCP wiring?"
      }
    });
  });

  it("marks a claimed handoff as awaiting permission with a token-safe event", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Ask permission",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    now = new Date("2026-05-28T11:02:40.000Z");

    const awaitingPermission = handoffs.requestHandoffPermission(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      {
        question: "Allow filesystem write for generated dashboard assets?",
        requestedCapability: "filesystem-write",
        commandPreview: "npm run build",
        source: "claude-code"
      }
    );

    expect(awaitingPermission).toMatchObject({
      status: "awaiting_user",
      progressNote: "Allow filesystem write for generated dashboard assets?",
      updatedAt: "2026-05-28T11:02:40.000Z"
    });
    const permissionEvent = events.listEvents({
      handoffUid: handoff.handoffUid,
      eventType: "handoff.permission_requested"
    })[0];
    expect(permissionEvent).toMatchObject({
      eventType: "handoff.permission_requested",
      sessionUid: claude.sessionUid,
      payload: {
        permissionRequest: {
          question: "Allow filesystem write for generated dashboard assets?",
          requestedCapability: "filesystem-write",
          commandPreview: "npm run build",
          source: "claude-code",
          createdAt: "2026-05-28T11:02:40.000Z"
        }
      }
    });
    expect(JSON.stringify(permissionEvent)).not.toContain(claude.sessionToken);
    expect(() =>
      handoffs.requestHandoffPermission(
        handoff.handoffUid,
        claude.sessionUid,
        "wrong-token",
        {
          question: "Should fail."
        }
      )
    ).toThrow(/invalid session token/i);
  });

  it("releases a claimed handoff back to the available inbox", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Release me",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    now = new Date("2026-05-28T11:02:45.000Z");

    const released = handoffs.releaseHandoff(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken
    );

    expect(released).toMatchObject({
      status: "available",
      claimedBySessionUid: null,
      progressNote: null,
      updatedAt: "2026-05-28T11:02:45.000Z"
    });
    expect(sessions.listSessions({ clientType: "claude-code" })[0].currentHandoffUid).toBeNull();
    expect(handoffs.listInbox({ targetProject: "Vault Collab" })).toHaveLength(1);
    expect(() =>
      handoffs.updateHandoff(
        handoff.handoffUid,
        claude.sessionUid,
        claude.sessionToken,
        "in_progress",
        "released work"
      )
    ).toThrow(/not claimed by session/i);
  });

  it("resolves a claimed handoff without deleting its history", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Resolve me",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    now = new Date("2026-05-28T11:03:00.000Z");

    const resolved = handoffs.resolveHandoff(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      "Session service completed and verified."
    );

    expect(resolved).toMatchObject({
      status: "resolved",
      resolutionSummary: "Session service completed and verified.",
      resolvedAt: "2026-05-28T11:03:00.000Z"
    });
    expect(handoffs.listInbox({ targetProject: "Vault Collab" })).toEqual([]);
    expect(handoffs.listInbox({ status: "resolved" })).toHaveLength(1);
    expect(handoffs.getHandoff(handoff.handoffUid)).toMatchObject({
      status: "resolved",
      resolutionSummary: "Session service completed and verified."
    });
    expect(events.listEvents({ handoffUid: handoff.handoffUid }).map((event) => event.eventType)).toEqual([
      "handoff.published",
      "handoff.claimed",
      "handoff.resolved"
    ]);
  });

  it("recovers a completed handoff when the claim owner token is unavailable", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Recover me",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: codex.sessionUid
    });
    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    handoffs.updateHandoff(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      "in_progress",
      "Implementation complete, token lost before resolve"
    );
    now = new Date("2026-05-28T11:03:30.000Z");

    const recovered = handoffs.recoverHandoff(handoff.handoffUid, {
      actorSessionUid: codex.sessionUid,
      actorSessionToken: codex.sessionToken,
      reason: "Claim owner token was lost after context compaction.",
      resolutionSummary: "Completion report accepted and verified.",
      evidenceVaultMemoryUid: "vm_recovery_evidence"
    });

    expect(recovered).toMatchObject({
      status: "resolved",
      claimedBySessionUid: claude.sessionUid,
      vaultMemoryUid: "vm_recovery_evidence",
      resolutionSummary: "Completion report accepted and verified.",
      resolvedAt: "2026-05-28T11:03:30.000Z"
    });
    expect(sessions.listSessions({ clientType: "claude-code" })[0].currentHandoffUid).toBeNull();
    expect(handoffs.listInbox({ targetProject: "Vault Collab" })).toEqual([]);
    expect(() =>
      handoffs.releaseHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken)
    ).toThrow(/closed handoff/i);
    expect(handoffs.getHandoff(handoff.handoffUid)).toMatchObject({
      status: "resolved",
      claimedBySessionUid: claude.sessionUid
    });

    const recoveryEvent = events.listEvents({ handoffUid: handoff.handoffUid }).at(-1);
    expect(recoveryEvent).toMatchObject({
      eventType: "handoff.recovery_resolved",
      sessionUid: codex.sessionUid,
      payload: {
        reason: "Claim owner token was lost after context compaction.",
        summary: "Completion report accepted and verified.",
        evidenceVaultMemoryUid: "vm_recovery_evidence",
        previousClaimedBySessionUid: claude.sessionUid,
        previousStatus: "in_progress",
        actorAuthorizedBy: "source_session"
      }
    });
    expect(JSON.stringify(recoveryEvent)).not.toContain(codex.sessionToken);
    expect(JSON.stringify(recoveryEvent)).not.toContain(claude.sessionToken);
    expect(
      events.listEvents({ handoffUid: handoff.handoffUid }).map((event) => event.eventType)
    ).not.toContain("handoff.released");
  });

  it("allows only source or recovery-capable sessions to recover handoffs", () => {
    const auditor = sessions.registerSession({
      displayName: "Recovery Auditor",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        handoffRecovery: true
      }
    });
    const outsider = sessions.registerSession({
      displayName: "Observer",
      clientType: "other",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        handoffs: true
      }
    });
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Recover by auditor",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: codex.sessionUid,
      vaultMemoryUid: "vm_original_brief"
    });
    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);

    expect(() =>
      handoffs.recoverHandoff(handoff.handoffUid, {
        actorSessionUid: outsider.sessionUid,
        actorSessionToken: outsider.sessionToken,
        reason: "Not authorized.",
        resolutionSummary: "Should fail.",
        evidenceVaultMemoryUid: "vm_recovery_evidence"
      })
    ).toThrow(/source session or recovery-capable session/i);
    expect(() =>
      handoffs.recoverHandoff(handoff.handoffUid, {
        actorSessionUid: auditor.sessionUid,
        actorSessionToken: "wrong-token",
        reason: "Wrong token.",
        resolutionSummary: "Should fail.",
        evidenceVaultMemoryUid: "vm_recovery_evidence"
      })
    ).toThrow(/invalid session token/i);

    const recovered = handoffs.recoverHandoff(handoff.handoffUid, {
      actorSessionUid: auditor.sessionUid,
      actorSessionToken: auditor.sessionToken,
      reason: "Owner session was restarted and token is unavailable.",
      resolutionSummary: "Audited completion evidence accepted.",
      evidenceVaultMemoryUid: "vm_recovery_evidence"
    });

    expect(recovered).toMatchObject({
      status: "resolved",
      claimedBySessionUid: claude.sessionUid,
      vaultMemoryUid: "vm_original_brief"
    });
    expect(events.listEvents({ handoffUid: handoff.handoffUid }).at(-1)).toMatchObject({
      eventType: "handoff.recovery_resolved",
      sessionUid: auditor.sessionUid,
      payload: {
        actorAuthorizedBy: "recovery_capability",
        evidenceVaultMemoryUid: "vm_recovery_evidence"
      }
    });
  });

  it("reopens a resolved handoff as available work", () => {
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Reopen me",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab"
    });
    handoffs.claimHandoff(handoff.handoffUid, claude.sessionUid, claude.sessionToken);
    handoffs.resolveHandoff(
      handoff.handoffUid,
      claude.sessionUid,
      claude.sessionToken,
      "Initial attempt complete."
    );
    now = new Date("2026-05-28T11:04:00.000Z");

    const reopened = handoffs.reopenHandoff(
      handoff.handoffUid,
      "Verification found a missing owner-token check.",
      "available"
    );

    expect(reopened).toMatchObject({
      status: "available",
      claimedBySessionUid: null,
      progressNote: null,
      resolutionSummary: null,
      reopenReason: "Verification found a missing owner-token check.",
      resolvedAt: null,
      updatedAt: "2026-05-28T11:04:00.000Z"
    });
    expect(handoffs.listInbox({ targetProject: "Vault Collab" })).toHaveLength(1);
  });
});
