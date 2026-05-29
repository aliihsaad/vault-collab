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
