import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { AgentProfileService } from "../src/services/agent-profile.service.js";
import { EventService } from "../src/services/event.service.js";

describe("AgentProfileService", () => {
  let db: CollabDatabase;
  let now: Date;
  let service: AgentProfileService;

  beforeEach(() => {
    now = new Date("2026-05-29T12:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    service = new AgentProfileService(db, new EventService(db, clock), clock);
  });

  afterEach(() => {
    db.close();
  });

  it("exposes built-in role definitions as data", () => {
    expect(service.listRoleDefinitions().map((role) => role.role)).toEqual([
      "coordinator",
      "implementer",
      "reviewer",
      "sweeper",
      "observer"
    ]);
  });

  it("upserts durable agent profiles by stable name without exposing tokens", () => {
    const created = service.upsertAgentProfile({
      stableName: "repo-coordinator",
      displayName: "Repo Coordinator",
      role: "coordinator",
      clientType: "codex",
      project: "Vault Collab",
      description: "Coordinates handoffs for this repo",
      capabilities: {
        architectureReview: true
      },
      createdBySessionUid: "vc_sess_seed"
    });

    expect(created).toMatchObject({
      stableName: "repo-coordinator",
      displayName: "Repo Coordinator",
      role: "coordinator",
      clientType: "codex",
      project: "Vault Collab",
      description: "Coordinates handoffs for this repo",
      capabilities: {
        architectureReview: true
      },
      status: "active",
      createdBySessionUid: "vc_sess_seed",
      createdAt: "2026-05-29T12:00:00.000Z",
      updatedAt: "2026-05-29T12:00:00.000Z",
      archivedAt: null
    });
    expect(created.agentUid).toMatch(/^vc_agent_/);

    now = new Date("2026-05-29T12:05:00.000Z");
    const updated = service.upsertAgentProfile({
      stableName: "repo-coordinator",
      displayName: "Repo Coordinator v2",
      role: "reviewer",
      clientType: "codex",
      project: "Vault Collab",
      capabilities: {
        architectureReview: true,
        implementationReview: true
      }
    });

    expect(updated.agentUid).toBe(created.agentUid);
    expect(updated).toMatchObject({
      stableName: "repo-coordinator",
      displayName: "Repo Coordinator v2",
      role: "reviewer",
      capabilities: {
        architectureReview: true,
        implementationReview: true
      },
      createdAt: "2026-05-29T12:00:00.000Z",
      updatedAt: "2026-05-29T12:05:00.000Z"
    });

    const listed = service.listAgentProfiles({
      project: "Vault Collab",
      status: "active"
    });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      agentUid: created.agentUid,
      stableName: "repo-coordinator"
    });
    expect(
      service.listAgentProfiles({
        project: "vault-collab",
        status: "active"
      })
    ).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("sessionToken");
  });

  it("keeps agent identities provider-neutral across non-Codex clients", () => {
    const claudeAgent = service.upsertAgentProfile({
      stableName: "claude-reviewer",
      displayName: "Claude Reviewer",
      role: "reviewer",
      clientType: "claude-code",
      project: "Vault Collab",
      capabilities: {
        review: true
      }
    });

    expect(claudeAgent).toMatchObject({
      stableName: "claude-reviewer",
      displayName: "Claude Reviewer",
      role: "reviewer",
      clientType: "claude-code"
    });
  });

  it("routes agent profiles by persisted project key instead of mutable display label", () => {
    const agent = service.upsertAgentProfile({
      stableName: "codex-worker",
      displayName: "Codex Worker",
      role: "implementer",
      clientType: "codex",
      project: "Vault Collab"
    });

    db.prepare("UPDATE agent_profiles SET project = ? WHERE agent_uid = ?").run(
      "Renamed Display Label",
      agent.agentUid
    );

    expect(service.listAgentProfiles({ project: "vault-collab" })[0]?.agentUid).toBe(
      agent.agentUid
    );
  });
});
