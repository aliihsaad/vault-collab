import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { EventService } from "../src/services/event.service.js";
import { HandoffService } from "../src/services/handoff.service.js";
import { VaultLinkedHandoffService, type VaultMemoryClient } from "../src/services/vault-link.service.js";
import type { JsonRecord, RegisteredSession } from "../src/types.js";
import { SessionService } from "../src/services/session.service.js";

const workspacePath = "C:\\workspace\\vault-collab";

interface CapturedMemorySave {
  title: string;
  project: string;
  memoryType: string;
  subject: string;
  summary: string;
  content: string;
  keywords: string[];
  tags: string[];
  relatedFiles: string[];
  nextSteps: string[];
  sourceApp: string;
  metadata: JsonRecord;
}

class RecordingVaultMemoryClient implements VaultMemoryClient {
  saves: CapturedMemorySave[] = [];

  async saveMemory(input: CapturedMemorySave): Promise<{ itemUid: string }> {
    this.saves.push(input);
    return { itemUid: "vm_linked_brief" };
  }
}

describe("VaultLinkedHandoffService", () => {
  let db: CollabDatabase;
  let events: EventService;
  let sessions: SessionService;
  let handoffs: HandoffService;
  let vault: RecordingVaultMemoryClient;
  let linkedHandoffs: VaultLinkedHandoffService;
  let codex: RegisteredSession;

  beforeEach(() => {
    const now = new Date("2026-05-28T12:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    events = new EventService(db, clock);
    sessions = new SessionService(db, events, clock);
    handoffs = new HandoffService(db, events, clock);
    vault = new RecordingVaultMemoryClient();
    linkedHandoffs = new VaultLinkedHandoffService(handoffs, vault);
    codex = sessions.registerSession({
      displayName: "Codex",
      clientType: "codex",
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

  it("saves the full brief to Vault and stores the returned memory UID on the local handoff", async () => {
    const handoff = await linkedHandoffs.publishHandoffWithVaultMemory({
      shortPrompt: "Continue Phase 4 Vault link implementation.",
      fullBrief:
        "Implement an injectable Vault memory link so future clients can inspect a durable full brief.",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      relatedProjects: ["Codex-brain"],
      relatedFiles: ["src/services/vault-link.service.ts", "tests/vault-link.service.test.ts"],
      sourceSessionUid: codex.sessionUid,
      suggestedClientType: "claude-code",
      priority: "high",
      urgent: true,
      vaultProject: "Vault Collab",
      vaultTitle: "Handoff: Phase 4 Vault link",
      vaultSubject: "Vault Collab Phase 4 linked handoff brief",
      keywords: ["vault-collab", "phase-4", "handoff"],
      tags: ["handoff", "phase-4"],
      nextSteps: ["Claim the handoff from any MCP client", "Update progress through Vault Collab"]
    });

    expect(vault.saves).toHaveLength(1);
    expect(vault.saves[0]).toMatchObject({
      title: "Handoff: Phase 4 Vault link",
      project: "Vault Collab",
      memoryType: "handoff",
      subject: "Vault Collab Phase 4 linked handoff brief",
      summary: "Continue Phase 4 Vault link implementation.",
      keywords: ["vault-collab", "phase-4", "handoff"],
      tags: ["handoff", "phase-4"],
      relatedFiles: ["src/services/vault-link.service.ts", "tests/vault-link.service.test.ts"],
      nextSteps: ["Claim the handoff from any MCP client", "Update progress through Vault Collab"],
      sourceApp: "vault-collab"
    });
    expect(vault.saves[0].content).toContain(
      "Implement an injectable Vault memory link so future clients can inspect a durable full brief."
    );
    expect(vault.saves[0].metadata).toMatchObject({
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: codex.sessionUid,
      suggestedClientType: "claude-code",
      priority: "high",
      urgent: true
    });
    expect(handoff).toMatchObject({
      vaultMemoryUid: "vm_linked_brief",
      shortPrompt: "Continue Phase 4 Vault link implementation.",
      status: "available",
      urgent: true
    });
    expect(handoffs.getHandoff(handoff.handoffUid)?.vaultMemoryUid).toBe("vm_linked_brief");
    expect(events.listEvents({ handoffUid: handoff.handoffUid }).map((event) => event.eventType)).toEqual([
      "handoff.published",
      "handoff.vault_memory_linked"
    ]);
  });

  it("does not create a local handoff when the Vault memory save fails", async () => {
    const failingVault: VaultMemoryClient = {
      saveMemory: async () => {
        throw new Error("Vault memory unavailable");
      }
    };
    linkedHandoffs = new VaultLinkedHandoffService(handoffs, failingVault);

    await expect(
      linkedHandoffs.publishHandoffWithVaultMemory({
        shortPrompt: "This should not appear locally.",
        fullBrief: "If Vault save fails, the local queue should not contain an orphaned linked handoff.",
        sourceProject: "Vault Collab",
        targetProject: "Vault Collab",
        relatedFiles: []
      })
    ).rejects.toThrow(/vault memory unavailable/i);

    expect(handoffs.listInbox({ includeResolved: true })).toEqual([]);
    expect(events.listEvents().map((event) => event.eventType)).toEqual(["session.registered"]);
  });
});
