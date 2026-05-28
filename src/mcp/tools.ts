import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createCollabDatabase, type CollabDatabase } from "../database/connection.js";
import { EventService } from "../services/event.service.js";
import { HandoffService } from "../services/handoff.service.js";
import { SessionService } from "../services/session.service.js";
import { VaultLinkedHandoffService, type VaultMemoryClient } from "../services/vault-link.service.js";
import type {
  ClientType,
  HandoffPriority,
  HandoffStatus,
  JsonRecord,
  SessionStatus
} from "../types.js";

export const vaultCollabToolNames = [
  "vault_collab_register_session",
  "vault_collab_heartbeat_session",
  "vault_collab_update_session_state",
  "vault_collab_list_sessions",
  "vault_collab_disconnect_session",
  "vault_collab_publish_handoff",
  "vault_collab_publish_handoff_with_vault_memory",
  "vault_collab_link_vault_memory",
  "vault_collab_list_inbox",
  "vault_collab_get_handoff",
  "vault_collab_list_events",
  "vault_collab_claim_handoff",
  "vault_collab_update_handoff",
  "vault_collab_request_user_confirmation",
  "vault_collab_resolve_handoff",
  "vault_collab_reopen_handoff",
  "vault_collab_release_handoff"
] as const;

export type VaultCollabToolName = (typeof vaultCollabToolNames)[number];

export interface VaultCollabToolResult extends CallToolResult {
  structuredContent: {
    result: unknown;
  };
}

export interface VaultCollabToolDefinition {
  name: VaultCollabToolName;
  title: string;
  description: string;
  inputSchema: z.AnyZodObject;
}

export interface VaultCollabMcpTools {
  definitions: VaultCollabToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<VaultCollabToolResult>;
  close: () => void;
}

export interface CreateVaultCollabMcpToolsOptions {
  dbPath?: string;
  db?: CollabDatabase;
  vaultMemoryClient?: VaultMemoryClient;
  clock?: () => Date;
}

const clientTypeValues = [
  "codex",
  "claude-code",
  "claude-desktop",
  "octogent",
  "gemini",
  "opencode",
  "other"
] as const satisfies readonly ClientType[];
const sessionStatusValues = [
  "idle",
  "working",
  "blocked",
  "awaiting_user",
  "awaiting_verification",
  "complete",
  "disconnected"
] as const satisfies readonly SessionStatus[];
const handoffStatusValues = [
  "available",
  "claimed",
  "in_progress",
  "blocked",
  "awaiting_user",
  "verification_needed",
  "resolved",
  "abandoned",
  "stale"
] as const satisfies readonly HandoffStatus[];
const handoffPriorityValues = [
  "low",
  "normal",
  "high",
  "urgent"
] as const satisfies readonly HandoffPriority[];

const clientTypeSchema = z.enum(clientTypeValues);
const sessionStatusSchema = z.enum(sessionStatusValues);
const handoffStatusSchema = z.enum(handoffStatusValues);
const handoffPrioritySchema = z.enum(handoffPriorityValues);

function requiredStringSchema(description: string): z.ZodString {
  return z.string().min(1).describe(description);
}

function optionalStringSchema(description: string): z.ZodOptional<z.ZodString> {
  return z.string().min(1).describe(description).optional();
}

function optionalStringArraySchema(description: string): z.ZodOptional<z.ZodArray<z.ZodString>> {
  return z.array(z.string()).describe(description).optional();
}

function optionalBooleanSchema(description: string): z.ZodOptional<z.ZodBoolean> {
  return z.boolean().describe(description).optional();
}

const registerSessionInputSchema = z.object({
  displayName: optionalStringSchema("Required if display_name is omitted. Human-readable session name."),
  display_name: optionalStringSchema("Snake_case alias for displayName."),
  clientType: clientTypeSchema.describe("Required if client_type is omitted. Provider/client identifier.").optional(),
  client_type: clientTypeSchema.describe("Snake_case alias for clientType.").optional(),
  project: requiredStringSchema("Project name this session is working in."),
  workspacePath: optionalStringSchema("Required if workspace_path is omitted. Local workspace path."),
  workspace_path: optionalStringSchema("Snake_case alias for workspacePath."),
  capabilities: z.record(z.unknown()).describe("Optional provider-neutral capability flags.").optional()
});

const ownedSessionInputSchema = z.object({
  sessionUid: optionalStringSchema("Required if session_uid is omitted. Session identifier."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid."),
  sessionToken: optionalStringSchema("Required if session_token is omitted. Private owner token."),
  session_token: optionalStringSchema("Snake_case alias for sessionToken.")
});

const updateSessionStateInputSchema = ownedSessionInputSchema.extend({
  status: sessionStatusSchema.describe("New session status."),
  detail: optionalStringSchema("Optional status detail."),
  statusDetail: optionalStringSchema("Alias for detail."),
  status_detail: optionalStringSchema("Snake_case alias for statusDetail.")
});

const listSessionsInputSchema = z.object({
  project: optionalStringSchema("Optional project filter."),
  clientType: clientTypeSchema.describe("Optional client type filter.").optional(),
  client_type: clientTypeSchema.describe("Snake_case alias for clientType.").optional(),
  status: sessionStatusSchema.describe("Optional session status filter.").optional()
});

const publishHandoffInputSchema = z.object({
  shortPrompt: optionalStringSchema("Required if short_prompt is omitted. Short handoff prompt."),
  short_prompt: optionalStringSchema("Snake_case alias for shortPrompt."),
  sourceProject: optionalStringSchema("Required if source_project is omitted. Source project name."),
  source_project: optionalStringSchema("Snake_case alias for sourceProject."),
  targetProject: optionalStringSchema("Required if target_project is omitted. Target project inbox."),
  target_project: optionalStringSchema("Snake_case alias for targetProject."),
  relatedProjects: optionalStringArraySchema("Optional related project names."),
  related_projects: optionalStringArraySchema("Snake_case alias for relatedProjects."),
  relatedFiles: optionalStringArraySchema("Optional related file paths."),
  related_files: optionalStringArraySchema("Snake_case alias for relatedFiles."),
  sourceSessionUid: optionalStringSchema("Optional source session identifier."),
  source_session_uid: optionalStringSchema("Snake_case alias for sourceSessionUid."),
  suggestedSessionUid: optionalStringSchema("Optional suggested target session identifier."),
  suggested_session_uid: optionalStringSchema("Snake_case alias for suggestedSessionUid."),
  suggestedClientType: clientTypeSchema.describe("Optional suggested target client type.").optional(),
  suggested_client_type: clientTypeSchema.describe("Snake_case alias for suggestedClientType.").optional(),
  vaultMemoryUid: optionalStringSchema("Optional existing Vault memory item UID for a full brief."),
  vault_memory_uid: optionalStringSchema("Snake_case alias for vaultMemoryUid."),
  priority: handoffPrioritySchema.describe("Optional priority. Defaults to normal.").optional(),
  urgent: optionalBooleanSchema("Optional urgent flag.")
});

const publishVaultLinkedHandoffInputSchema = publishHandoffInputSchema
  .omit({
    vaultMemoryUid: true,
    vault_memory_uid: true
  })
  .extend({
    fullBrief: optionalStringSchema("Required if full_brief is omitted. Full brief saved to Vault memory."),
    full_brief: optionalStringSchema("Snake_case alias for fullBrief."),
    vaultProject: optionalStringSchema("Optional Vault project override for the saved memory."),
    vault_project: optionalStringSchema("Snake_case alias for vaultProject."),
    vaultTitle: optionalStringSchema("Optional Vault memory title."),
    vault_title: optionalStringSchema("Snake_case alias for vaultTitle."),
    vaultSubject: optionalStringSchema("Optional Vault memory subject."),
    vault_subject: optionalStringSchema("Snake_case alias for vaultSubject."),
    keywords: optionalStringArraySchema("Optional Vault memory keywords."),
    tags: optionalStringArraySchema("Optional Vault memory tags."),
    nextSteps: optionalStringArraySchema("Optional follow-up steps for the Vault memory."),
    next_steps: optionalStringArraySchema("Snake_case alias for nextSteps.")
  });

const handoffUidInputSchema = z.object({
  handoffUid: optionalStringSchema("Required if handoff_uid is omitted. Handoff identifier."),
  handoff_uid: optionalStringSchema("Snake_case alias for handoffUid.")
});

const ownedHandoffInputSchema = handoffUidInputSchema.extend({
  sessionUid: optionalStringSchema("Required if session_uid is omitted. Owning session identifier."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid."),
  sessionToken: optionalStringSchema("Required if session_token is omitted. Private owner token."),
  session_token: optionalStringSchema("Snake_case alias for sessionToken.")
});

const linkVaultMemoryInputSchema = ownedHandoffInputSchema.extend({
  vaultMemoryUid: optionalStringSchema("Required if vault_memory_uid is omitted. Existing Vault memory item UID."),
  vault_memory_uid: optionalStringSchema("Snake_case alias for vaultMemoryUid.")
});

const listInboxInputSchema = z.object({
  sourceProject: optionalStringSchema("Optional source project filter."),
  source_project: optionalStringSchema("Snake_case alias for sourceProject."),
  targetProject: optionalStringSchema("Optional target project filter."),
  target_project: optionalStringSchema("Snake_case alias for targetProject."),
  status: handoffStatusSchema.describe("Optional handoff status filter.").optional(),
  includeResolved: optionalBooleanSchema("Include resolved handoffs when listing."),
  include_resolved: optionalBooleanSchema("Snake_case alias for includeResolved.")
});

const listEventsInputSchema = z.object({
  handoffUid: optionalStringSchema("Optional handoff event filter."),
  handoff_uid: optionalStringSchema("Snake_case alias for handoffUid."),
  sessionUid: optionalStringSchema("Optional session event filter."),
  session_uid: optionalStringSchema("Snake_case alias for sessionUid.")
});

const updateHandoffInputSchema = ownedHandoffInputSchema.extend({
  status: handoffStatusSchema.describe("New handoff status."),
  progressNote: optionalStringSchema("Required if progress_note is omitted. Progress note."),
  progress_note: optionalStringSchema("Snake_case alias for progressNote.")
});

const requestUserConfirmationInputSchema = ownedHandoffInputSchema.extend({
  question: requiredStringSchema("Question that needs user confirmation.")
});

const resolveHandoffInputSchema = ownedHandoffInputSchema.extend({
  summary: requiredStringSchema("Resolution summary.")
});

const reopenHandoffInputSchema = handoffUidInputSchema.extend({
  reason: requiredStringSchema("Reason for reopening the handoff."),
  status: handoffStatusSchema.describe("Status to reopen as. Defaults to available.").optional()
});

export const vaultCollabToolDefinitions: VaultCollabToolDefinition[] = [
  {
    name: "vault_collab_register_session",
    title: "Register Session",
    description: "Register a provider-neutral collaboration session and return its owner token.",
    inputSchema: registerSessionInputSchema
  },
  {
    name: "vault_collab_heartbeat_session",
    title: "Heartbeat Session",
    description: "Update a session heartbeat when the caller presents the owner token.",
    inputSchema: ownedSessionInputSchema
  },
  {
    name: "vault_collab_update_session_state",
    title: "Update Session State",
    description: "Update a session status and detail when the caller presents the owner token.",
    inputSchema: updateSessionStateInputSchema
  },
  {
    name: "vault_collab_list_sessions",
    title: "List Sessions",
    description: "List collaboration sessions without exposing owner tokens.",
    inputSchema: listSessionsInputSchema
  },
  {
    name: "vault_collab_disconnect_session",
    title: "Disconnect Session",
    description: "Mark a session disconnected without deleting its record.",
    inputSchema: ownedSessionInputSchema
  },
  {
    name: "vault_collab_publish_handoff",
    title: "Publish Handoff",
    description: "Publish a local handoff into the target project inbox.",
    inputSchema: publishHandoffInputSchema
  },
  {
    name: "vault_collab_publish_handoff_with_vault_memory",
    title: "Publish Handoff With Vault Memory",
    description: "Save a full handoff brief to Vault memory, then publish the linked local handoff.",
    inputSchema: publishVaultLinkedHandoffInputSchema
  },
  {
    name: "vault_collab_link_vault_memory",
    title: "Link Vault Memory",
    description: "Link an existing handoff to an existing Vault memory item as the source session owner.",
    inputSchema: linkVaultMemoryInputSchema
  },
  {
    name: "vault_collab_list_inbox",
    title: "List Inbox",
    description: "List open handoffs for a project or lifecycle filter.",
    inputSchema: listInboxInputSchema
  },
  {
    name: "vault_collab_get_handoff",
    title: "Get Handoff",
    description: "Read a handoff by ID.",
    inputSchema: handoffUidInputSchema
  },
  {
    name: "vault_collab_list_events",
    title: "List Events",
    description: "List inspectable session and handoff event history without mutating state.",
    inputSchema: listEventsInputSchema
  },
  {
    name: "vault_collab_claim_handoff",
    title: "Claim Handoff",
    description: "Atomically claim an available handoff for the owning session.",
    inputSchema: ownedHandoffInputSchema
  },
  {
    name: "vault_collab_update_handoff",
    title: "Update Handoff",
    description: "Update progress for a handoff claimed by the owning session.",
    inputSchema: updateHandoffInputSchema
  },
  {
    name: "vault_collab_request_user_confirmation",
    title: "Request User Confirmation",
    description: "Move a claimed handoff to awaiting_user with a question.",
    inputSchema: requestUserConfirmationInputSchema
  },
  {
    name: "vault_collab_resolve_handoff",
    title: "Resolve Handoff",
    description: "Resolve a claimed handoff with a summary.",
    inputSchema: resolveHandoffInputSchema
  },
  {
    name: "vault_collab_reopen_handoff",
    title: "Reopen Handoff",
    description: "Reopen a handoff as recoverable work.",
    inputSchema: reopenHandoffInputSchema
  },
  {
    name: "vault_collab_release_handoff",
    title: "Release Handoff",
    description: "Release a claimed handoff back to the available inbox.",
    inputSchema: ownedHandoffInputSchema
  }
];

export function createVaultCollabMcpTools(
  options: CreateVaultCollabMcpToolsOptions
): VaultCollabMcpTools {
  const db = options.db ?? createCollabDatabase(options.dbPath ?? ":memory:");
  const ownsDb = !options.db;
  const events = new EventService(db, options.clock);
  const sessions = new SessionService(db, events, options.clock);
  const handoffs = new HandoffService(db, events, options.clock);
  const linkedHandoffs = options.vaultMemoryClient
    ? new VaultLinkedHandoffService(handoffs, options.vaultMemoryClient)
    : null;

  const handlers: Record<
    VaultCollabToolName,
    (args: Record<string, unknown>) => unknown | Promise<unknown>
  > = {
    vault_collab_register_session: (args) =>
      sessions.registerSession({
        displayName: requiredString(args, "displayName", "display_name"),
        clientType: requiredClientType(args, "clientType", "client_type"),
        project: requiredString(args, "project"),
        workspacePath: requiredString(args, "workspacePath", "workspace_path"),
        capabilities: optionalRecord(args, "capabilities") ?? {}
      }),
    vault_collab_heartbeat_session: (args) =>
      sessions.heartbeatSession(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token")
      ),
    vault_collab_update_session_state: (args) =>
      sessions.updateSessionState(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredSessionStatus(args, "status"),
        optionalString(args, "detail", "statusDetail", "status_detail") ?? null
      ),
    vault_collab_list_sessions: (args) =>
      sessions.listSessions({
        project: optionalString(args, "project"),
        clientType: optionalClientType(args, "clientType", "client_type"),
        status: optionalSessionStatus(args, "status")
      }),
    vault_collab_disconnect_session: (args) =>
      sessions.disconnectSession(
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token")
      ),
    vault_collab_publish_handoff: (args) =>
      handoffs.publishHandoff({
        shortPrompt: requiredString(args, "shortPrompt", "short_prompt"),
        sourceProject: requiredString(args, "sourceProject", "source_project"),
        targetProject: requiredString(args, "targetProject", "target_project"),
        relatedProjects: optionalStringArray(args, "relatedProjects", "related_projects") ?? [],
        relatedFiles: optionalStringArray(args, "relatedFiles", "related_files") ?? [],
        sourceSessionUid: optionalString(args, "sourceSessionUid", "source_session_uid") ?? null,
        suggestedSessionUid:
          optionalString(args, "suggestedSessionUid", "suggested_session_uid") ?? null,
        suggestedClientType:
          optionalClientType(args, "suggestedClientType", "suggested_client_type") ?? null,
        vaultMemoryUid: optionalString(args, "vaultMemoryUid", "vault_memory_uid") ?? null,
        priority: optionalHandoffPriority(args, "priority") ?? "normal",
        urgent: optionalBoolean(args, "urgent") ?? false
      }),
    vault_collab_publish_handoff_with_vault_memory: (args) => {
      if (!linkedHandoffs) {
        throw new Error("Vault memory client is not configured for linked handoff publishing");
      }

      return linkedHandoffs.publishHandoffWithVaultMemory({
        shortPrompt: requiredString(args, "shortPrompt", "short_prompt"),
        fullBrief: requiredString(args, "fullBrief", "full_brief"),
        sourceProject: requiredString(args, "sourceProject", "source_project"),
        targetProject: requiredString(args, "targetProject", "target_project"),
        relatedProjects: optionalStringArray(args, "relatedProjects", "related_projects") ?? [],
        relatedFiles: optionalStringArray(args, "relatedFiles", "related_files") ?? [],
        sourceSessionUid: optionalString(args, "sourceSessionUid", "source_session_uid") ?? null,
        suggestedSessionUid:
          optionalString(args, "suggestedSessionUid", "suggested_session_uid") ?? null,
        suggestedClientType:
          optionalClientType(args, "suggestedClientType", "suggested_client_type") ?? null,
        priority: optionalHandoffPriority(args, "priority") ?? "normal",
        urgent: optionalBoolean(args, "urgent") ?? false,
        vaultProject: optionalString(args, "vaultProject", "vault_project"),
        vaultTitle: optionalString(args, "vaultTitle", "vault_title"),
        vaultSubject: optionalString(args, "vaultSubject", "vault_subject"),
        keywords: optionalStringArray(args, "keywords") ?? undefined,
        tags: optionalStringArray(args, "tags") ?? undefined,
        nextSteps: optionalStringArray(args, "nextSteps", "next_steps") ?? undefined
      });
    },
    vault_collab_link_vault_memory: (args) =>
      handoffs.linkVaultMemoryFromSession(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "vaultMemoryUid", "vault_memory_uid")
      ),
    vault_collab_list_inbox: (args) =>
      handoffs.listInbox({
        sourceProject: optionalString(args, "sourceProject", "source_project"),
        targetProject: optionalString(args, "targetProject", "target_project"),
        status: optionalHandoffStatus(args, "status"),
        includeResolved: optionalBoolean(args, "includeResolved", "include_resolved") ?? false
      }),
    vault_collab_get_handoff: (args) =>
      handoffs.getHandoff(requiredString(args, "handoffUid", "handoff_uid")),
    vault_collab_list_events: (args) =>
      events.listEvents({
        handoffUid: optionalString(args, "handoffUid", "handoff_uid"),
        sessionUid: optionalString(args, "sessionUid", "session_uid")
      }),
    vault_collab_claim_handoff: (args) =>
      handoffs.claimHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token")
      ),
    vault_collab_update_handoff: (args) =>
      handoffs.updateHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredHandoffStatus(args, "status"),
        requiredString(args, "progressNote", "progress_note")
      ),
    vault_collab_request_user_confirmation: (args) =>
      handoffs.requestUserConfirmation(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "question")
      ),
    vault_collab_resolve_handoff: (args) =>
      handoffs.resolveHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token"),
        requiredString(args, "summary")
      ),
    vault_collab_reopen_handoff: (args) =>
      handoffs.reopenHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "reason"),
        optionalHandoffStatus(args, "status") ?? "available"
      ),
    vault_collab_release_handoff: (args) =>
      handoffs.releaseHandoff(
        requiredString(args, "handoffUid", "handoff_uid"),
        requiredString(args, "sessionUid", "session_uid"),
        requiredString(args, "sessionToken", "session_token")
      )
  };

  return {
    definitions: vaultCollabToolDefinitions,
    callTool: async (name, args) => {
      if (!isVaultCollabToolName(name)) {
        return errorResult(`Unknown Vault Collab tool: ${name}`);
      }

      try {
        return successResult(await handlers[name](args));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
    close: () => {
      if (ownsDb) {
        db.close();
      }
    }
  };
}

function isVaultCollabToolName(name: string): name is VaultCollabToolName {
  return (vaultCollabToolNames as readonly string[]).includes(name);
}

function successResult(result: unknown): VaultCollabToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: {
      result
    }
  };
}

function errorResult(message: string): VaultCollabToolResult {
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    structuredContent: {
      result: {
        error: message
      }
    },
    isError: true
  };
}

function requiredString(args: Record<string, unknown>, ...keys: string[]): string {
  const value = optionalValue(args, keys);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required string: ${keys[0]}`);
  }

  return value;
}

function optionalString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = optionalValue(args, keys);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected string: ${keys[0]}`);
  }

  return value;
}

function optionalBoolean(args: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  const value = optionalValue(args, keys);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean: ${keys[0]}`);
  }

  return value;
}

function optionalStringArray(args: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  const value = optionalValue(args, keys);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected string array: ${keys[0]}`);
  }

  return value;
}

function optionalRecord(args: Record<string, unknown>, ...keys: string[]): JsonRecord | undefined {
  const value = optionalValue(args, keys);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`Expected object: ${keys[0]}`);
  }

  return value;
}

function optionalValue(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      return args[key];
    }
  }

  return undefined;
}

function requiredClientType(args: Record<string, unknown>, ...keys: string[]): ClientType {
  return parseClientType(requiredString(args, ...keys));
}

function optionalClientType(args: Record<string, unknown>, ...keys: string[]): ClientType | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseClientType(value) : undefined;
}

function parseClientType(value: string): ClientType {
  if (!clientTypeValues.includes(value as (typeof clientTypeValues)[number])) {
    throw new Error(`Invalid client type: ${value}`);
  }

  return value as ClientType;
}

function requiredSessionStatus(args: Record<string, unknown>, ...keys: string[]): SessionStatus {
  return parseSessionStatus(requiredString(args, ...keys));
}

function optionalSessionStatus(
  args: Record<string, unknown>,
  ...keys: string[]
): SessionStatus | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseSessionStatus(value) : undefined;
}

function parseSessionStatus(value: string): SessionStatus {
  if (!sessionStatusValues.includes(value as (typeof sessionStatusValues)[number])) {
    throw new Error(`Invalid session status: ${value}`);
  }

  return value as SessionStatus;
}

function requiredHandoffStatus(args: Record<string, unknown>, ...keys: string[]): HandoffStatus {
  return parseHandoffStatus(requiredString(args, ...keys));
}

function optionalHandoffStatus(
  args: Record<string, unknown>,
  ...keys: string[]
): HandoffStatus | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseHandoffStatus(value) : undefined;
}

function parseHandoffStatus(value: string): HandoffStatus {
  if (!handoffStatusValues.includes(value as (typeof handoffStatusValues)[number])) {
    throw new Error(`Invalid handoff status: ${value}`);
  }

  return value as HandoffStatus;
}

function optionalHandoffPriority(
  args: Record<string, unknown>,
  ...keys: string[]
): HandoffPriority | undefined {
  const value = optionalString(args, ...keys);
  return value ? parseHandoffPriority(value) : undefined;
}

function parseHandoffPriority(value: string): HandoffPriority {
  if (!handoffPriorityValues.includes(value as (typeof handoffPriorityValues)[number])) {
    throw new Error(`Invalid handoff priority: ${value}`);
  }

  return value as HandoffPriority;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
