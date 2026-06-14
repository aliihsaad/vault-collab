import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { AgentProfileService } from "../src/services/agent-profile.service.js";
import { EventService } from "../src/services/event.service.js";
import { seedTestProjects } from "./project-fixture.js";

const expectedCoreRoleProfileIds = [
  "coordinator",
  "explorer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
  "qa-evaluator",
  "security-reviewer",
  "documentation-agent",
  "runtime-loop-operator",
  "release-agent",
  "pattern-mining-agent",
  "loop-resolver"
];

describe("AgentProfileService", () => {
  let db: CollabDatabase;
  let now: Date;
  let service: AgentProfileService;

  beforeEach(() => {
    now = new Date("2026-05-29T12:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    seedTestProjects(db);
    service = new AgentProfileService(db, new EventService(db, clock), clock);
  });

  afterEach(() => {
    db.close();
  });

  it("exposes the signed-off 13 core role definitions as data", () => {
    const roles = service.listRoleDefinitions();

    expect(roles.map((role) => role.roleProfileId)).toEqual(expectedCoreRoleProfileIds);
    expect(roles.map((role) => role.role)).toEqual(expectedCoreRoleProfileIds);
    expect(roles.find((role) => role.roleProfileId === "loop-resolver")).toMatchObject({
      label: "Loop Resolver",
      defaultMutation: "read_only",
      triggerLabels: expect.arrayContaining(["loop", "unclosed", "completed-not-closed"])
    });
  });

  it("resolves aliases and label routes without granting observer write authority", () => {
    expect(service.resolveRoleProfileId("qa")).toBe("qa-evaluator");
    expect(service.resolveRoleProfileId("sweeper")).toBe("runtime-loop-operator");
    expect(service.resolveRoleProfileId("observer")).toBe("reviewer");
    expect(service.resolveRoleProfileId("unknown-custom-role")).toBeNull();

    expect(service.listRoleLabelRoutes("security")).toEqual([
      expect.objectContaining({
        label: "security",
        roleProfileId: "security-reviewer",
        requirementKind: "required",
        blocksCompletion: true
      })
    ]);
    expect(service.listRoleLabelRoutes("architecture")).toEqual([
      expect.objectContaining({
        label: "architecture",
        roleProfileId: "architect",
        requirementKind: "suggested",
        blocksCompletion: false
      })
    ]);
    expect(service.listRoleLabelRoutes("loop")).toEqual([
      expect.objectContaining({
        label: "loop",
        roleProfileId: "loop-resolver",
        requirementKind: "suggested",
        blocksCompletion: false
      })
    ]);
  });

  it("defines loop-resolver as read-only with only the scoped resolve_loop mutation", () => {
    const loopResolver = service
      .listRoleProfiles()
      .find((role) => role.roleProfileId === "loop-resolver");

    expect(loopResolver).toMatchObject({
      roleProfileId: "loop-resolver",
      defaultMutation: "read_only",
      capabilitySet: expect.arrayContaining(["vault_collab_read", "vault_memory_read", "resolve_loop"]),
      requiresEvidence: expect.arrayContaining([
        "acceptance_criteria",
        "test_output",
        "diff_summary"
      ]),
      confidenceGates: [
        expect.objectContaining({
          gate: "completion-evidence-present",
          failureStatus: "awaiting_user"
        })
      ]
    });
    expect(loopResolver?.capabilitySet).not.toContain("coordination_write");
    expect(loopResolver?.capabilitySet).not.toContain("workspace_write");
    expect(loopResolver?.toolGrants.filter((grant) => grant.defaultAllowed).map((grant) => grant.capability))
      .toEqual(["vault_collab_read", "vault_memory_read", "resolve_loop"]);
  });

  it("upserts durable agent profiles by stable name without exposing tokens", () => {
    const created = service.upsertAgentProfile({
      stableName: "repo-coordinator",
      displayName: "Repo Coordinator",
      role: "coordinator",
      roleProfileId: "coordinator",
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
      roleProfileId: "reviewer",
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

  it("persists canonical role profile ids at write time and keeps unknown roles nullable", () => {
    const qaAgent = service.upsertAgentProfile({
      stableName: "qa-agent",
      displayName: "QA Agent",
      role: "qa",
      clientType: "codex",
      project: "Vault Collab"
    });
    const customAgent = service.upsertAgentProfile({
      stableName: "custom-agent",
      displayName: "Custom Agent",
      role: "bespoke-role",
      clientType: "codex",
      project: "Vault Collab"
    });

    expect(qaAgent).toMatchObject({
      role: "qa",
      roleProfileId: "qa-evaluator"
    });
    expect(customAgent).toMatchObject({
      role: "bespoke-role",
      roleProfileId: null
    });
    expect(db.prepare("SELECT role, role_profile_id FROM agent_profiles WHERE agent_uid = ?").get(qaAgent.agentUid))
      .toEqual({ role: "qa", role_profile_id: "qa-evaluator" });
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
