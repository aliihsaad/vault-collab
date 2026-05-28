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
  "vault_collab_list_inbox",
  "vault_collab_get_handoff",
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

const openInputSchema = z.object({}).passthrough();

export const vaultCollabToolDefinitions: VaultCollabToolDefinition[] = [
  {
    name: "vault_collab_register_session",
    title: "Register Session",
    description: "Register a provider-neutral collaboration session and return its owner token.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_heartbeat_session",
    title: "Heartbeat Session",
    description: "Update a session heartbeat when the caller presents the owner token.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_update_session_state",
    title: "Update Session State",
    description: "Update a session status and detail when the caller presents the owner token.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_list_sessions",
    title: "List Sessions",
    description: "List collaboration sessions without exposing owner tokens.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_disconnect_session",
    title: "Disconnect Session",
    description: "Mark a session disconnected without deleting its record.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_publish_handoff",
    title: "Publish Handoff",
    description: "Publish a local handoff into the target project inbox.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_publish_handoff_with_vault_memory",
    title: "Publish Handoff With Vault Memory",
    description: "Save a full handoff brief to Vault memory, then publish the linked local handoff.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_list_inbox",
    title: "List Inbox",
    description: "List open handoffs for a project or lifecycle filter.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_get_handoff",
    title: "Get Handoff",
    description: "Read a handoff by ID.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_claim_handoff",
    title: "Claim Handoff",
    description: "Atomically claim an available handoff for the owning session.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_update_handoff",
    title: "Update Handoff",
    description: "Update progress for a handoff claimed by the owning session.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_request_user_confirmation",
    title: "Request User Confirmation",
    description: "Move a claimed handoff to awaiting_user with a question.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_resolve_handoff",
    title: "Resolve Handoff",
    description: "Resolve a claimed handoff with a summary.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_reopen_handoff",
    title: "Reopen Handoff",
    description: "Reopen a handoff as recoverable work.",
    inputSchema: openInputSchema
  },
  {
    name: "vault_collab_release_handoff",
    title: "Release Handoff",
    description: "Release a claimed handoff back to the available inbox.",
    inputSchema: openInputSchema
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
    vault_collab_list_inbox: (args) =>
      handoffs.listInbox({
        sourceProject: optionalString(args, "sourceProject", "source_project"),
        targetProject: optionalString(args, "targetProject", "target_project"),
        status: optionalHandoffStatus(args, "status"),
        includeResolved: optionalBoolean(args, "includeResolved", "include_resolved") ?? false
      }),
    vault_collab_get_handoff: (args) =>
      handoffs.getHandoff(requiredString(args, "handoffUid", "handoff_uid")),
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
  const allowed: ClientType[] = [
    "codex",
    "claude-code",
    "claude-desktop",
    "octogent",
    "gemini",
    "opencode",
    "other"
  ];
  if (!allowed.includes(value as ClientType)) {
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
  const allowed: SessionStatus[] = [
    "idle",
    "working",
    "blocked",
    "awaiting_user",
    "awaiting_verification",
    "complete",
    "disconnected"
  ];
  if (!allowed.includes(value as SessionStatus)) {
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
  const allowed: HandoffStatus[] = [
    "available",
    "claimed",
    "in_progress",
    "blocked",
    "awaiting_user",
    "verification_needed",
    "resolved",
    "abandoned",
    "stale"
  ];
  if (!allowed.includes(value as HandoffStatus)) {
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
  const allowed: HandoffPriority[] = ["low", "normal", "high", "urgent"];
  if (!allowed.includes(value as HandoffPriority)) {
    throw new Error(`Invalid handoff priority: ${value}`);
  }

  return value as HandoffPriority;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
