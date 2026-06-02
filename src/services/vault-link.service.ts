import type {
  HandoffRecord,
  JsonRecord,
  PublishHandoffInput,
  PublishVaultLinkedHandoffInput
} from "../types.js";
import type { HandoffService } from "./handoff.service.js";

export interface VaultMemorySaveInput {
  title: string;
  project: string;
  memoryType: "handoff";
  subject: string;
  summary: string;
  content: string;
  keywords: string[];
  tags: string[];
  relatedFiles: string[];
  nextSteps: string[];
  sourceApp: "vault-collab";
  metadata: JsonRecord;
}

export interface VaultMemoryClient {
  saveMemory(input: VaultMemorySaveInput): Promise<{ itemUid: string }>;
}

export class VaultLinkedHandoffService {
  constructor(
    private readonly handoffs: HandoffService,
    private readonly vaultMemory: VaultMemoryClient
  ) {}

  async publishHandoffWithVaultMemory(
    input: PublishVaultLinkedHandoffInput
  ): Promise<HandoffRecord> {
    const saveResult = await this.vaultMemory.saveMemory(this.buildMemorySave(input));
    const localInput: PublishHandoffInput = {
      shortPrompt: input.shortPrompt,
      sourceProject: input.sourceProject,
      targetProject: input.targetProject,
      relatedProjects: input.relatedProjects,
      relatedFiles: input.relatedFiles,
      sourceSessionUid: input.sourceSessionUid,
      suggestedSessionUid: input.suggestedSessionUid,
      suggestedClientType: input.suggestedClientType,
      suggestedRoleProfileId: input.suggestedRoleProfileId,
      vaultMemoryUid: saveResult.itemUid,
      queueKey: input.queueKey,
      labels: input.labels,
      queuePosition: input.queuePosition,
      dependsOnHandoffUid: input.dependsOnHandoffUid,
      priority: input.priority,
      urgent: input.urgent,
      typedPayload: input.typedPayload
    };

    const handoff = this.handoffs.publishHandoff(localInput);
    return this.handoffs.linkVaultMemory(handoff.handoffUid, saveResult.itemUid);
  }

  private buildMemorySave(input: PublishVaultLinkedHandoffInput): VaultMemorySaveInput {
    return {
      title: input.vaultTitle ?? `Handoff: ${input.shortPrompt}`,
      project: input.vaultProject ?? input.targetProject,
      memoryType: "handoff",
      subject: input.vaultSubject ?? `${input.targetProject} handoff`,
      summary: input.shortPrompt,
      content: formatHandoffBrief(input),
      keywords: input.keywords ?? defaultKeywords(input),
      tags: input.tags ?? ["handoff", "vault-collab"],
      relatedFiles: input.relatedFiles ?? [],
      nextSteps: input.nextSteps ?? ["Claim or inspect this handoff through Vault Collab."],
      sourceApp: "vault-collab",
      metadata: {
        sourceProject: input.sourceProject,
        targetProject: input.targetProject,
        relatedProjects: input.relatedProjects ?? [],
        sourceSessionUid: input.sourceSessionUid ?? null,
        suggestedSessionUid: input.suggestedSessionUid ?? null,
        suggestedClientType: input.suggestedClientType ?? null,
        suggestedRoleProfileId: input.suggestedRoleProfileId ?? null,
        queueKey: input.queueKey ?? "default",
        labels: input.labels ?? [],
        dependsOnHandoffUid: input.dependsOnHandoffUid ?? null,
        typedPayloadSchemaVersion:
          input.typedPayload && typeof input.typedPayload.schema_version === "string"
            ? input.typedPayload.schema_version
            : null,
        priority: input.priority ?? "normal",
        urgent: input.urgent ?? input.priority === "urgent"
      }
    };
  }
}

function formatHandoffBrief(input: PublishVaultLinkedHandoffInput): string {
  return [
    `# ${input.vaultTitle ?? `Handoff: ${input.shortPrompt}`}`,
    "",
    "## Short Prompt",
    input.shortPrompt,
    "",
    "## Full Brief",
    input.fullBrief,
    "",
    "## Routing",
    `- Source project: ${input.sourceProject}`,
    `- Target project: ${input.targetProject}`,
    `- Related projects: ${(input.relatedProjects ?? []).join(", ") || "none"}`,
    `- Suggested client type: ${input.suggestedClientType ?? "none"}`,
    `- Suggested session: ${input.suggestedSessionUid ?? "none"}`,
    "",
    "## Related Files",
    ...(input.relatedFiles ?? []).map((file) => `- ${file}`)
  ].join("\n");
}

function defaultKeywords(input: PublishVaultLinkedHandoffInput): string[] {
  const words = [
    "vault-collab",
    "handoff",
    input.sourceProject,
    input.targetProject,
    ...(input.relatedProjects ?? [])
  ];

  return Array.from(
    new Set(
      words
        .flatMap((word) => word.toLowerCase().split(/[^a-z0-9]+/))
        .filter((word) => word.length > 1)
    )
  ).slice(0, 8);
}
