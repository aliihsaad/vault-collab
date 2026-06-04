import {
  coreRoleProfileIds,
  type AgentRoleDefinition,
  type CoreRoleProfileId,
  type EvidenceKind,
  type RoleLabelRoute,
  type RoleProfile,
  type RoleProfileSkills,
  type RoleProviderSupport,
  type RoleToolGrant
} from "./types.js";

export const roleProfileSchemaVersion = "vault_collab.role_profile.v1" as const;

export interface RoleProfileAliasSeed {
  alias: string;
  roleProfileId: CoreRoleProfileId;
  source: "built_in" | "legacy";
}

export interface RoleLabelRouteSeed {
  label: string;
  roleProfileId: CoreRoleProfileId;
  requirementKind: "suggested" | "required";
  priority: number;
  evidenceRequired?: EvidenceKind[];
  blocksCompletion?: boolean;
}

const adapterBackedProviderSupport: RoleProviderSupport[] = [
  { clientType: "codex", supportLevel: "adapter_backed" },
  { clientType: "claude-code", supportLevel: "adapter_backed" },
  { clientType: "claude-desktop", supportLevel: "instruction_backed" },
  { clientType: "octogent", supportLevel: "instruction_backed" },
  { clientType: "gemini", supportLevel: "instruction_backed" },
  { clientType: "opencode", supportLevel: "instruction_backed" },
  { clientType: "other", supportLevel: "reference_only" }
];

function grant(capability: RoleToolGrant["capability"], notes?: string): RoleToolGrant {
  return {
    capability,
    defaultAllowed: true,
    approvalRequired: false,
    ...(notes ? { notes } : {})
  };
}

function skillRef(skill: string, triggerCondition: string): RoleProfileSkills["primary"][number] {
  return {
    skill,
    path: `skills/${skill}/SKILL.md`,
    triggerCondition
  };
}

const builtInRoleProfileSkills: Record<CoreRoleProfileId, RoleProfileSkills> = {
  coordinator: {
    primary: [
      skillRef(
        "project-flow-ops",
        "Trigger when the role must triage incoming work, relate handoffs to public/internal queues, or keep active work surfaces consistent."
      ),
      skillRef(
        "plan-orchestrate",
        "Trigger when a multi-step plan must become ordered handoffs with suggested roles, dependencies, and acceptance criteria."
      ),
      skillRef(
        "team-builder",
        "Trigger when independent work needs a bounded multi-agent team instead of a single executor."
      ),
      skillRef(
        "parallel-execution-optimizer",
        "Trigger when work can be split into concurrent lanes but still needs correctness and merge discipline."
      ),
      skillRef(
        "agent-sort",
        "Trigger when deciding which skills/roles should be default, daily, library, or project-specific for a queue."
      ),
      skillRef(
        "council",
        "Trigger when a coordinator needs structured disagreement before a routing, go/no-go, or prioritization decision."
      ),
      skillRef(
        "automation-audit-ops",
        "Trigger when the coordinator must identify which jobs, hooks, wrappers, or automations are actually live before assigning work."
      )
    ],
    secondary: [
      skillRef(
        "dmux-workflows",
        "Trigger when coordinating multiple live agent sessions; adapt tmux-pane concepts to Vault Collab sessions and handoffs."
      ),
      skillRef(
        "claude-devfleet",
        "Trigger when dispatching isolated multi-agent coding work; adapt Claude-specific worktrees/reports into provider-neutral handoffs."
      ),
      skillRef(
        "enterprise-agent-ops",
        "Trigger when long-lived role workloads need lifecycle, observability, and incident controls."
      ),
      skillRef(
        "unified-notifications-ops",
        "Trigger when inbox, attention, escalation, and dedupe behavior is the coordination problem."
      ),
      skillRef(
        "cost-tracking",
        "Trigger when routing choices depend on token, session, or project cost budgets."
      )
    ]
  },
  explorer: {
    primary: [
      skillRef(
        "codebase-onboarding",
        "Trigger when the role must map an unfamiliar repository, entry points, architecture, and conventions."
      ),
      skillRef(
        "search-first",
        "Trigger before proposing custom work when existing tools, libraries, patterns, or references may already solve it."
      ),
      skillRef(
        "research-ops",
        "Trigger when the role must build a recommendation from explicit evidence boundaries and current state."
      ),
      skillRef("deep-research", "Trigger when broad multi-source research and cited synthesis are needed."),
      skillRef(
        "iterative-retrieval",
        "Trigger when initial context is uncertain and the role should gather, evaluate, and refine in passes."
      ),
      skillRef(
        "workspace-surface-audit",
        "Trigger when the role must inventory repo, MCP, plugin, connector, and environment surfaces."
      ),
      skillRef(
        "skill-scout",
        "Trigger when the role is specifically looking for an existing skill or workflow before creating/adapting one."
      )
    ],
    secondary: [
      skillRef(
        "repo-scan",
        "Trigger when full source asset classification is needed; adapt reports into Vault Memory artifacts."
      ),
      skillRef(
        "exa-search",
        "Trigger when neural web/code/company research is needed; adapt to available search providers."
      ),
      skillRef(
        "documentation-lookup",
        "Trigger when current API/library docs are needed before interpreting a code or integration surface."
      ),
      skillRef("ecc-guide", "Trigger when answering ECC capability questions by reading the live ECC repo surface."),
      skillRef(
        "knowledge-ops",
        "Trigger when exploration must reconcile live repo truth with durable memory or knowledge-base records."
      )
    ]
  },
  planner: {
    primary: [
      skillRef(
        "plan-orchestrate",
        "Trigger when converting a written plan into executable, role-routed handoff steps."
      ),
      skillRef(
        "prompt-optimizer",
        "Trigger when a vague objective needs a self-contained prompt or handoff brief with scope and missing context resolved."
      ),
      skillRef(
        "recursive-decision-ledger",
        "Trigger when several candidate plans need explicit evidence, rollout comparison, or decision traceability."
      ),
      skillRef(
        "context-budget",
        "Trigger when a plan risks overloading role prompts, MCP context, or session context windows."
      ),
      skillRef(
        "token-budget-advisor",
        "Trigger when planning depth, model usage, or response size must be budgeted before execution."
      ),
      skillRef(
        "tdd-workflow",
        "Trigger when the plan includes implementation or bugfix work that should be test-first."
      ),
      skillRef(
        "search-first",
        "Trigger before finalizing a plan where existing packages or patterns may change the implementation path."
      )
    ],
    secondary: [
      skillRef(
        "product-capability",
        "Trigger when product intent must become an implementation-ready capability contract."
      ),
      skillRef(
        "architecture-decision-records",
        "Trigger when the plan includes a significant architecture/process decision that needs durable rationale."
      ),
      skillRef(
        "blueprint",
        "Trigger when a large feature/refactor must be broken into PR-sized work with dependency order."
      ),
      skillRef(
        "ralphinho-rfc-pipeline",
        "Trigger when a plan should become a DAG of work units with risk tiers, quality gates, and rollback plans."
      ),
      skillRef(
        "product-lens",
        "Trigger when the planner must validate the why/user journey before accepting a feature as implementation work."
      )
    ]
  },
  architect: {
    primary: [
      skillRef(
        "agent-architecture-audit",
        "Trigger when auditing or designing agent-system layers, memory, tool routing, repair loops, or rendering/transport behavior."
      ),
      skillRef(
        "agent-harness-construction",
        "Trigger when designing tool schemas, action spaces, observations, and recovery contracts for agents."
      ),
      skillRef(
        "agentic-engineering",
        "Trigger when decomposing architecture work into independently verifiable units with eval-first execution."
      ),
      skillRef(
        "workspace-surface-audit",
        "Trigger when the architect must understand the actual repo/MCP/plugin/harness surface before choosing architecture."
      ),
      skillRef(
        "context-budget",
        "Trigger when architecture decisions affect loaded roles, prompt bloat, MCP over-subscription, or context pressure."
      ),
      skillRef(
        "recursive-decision-ledger",
        "Trigger when architecture alternatives need explicit comparison and promotion rules."
      )
    ],
    secondary: [
      skillRef(
        "architecture-decision-records",
        "Trigger when architectural choices must be saved as ADR-like Vault Memory decisions."
      ),
      skillRef(
        "api-design",
        "Trigger when Vault Collab MCP/HTTP contracts need resource, status, pagination, error, or versioning review."
      ),
      skillRef(
        "mcp-server-patterns",
        "Trigger when designing or reviewing Vault Collab MCP tools/resources/prompts and transports."
      ),
      skillRef(
        "deployment-patterns",
        "Trigger when architecture touches CI/CD, rollout, health checks, rollback, or production readiness."
      ),
      skillRef(
        "product-capability",
        "Trigger when the architect needs implementation-facing constraints and invariants before service design."
      )
    ]
  },
  implementer: {
    primary: [
      skillRef("tdd-workflow", "Trigger for any implementation, bugfix, or refactor expected to change behavior."),
      skillRef(
        "gateguard",
        "Trigger before first edits, writes, or destructive commands to force concrete investigation and scope proof."
      ),
      skillRef(
        "terminal-ops",
        "Trigger when implementation requires repo commands, narrow fixes, or exact evidence of execution and verification."
      ),
      skillRef(
        "verification-loop",
        "Trigger after implementation to prove build/type/lint/test status before reporting complete."
      ),
      skillRef(
        "agentic-engineering",
        "Trigger when implementation should be decomposed into independently verifiable units with dominant risks."
      ),
      skillRef(
        "search-first",
        "Trigger before implementing custom code where an existing package, helper, or repo pattern may exist."
      )
    ],
    secondary: [
      skillRef(
        "coding-standards",
        "Trigger when implementation needs cross-project readability, immutability, naming, and maintainability rules."
      ),
      skillRef(
        "error-handling",
        "Trigger when adding or changing error paths, retries, circuit breakers, or user-facing failures."
      ),
      skillRef(
        "mcp-server-patterns",
        "Trigger when implementation involves Vault Collab MCP tools, resources, validation, or transport behavior."
      ),
      skillRef(
        "git-workflow",
        "Trigger when implementation needs branch/commit/merge conventions or conflict-resolution planning."
      ),
      skillRef(
        "deployment-patterns",
        "Trigger when implementation changes release, health check, rollout, or rollback surfaces."
      )
    ]
  },
  reviewer: {
    primary: [
      skillRef(
        "plankton-code-quality",
        "Trigger when reviewing code quality, lint/format adherence, or hook-based quality enforcement."
      ),
      skillRef(
        "santa-method",
        "Trigger when output needs independent adversarial review and convergence before shipping."
      ),
      skillRef(
        "verification-loop",
        "Trigger when review must verify reported build/type/lint/test evidence rather than rely on summaries."
      ),
      skillRef(
        "agent-architecture-audit",
        "Trigger when review touches agent-system behavior, hidden repair loops, memory pollution, or tool discipline."
      ),
      skillRef(
        "skill-comply",
        "Trigger when reviewing whether a skill/rule/agent definition is actually being followed in traces or scenarios."
      ),
      skillRef(
        "ai-regression-testing",
        "Trigger when reviewer wants tests that catch AI blind spots and author-reviewer shared assumptions."
      )
    ],
    secondary: [
      skillRef(
        "production-audit",
        "Trigger when review should answer production readiness or what-breaks-in-prod questions."
      ),
      skillRef(
        "coding-standards",
        "Trigger when review needs baseline readability, simplicity, immutability, and maintainability criteria."
      ),
      skillRef(
        "error-handling",
        "Trigger when review focuses on failure modes, retries, typed errors, or swallowed errors."
      ),
      skillRef(
        "browser-qa",
        "Trigger when review must validate deployed/local UI behavior visually or interactively."
      ),
      skillRef(
        "architecture-decision-records",
        "Trigger when reviewing architecture changes for missing durable decision rationale."
      )
    ]
  },
  "qa-evaluator": {
    primary: [
      skillRef(
        "eval-harness",
        "Trigger when defining formal capability, regression, or grader-based evals for agent/session behavior."
      ),
      skillRef(
        "agent-eval",
        "Trigger when comparing agents, models, or role profiles on pass rate, cost, time, and consistency."
      ),
      skillRef(
        "ai-regression-testing",
        "Trigger when QA must catch model-introduced regressions and sandbox/production mismatches."
      ),
      skillRef(
        "verification-loop",
        "Trigger when QA must run or verify deterministic build/type/lint/test phases."
      ),
      skillRef(
        "skill-comply",
        "Trigger when QA evaluates whether role/skill rules happen in the expected behavioral sequence."
      ),
      skillRef(
        "santa-method",
        "Trigger when QA needs independent review agents to converge before accepting an output."
      ),
      skillRef(
        "tdd-workflow",
        "Trigger when QA participates before implementation by defining failing tests and coverage expectations."
      )
    ],
    secondary: [
      skillRef(
        "e2e-testing",
        "Trigger when QA needs Playwright-style E2E flows, POMs, artifacts, or flaky-test strategy."
      ),
      skillRef(
        "browser-qa",
        "Trigger when QA must verify UI smoke, interaction, accessibility, or visual regression behavior."
      ),
      skillRef(
        "windows-desktop-e2e",
        "Trigger when QA touches Windows desktop UI automation or native app interaction."
      ),
      skillRef(
        "benchmark",
        "Trigger when QA must measure performance or compare implementations under a repeatable benchmark."
      ),
      skillRef(
        "canary-watch",
        "Trigger when QA must monitor a deployed URL or post-release surface for regressions."
      )
    ]
  },
  "security-reviewer": {
    primary: [
      skillRef(
        "security-review",
        "Trigger when code handles auth, user input, secrets, API endpoints, payments, permissions, or sensitive data."
      ),
      skillRef(
        "security-scan",
        "Trigger when scanning agent configs, MCP definitions, hooks, prompts, or settings for injection/misconfiguration risks."
      ),
      skillRef(
        "safety-guard",
        "Trigger when autonomous or production-impacting operations could become destructive."
      ),
      skillRef(
        "gateguard",
        "Trigger before risky edits, writes, or commands to require explicit facts and user authorization."
      ),
      skillRef(
        "agent-architecture-audit",
        "Trigger when security risk may come from agent memory, wrappers, hidden repair loops, tool routing, or transport layers."
      )
    ],
    secondary: [
      skillRef(
        "mcp-server-patterns",
        "Trigger when reviewing MCP tool/resource schemas, Zod validation, transport choices, or registration safety."
      ),
      skillRef(
        "api-design",
        "Trigger when API surface security depends on contract shape, rate limits, errors, versioning, or pagination."
      ),
      skillRef(
        "deployment-patterns",
        "Trigger when rollout, rollback, health checks, or CI/CD controls affect security posture."
      ),
      skillRef(
        "enterprise-agent-ops",
        "Trigger when long-lived agent workloads need security boundaries and operational controls."
      ),
      skillRef(
        "error-handling",
        "Trigger when exception messages, retries, and failure surfaces could leak secrets or hide incidents."
      )
    ]
  },
  "documentation-agent": {
    primary: [
      skillRef(
        "codebase-onboarding",
        "Trigger when documentation must explain architecture, entry points, conventions, and onboarding paths."
      ),
      skillRef(
        "research-ops",
        "Trigger when docs need explicit sourced facts, evidence boundaries, and current-state synthesis."
      ),
      skillRef(
        "rules-distill",
        "Trigger when repeated skill or workflow patterns should become concise durable rules."
      ),
      skillRef(
        "prompt-optimizer",
        "Trigger when documentation should turn a vague workflow into a self-contained operational prompt or template."
      ),
      skillRef(
        "skill-scout",
        "Trigger when docs work starts by searching existing skills/templates before writing new guidance."
      ),
      skillRef(
        "skill-stocktake",
        "Trigger when documentation-agent audits skill or command quality, duplication, or stale guidance."
      )
    ],
    secondary: [
      skillRef(
        "documentation-lookup",
        "Trigger when docs depend on current external API/library behavior."
      ),
      skillRef(
        "knowledge-ops",
        "Trigger when documentation must be saved, organized, deduplicated, or synced across durable knowledge layers."
      ),
      skillRef("ecc-guide", "Trigger when documenting or explaining ECC by reading its live repository surface."),
      skillRef(
        "architecture-decision-records",
        "Trigger when docs should capture why a decision was made, alternatives, and future implications."
      ),
      skillRef(
        "repo-scan",
        "Trigger when documentation needs a complete source asset inventory or module classification."
      )
    ]
  },
  "runtime-loop-operator": {
    primary: [
      skillRef(
        "agent-introspection-debugging",
        "Trigger when an agent run loops, stalls, repeats tools, exhausts limits, or drifts from the task."
      ),
      skillRef(
        "terminal-ops",
        "Trigger when runtime operation requires evidence-first command execution or status checks."
      ),
      skillRef(
        "verification-loop",
        "Trigger when runtime state must be verified before advancing or resolving a loop."
      ),
      skillRef(
        "context-budget",
        "Trigger when runtime loops risk context exhaustion or overloaded role/tool surfaces."
      ),
      skillRef(
        "strategic-compact",
        "Trigger when a long loop should checkpoint/compact at a logical phase boundary."
      ),
      skillRef(
        "safety-guard",
        "Trigger when autonomous runtime behavior risks destructive operations or production impact."
      ),
      skillRef(
        "automation-audit-ops",
        "Trigger when runtime-loop-operator must inventory live jobs, hooks, wrappers, or broken automation before intervening."
      )
    ],
    secondary: [
      skillRef(
        "continuous-agent-loop",
        "Trigger when designing loop selection, gates, recovery, and stop conditions for continuous agents."
      ),
      skillRef(
        "autonomous-loops",
        "Trigger when mapping sequential, infinite, PR, or DAG loop patterns into Vault Collab handoff/session control."
      ),
      skillRef(
        "autonomous-agent-harness",
        "Trigger when long-running autonomous operation needs persistent memory, scheduling, queues, and consent boundaries."
      ),
      skillRef(
        "canary-watch",
        "Trigger when runtime operation must monitor deployed surfaces for failures after changes."
      ),
      skillRef(
        "enterprise-agent-ops",
        "Trigger when loops become long-lived workloads needing observability, incidents, and baseline controls."
      )
    ]
  },
  "release-agent": {
    primary: [
      skillRef(
        "verification-loop",
        "Trigger when release readiness depends on deterministic build/type/lint/test proof."
      ),
      skillRef(
        "safety-guard",
        "Trigger when release actions could be destructive, irreversible, or production-impacting."
      ),
      skillRef(
        "gateguard",
        "Trigger before release-impacting commands or writes that require concrete facts and rollback awareness."
      ),
      skillRef(
        "ai-regression-testing",
        "Trigger when release risk includes AI-authored regressions or sandbox/production path mismatches."
      ),
      skillRef(
        "santa-method",
        "Trigger when release output requires independent adversarial review before shipping."
      ),
      skillRef(
        "terminal-ops",
        "Trigger when release-agent must run exact commands and report proof."
      ),
      skillRef(
        "project-flow-ops",
        "Trigger when release work must reconcile PRs, issues, labels, and active execution state."
      )
    ],
    secondary: [
      skillRef(
        "deployment-patterns",
        "Trigger when release involves rollout strategy, health checks, rollback, or production readiness."
      ),
      skillRef(
        "canary-watch",
        "Trigger when a deployed URL or service must be watched after release."
      ),
      skillRef(
        "git-workflow",
        "Trigger when release-agent needs branch, commit, merge, tag, or conflict-resolution workflow rules."
      ),
      skillRef(
        "github-ops",
        "Trigger when release requires PR checks, release management, CI status, labels, or GitHub automation."
      ),
      skillRef(
        "production-audit",
        "Trigger when release should be checked for production failure modes beyond green tests."
      ),
      skillRef(
        "cost-tracking",
        "Trigger when release/readiness decisions need token, tool, or session cost visibility."
      )
    ]
  },
  "pattern-mining-agent": {
    primary: [
      skillRef(
        "continuous-learning-v2",
        "Trigger when repeated session/handoff behavior should become an evidence-backed, project-scoped instinct."
      ),
      skillRef(
        "rules-distill",
        "Trigger when repeated patterns across skills/workflows should become durable rules."
      ),
      skillRef(
        "skill-stocktake",
        "Trigger when auditing skills/commands for quality, duplication, stale content, or candidate consolidation."
      ),
      skillRef(
        "skill-scout",
        "Trigger when mining should search local/external skill sources before creating a new pattern."
      ),
      skillRef(
        "skill-comply",
        "Trigger when mined patterns need behavioral compliance tests across scenarios."
      ),
      skillRef(
        "recursive-decision-ledger",
        "Trigger when pattern candidates need evidence, promotion rules, and visible decision trace."
      ),
      skillRef(
        "research-ops",
        "Trigger when pattern mining needs evidence boundaries and current-state comparison."
      ),
      skillRef(
        "agent-sort",
        "Trigger when mined skills/roles must be classified into default vs library/on-demand buckets."
      )
    ],
    secondary: [
      skillRef(
        "knowledge-ops",
        "Trigger when mined patterns need durable storage, dedupe, retrieval, or cross-layer organization."
      ),
      skillRef(
        "ck",
        "Trigger when session memory/checkpoint patterns should inspire Vault Memory save/resume flows."
      ),
      skillRef(
        "hookify-rules",
        "Trigger when mined behavior should become hook/event rules rather than prose guidance."
      ),
      skillRef(
        "continuous-agent-loop",
        "Trigger when loop behavior generates recurring patterns worth extracting into stop/recovery policy."
      ),
      skillRef(
        "repo-scan",
        "Trigger when mining starts from deterministic inventory of files/modules before LLM judgment."
      )
    ]
  },
  "loop-resolver": {
    primary: [
      skillRef(
        "agent-introspection-debugging",
        "Trigger when a claimed handoff, session, or agent has repeated failures, loop-limit errors, or no-exit behavior."
      ),
      skillRef(
        "gateguard",
        "Trigger before any recovery action that edits, writes, executes, or changes lifecycle state based on insufficient facts."
      ),
      skillRef(
        "safety-guard",
        "Trigger when resolving a loop could affect production, delete data, force git state, or disrupt another session."
      ),
      skillRef(
        "verification-loop",
        "Trigger before marking a loop resolved to prove the expected state is actually achieved."
      ),
      skillRef(
        "recursive-decision-ledger",
        "Trigger when deciding fixed vs wont_fix vs obsolete vs duplicate needs a transparent evidence trail."
      ),
      skillRef(
        "terminal-ops",
        "Trigger when loop resolution requires exact local command/status evidence."
      ),
      skillRef(
        "context-budget",
        "Trigger when the loop is caused or worsened by context pressure, prompt bloat, or overloaded tool surfaces."
      )
    ],
    secondary: [
      skillRef(
        "autonomous-loops",
        "Trigger when resolving a loop requires identifying missing exit conditions, cost caps, or DAG/PR loop failure modes."
      ),
      skillRef(
        "continuous-agent-loop",
        "Trigger when recovery should adapt continuous-loop failure modes, gates, and stop-condition guidance."
      ),
      skillRef(
        "canary-watch",
        "Trigger when loop resolution must verify a deployed/runtime surface stays healthy afterward."
      ),
      skillRef(
        "error-handling",
        "Trigger when the loop is caused by missing error typing, retries, swallowed failures, or unclear failure boundaries."
      ),
      skillRef(
        "enterprise-agent-ops",
        "Trigger when loop recovery belongs to broader incident/lifecycle management for long-lived agent workloads."
      )
    ]
  }
};

function profile(
  roleProfileId: CoreRoleProfileId,
  displayName: string,
  purpose: string,
  lifecycleStage: RoleProfile["lifecycleStage"],
  defaultMutation: RoleProfile["defaultMutation"],
  capabilitySet: RoleProfile["capabilitySet"],
  triggerLabels: string[],
  requiresEvidence: RoleProfile["requiresEvidence"],
  outputContract: RoleProfile["outputContract"],
  overrides: Partial<RoleProfile> = {}
): RoleProfile {
  return {
    roleProfileId,
    schemaVersion: roleProfileSchemaVersion,
    displayName,
    purpose,
    lifecycleStage,
    defaultMutation,
    capabilitySet,
    toolGrants: capabilitySet.map((capability) => grant(capability)),
    triggerLabels,
    requiresEvidence,
    outputContract,
    stopConditions: ["missing required evidence", "scope or authority is unclear"],
    confidenceGates: [],
    requiresRoles: [],
    suggestedRoles: [],
    suggestedNextRoles: [],
    skills: builtInRoleProfileSkills[roleProfileId],
    providerSupport: adapterBackedProviderSupport,
    status: "active",
    ...overrides
  };
}

export const builtInRoleProfiles: RoleProfile[] = [
  profile(
    "coordinator",
    "Coordinator",
    "Route work, synthesize status, maintain queue order, ask for user decisions, and publish review or implementation handoffs.",
    "coordination",
    "coordination_write",
    [
      "vault_collab_read",
      "vault_collab_write",
      "sessionAdmin",
      "publish_handoff",
      "create_discussion",
      "vault_memory_read",
      "vault_memory_write"
    ],
    ["coordination", "coordinator", "triage", "blocked", "synthesis", "approval", "queue"],
    ["vault_memory", "discussion_decision", "acceptance_criteria"],
    {
      primary: "coordination summary",
      requiredFields: ["queueStatus", "decisions", "nextHandoffs"],
      vaultMemoryType: "summary",
      publishesHandoff: true
    },
    {
      suggestedRoles: [
        { roleProfileId: "explorer", reason: "gather codebase context" },
        { roleProfileId: "planner", reason: "decompose work" },
        { roleProfileId: "architect", reason: "review durable contracts" },
        { roleProfileId: "runtime-loop-operator", reason: "handle live coordination stalls" }
      ],
      suggestedNextRoles: ["planner", "architect", "implementer"]
    }
  ),
  profile(
    "explorer",
    "Explorer",
    "Gather evidence before planning or implementation; identify files, flows, dependencies, and unknowns.",
    "discovery",
    "read_only",
    ["read_files", "search_files", "inspect_graph", "vault_memory_read"],
    ["discovery", "research", "inventory", "map", "code-map", "investigation"],
    ["source_files", "graph_context", "vault_memory"],
    {
      primary: "discovery report",
      requiredFields: ["facts", "inferences", "suggestedNextRoles"],
      vaultMemoryType: "artifact",
      publishesHandoff: true
    },
    { suggestedNextRoles: ["planner", "architect"] }
  ),
  profile(
    "planner",
    "Planner",
    "Convert requirements and discovery into ordered, testable handoffs with acceptance criteria.",
    "planning",
    "coordination_write",
    [
      "vault_memory_read",
      "vault_memory_write",
      "publish_handoff",
      "create_discussion",
      "vault_collab_read",
      "vault_collab_write"
    ],
    ["plan", "roadmap", "decompose", "phase", "implementation-plan", "orchestration"],
    ["vault_memory", "acceptance_criteria", "source_files"],
    {
      primary: "implementation plan",
      requiredFields: ["acceptanceCriteria", "orderedHandoffs"],
      vaultMemoryType: "plan",
      publishesHandoff: true
    },
    { suggestedNextRoles: ["architect", "implementer", "reviewer", "qa-evaluator"] }
  ),
  profile(
    "architect",
    "Architect",
    "Design durable schemas, boundaries, contracts, migration strategy, and integration gates.",
    "planning",
    "read_only",
    [
      "read_files",
      "search_files",
      "inspect_graph",
      "vault_memory_read",
      "vault_memory_write",
      "publish_handoff",
      "create_discussion"
    ],
    ["architecture", "schema", "migration-design", "system-design", "api-contract", "adr"],
    ["source_files", "vault_memory", "graph_context", "discussion_decision"],
    {
      primary: "architecture artifact",
      requiredFields: ["design", "risks", "testGates"],
      vaultMemoryType: "artifact",
      publishesHandoff: true
    },
    { suggestedNextRoles: ["implementer", "reviewer", "security-reviewer"] }
  ),
  profile(
    "implementer",
    "Implementer",
    "Execute approved, scoped workspace changes and report verification evidence.",
    "implementation",
    "workspace_write",
    [
      "read_files",
      "search_files",
      "edit_files",
      "shell_commands",
      "run_tests",
      "vault_collab_write",
      "vault_memory_write"
    ],
    ["implementation", "feature", "bugfix", "build", "tdd", "refactor"],
    ["acceptance_criteria", "source_files", "test_output", "diff_summary"],
    {
      primary: "implementation summary",
      requiredFields: ["changedFiles", "verification", "diffSummary"],
      vaultMemoryType: "summary",
      publishesHandoff: true
    },
    { suggestedNextRoles: ["reviewer", "qa-evaluator", "security-reviewer"] }
  ),
  profile(
    "reviewer",
    "Reviewer",
    "Independently review code or design changes for regressions, contract breaks, missing tests, and unsafe assumptions.",
    "review",
    "read_only",
    ["read_files", "search_files", "inspect_graph", "run_tests", "vault_memory_read", "vault_memory_write"],
    ["review", "code-review", "contract", "regression", "audit", "pr-review", "observer"],
    ["diff_summary", "source_files", "test_output"],
    {
      primary: "review findings",
      requiredFields: ["findings", "evidence"],
      vaultMemoryType: "summary",
      publishesHandoff: false
    },
    { suggestedNextRoles: ["qa-evaluator", "security-reviewer"] }
  ),
  profile(
    "qa-evaluator",
    "QA Evaluator",
    "Verify completed work through tests, smoke checks, live workflows, and acceptance evidence.",
    "verification",
    "read_only",
    ["run_tests", "browser_check", "read_files", "vault_memory_write", "vault_collab_write"],
    ["qa", "verification", "e2e", "smoke", "acceptance", "release-gate", "test"],
    ["acceptance_criteria", "test_output", "runtime_artifact", "diff_summary"],
    {
      primary: "QA report",
      requiredFields: ["status", "testOutput", "artifacts"],
      vaultMemoryType: "summary",
      publishesHandoff: false
    },
    { suggestedNextRoles: ["reviewer", "security-reviewer", "release-agent"] }
  ),
  profile(
    "security-reviewer",
    "Security Reviewer",
    "Review security boundaries, owner-token safety, permissions, prompt injection, external actions, and supply-chain risks.",
    "review",
    "read_only",
    [
      "security_scan",
      "read_files",
      "search_files",
      "external_connector_review",
      "vault_memory_write",
      "create_discussion"
    ],
    ["security", "token-safety", "permission", "secrets", "prompt-injection", "external-action"],
    ["security_findings", "source_files", "vault_memory", "discussion_decision"],
    {
      primary: "security findings",
      requiredFields: ["findings", "blockers", "remediation"],
      vaultMemoryType: "summary",
      publishesHandoff: false
    },
    { suggestedNextRoles: ["architect", "reviewer", "release-agent"] }
  ),
  profile(
    "documentation-agent",
    "Documentation Agent",
    "Maintain docs, codemaps, release notes, and source-of-truth references tied to implementation or architecture changes.",
    "implementation",
    "workspace_write",
    ["read_files", "search_files", "edit_files", "vault_memory_read", "vault_memory_write"],
    ["docs", "documentation", "readme", "codemap", "changelog", "handoff-docs"],
    ["source_files", "diff_summary", "vault_memory"],
    {
      primary: "documentation update",
      requiredFields: ["changedDocs", "sourceEvidence"],
      vaultMemoryType: "summary",
      publishesHandoff: false
    },
    { suggestedNextRoles: ["reviewer", "release-agent"] }
  ),
  profile(
    "runtime-loop-operator",
    "Runtime Loop Operator",
    "Supervise live coordination health: leases, stale handoffs, blocked or idle sessions, repeated failures, permission waits, and loop escalation.",
    "operations",
    "coordination_write",
    [
      "vault_collab_read",
      "vault_collab_write",
      "sessionAdmin",
      "claim_handoff",
      "create_discussion",
      "vault_memory_write"
    ],
    ["runtime", "stale", "lease", "blocked", "idle", "attention", "permission-needed", "stuck"],
    ["vault_memory", "discussion_decision", "runtime_artifact"],
    {
      primary: "loop status",
      requiredFields: ["status", "recommendation"],
      vaultMemoryType: "summary",
      publishesHandoff: true
    },
    { suggestedNextRoles: ["coordinator", "qa-evaluator", "security-reviewer"] }
  ),
  profile(
    "release-agent",
    "Release Agent",
    "Coordinate packaging, release, deploy readiness, rollback planning, and final release evidence.",
    "release",
    "approval_required",
    ["release_coordination", "read_files", "run_tests", "vault_memory_write", "publish_handoff", "create_discussion"],
    ["release", "deploy", "publish", "packaging", "version", "ship", "merge-gate"],
    ["test_output", "security_findings", "acceptance_criteria", "discussion_decision"],
    {
      primary: "release checklist",
      requiredFields: ["qaEvidence", "securityEvidence", "rollbackPlan"],
      vaultMemoryType: "artifact",
      publishesHandoff: true
    },
    {
      requiresRoles: [
        { roleProfileId: "qa-evaluator", reason: "release requires QA evidence", blocksCompletionUntil: true },
        {
          roleProfileId: "security-reviewer",
          reason: "release requires security evidence",
          blocksCompletionUntil: true
        }
      ],
      suggestedNextRoles: ["documentation-agent", "coordinator"]
    }
  ),
  profile(
    "pattern-mining-agent",
    "Pattern Mining Agent",
    "Mine resolved handoffs, discussions, permission requests, failed routes, and user corrections into project-scoped role and policy proposals.",
    "learning",
    "coordination_write",
    ["pattern_mining", "vault_collab_read", "vault_memory_read", "vault_memory_write", "create_discussion"],
    ["learning", "pattern", "heuristic", "instinct", "postmortem", "recurring", "improve-routing"],
    ["vault_memory", "discussion_decision", "runtime_artifact"],
    {
      primary: "pattern proposal",
      requiredFields: ["trigger", "action", "evidence", "confidence"],
      vaultMemoryType: "artifact",
      publishesHandoff: true
    },
    { suggestedNextRoles: ["coordinator", "reviewer", "architect"] }
  ),
  profile(
    "loop-resolver",
    "Loop Resolver",
    "During implementation, watch for loops or handoffs that are functionally complete but left open, and close them with an evidence-backed resolution. Does not own implementation work, claim active handoffs, or escalate.",
    "operations",
    "read_only",
    ["vault_collab_read", "vault_memory_read", "resolve_loop"],
    ["loop", "open-loop", "unclosed", "completed-not-closed", "cleanup", "resolve", "tidy"],
    ["acceptance_criteria", "test_output", "diff_summary"],
    {
      primary: "loop-resolution log",
      requiredFields: ["resolvedLoopUid", "evidenceRef", "resolutionNote"],
      vaultMemoryType: "summary",
      publishesHandoff: false
    },
    {
      toolGrants: [
        grant("vault_collab_read"),
        grant("vault_memory_read"),
        grant(
          "resolve_loop",
          "ONLY closes loops/handoffs that already show completion evidence. No reopen, reassign, escalate, or workspace write."
        )
      ],
      stopConditions: [
        "completion evidence absent or ambiguous",
        "loop needs reopen/rework (defer to runtime-loop-operator)",
        "ownership/authority unclear",
        "any write beyond loop closure required"
      ],
      confidenceGates: [
        {
          gate: "completion-evidence-present",
          required: true,
          failureStatus: "awaiting_user"
        }
      ],
      suggestedRoles: [
        {
          roleProfileId: "runtime-loop-operator",
          reason: "escalate loops that need rework rather than closure"
        }
      ],
      suggestedNextRoles: ["coordinator"]
    }
  )
];

export const builtInRoleProfileAliases: RoleProfileAliasSeed[] = [
  ...coreRoleProfileIds.map((roleProfileId) => ({
    alias: roleProfileId,
    roleProfileId,
    source: "built_in" as const
  })),
  { alias: "sweeper", roleProfileId: "runtime-loop-operator", source: "legacy" },
  { alias: "observer", roleProfileId: "reviewer", source: "legacy" },
  { alias: "qa", roleProfileId: "qa-evaluator", source: "legacy" },
  { alias: "qa-reviewer", roleProfileId: "qa-evaluator", source: "legacy" },
  { alias: "qa-agent", roleProfileId: "qa-evaluator", source: "legacy" },
  { alias: "tester", roleProfileId: "qa-evaluator", source: "legacy" },
  { alias: "security", roleProfileId: "security-reviewer", source: "legacy" },
  { alias: "security-auditor", roleProfileId: "security-reviewer", source: "legacy" },
  { alias: "docs", roleProfileId: "documentation-agent", source: "legacy" },
  { alias: "doc-writer", roleProfileId: "documentation-agent", source: "legacy" },
  { alias: "docs-agent", roleProfileId: "documentation-agent", source: "legacy" },
  { alias: "investigator", roleProfileId: "explorer", source: "legacy" },
  { alias: "researcher", roleProfileId: "explorer", source: "legacy" },
  { alias: "read-only-explorer", roleProfileId: "explorer", source: "legacy" },
  { alias: "coder", roleProfileId: "implementer", source: "legacy" },
  { alias: "developer", roleProfileId: "implementer", source: "legacy" },
  { alias: "worker", roleProfileId: "implementer", source: "legacy" },
  { alias: "codex-agent", roleProfileId: "implementer", source: "legacy" },
  { alias: "runtime-agent", roleProfileId: "runtime-loop-operator", source: "legacy" },
  { alias: "runtime-operator", roleProfileId: "runtime-loop-operator", source: "legacy" },
  { alias: "release-manager", roleProfileId: "release-agent", source: "legacy" },
  { alias: "pattern-miner", roleProfileId: "pattern-mining-agent", source: "legacy" }
];

// Route matrix: suggested routes are advisory; required routes flag an
// independent role need; required+blocks marks future gate data only. Phase 1
// stores these facts but does not enforce handoff lifecycle blocking.
export const builtInRoleLabelRoutes: RoleLabelRouteSeed[] = [
  route("discovery", "explorer"),
  route("research", "explorer"),
  route("inventory", "explorer"),
  route("code-map", "explorer"),
  route("plan", "planner"),
  route("roadmap", "planner"),
  route("decompose", "planner"),
  route("architecture", "architect"),
  route("schema", "architect"),
  route("migration-design", "architect"),
  route("implementation", "implementer"),
  route("feature", "implementer"),
  route("bugfix", "implementer"),
  route("tdd", "implementer"),
  route("review", "reviewer", "required", 300),
  route("code-review", "reviewer", "required", 300),
  route("qa", "qa-evaluator", "required", 250, ["test_output"]),
  route("verification", "qa-evaluator", "required", 250, ["test_output"]),
  route("smoke", "qa-evaluator", "required", 250, ["test_output"]),
  route("security", "security-reviewer", "required", 100, ["security_findings"], true),
  route("token-safety", "security-reviewer", "required", 100, ["security_findings"], true),
  route("secrets", "security-reviewer", "required", 100, ["security_findings"], true),
  route("permission", "security-reviewer", "required", 100, ["security_findings"], true),
  route("docs", "documentation-agent"),
  route("documentation", "documentation-agent"),
  route("readme", "documentation-agent"),
  route("stale", "runtime-loop-operator"),
  route("lease", "runtime-loop-operator"),
  route("blocked", "runtime-loop-operator"),
  route("idle", "runtime-loop-operator"),
  route("release", "release-agent", "required", 200, ["acceptance_criteria"]),
  route("deploy", "release-agent", "required", 200, ["acceptance_criteria"]),
  route("publish", "release-agent", "required", 200, ["acceptance_criteria"]),
  route("learning", "pattern-mining-agent"),
  route("pattern", "pattern-mining-agent"),
  route("instinct", "pattern-mining-agent"),
  route("loop", "loop-resolver"),
  route("unclosed", "loop-resolver"),
  route("completed-not-closed", "loop-resolver"),
  route("cleanup", "loop-resolver")
];

function route(
  label: string,
  roleProfileId: CoreRoleProfileId,
  requirementKind: "suggested" | "required" = "suggested",
  priority = 1000,
  evidenceRequired: EvidenceKind[] = [],
  blocksCompletion = false
): RoleLabelRouteSeed {
  return {
    label,
    roleProfileId,
    requirementKind,
    priority,
    evidenceRequired,
    blocksCompletion
  };
}

export function roleProfileToDefinition(profile: RoleProfile): AgentRoleDefinition {
  return {
    role: profile.roleProfileId,
    roleProfileId: profile.roleProfileId,
    label: profile.displayName,
    description: profile.purpose,
    defaultMutation: profile.defaultMutation,
    triggerLabels: [...profile.triggerLabels]
  };
}

export function labelRouteUid(label: string, roleProfileId: CoreRoleProfileId): string {
  return `role_route_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${roleProfileId.replace(
    /[^a-z0-9]+/gi,
    "_"
  )}`;
}

export function roleLabelRouteFromSeed(
  seed: RoleLabelRouteSeed,
  createdAt: string,
  updatedAt: string
): RoleLabelRoute {
  return {
    routeUid: labelRouteUid(seed.label, seed.roleProfileId),
    label: seed.label,
    roleProfileId: seed.roleProfileId,
    requirementKind: seed.requirementKind,
    priority: seed.priority,
    evidenceRequired: seed.evidenceRequired ?? [],
    blocksCompletion: seed.blocksCompletion === true,
    createdAt,
    updatedAt
  };
}
