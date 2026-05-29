#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createCollabDatabase } from "./database/connection.js";
import { AgentProfileService } from "./services/agent-profile.service.js";
import { AttentionService } from "./services/attention.service.js";
import { DiscussionService } from "./services/discussion.service.js";
import { EventService } from "./services/event.service.js";
import { HandoffDetailService } from "./services/handoff-detail.service.js";
import { HandoffService } from "./services/handoff.service.js";
import { SessionService } from "./services/session.service.js";
import type {
  AgentProfileStatus,
  ClientType,
  DiscussionMessageType,
  DiscussionThreadStatus,
  HandoffPriority,
  HandoffStatus,
  JsonRecord,
  SessionStatus
} from "./types.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedCommand {
  command: string;
  options: Map<string, string[]>;
}

interface Services {
  agents: AgentProfileService;
  sessions: SessionService;
  handoffs: HandoffService;
  handoffDetails: HandoffDetailService;
  discussions: DiscussionService;
  attention: AttentionService;
  events: EventService;
  close: () => void;
}

const commands = new Set([
  "check",
  "register",
  "heartbeat",
  "sessions",
  "attention",
  "state",
  "ping-session",
  "session-permission-request",
  "disconnect",
  "roles",
  "agent-upsert",
  "agents",
  "publish",
  "link-vault-memory",
  "inbox",
  "handoff",
  "handoff-metadata",
  "discussion-create",
  "discussion-add-message",
  "discussions",
  "discussion",
  "events",
  "claim",
  "update",
  "handoff-permission-request",
  "resolve",
  "recover",
  "reopen"
]);

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<CliResult> {
  let services: Services | null = null;

  try {
    const parsed = parseArgs(argv);
    services = createServices(requiredOption(parsed, "db"));
    const output = execute(parsed, services);

    return {
      exitCode: 0,
      stdout: `${JSON.stringify(output, null, 2)}\n`,
      stderr: ""
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`
    };
  } finally {
    services?.close();
  }
}

function execute(parsed: ParsedCommand, services: Services): unknown {
  switch (parsed.command) {
    case "check":
      return {
        ok: true,
        databasePath: requiredOption(parsed, "db"),
        storage: "sqlite",
        mode: "local-first",
        cliBin: "vault-collab",
        mcpBin: "vault-collab-mcp"
      };

    case "register":
      return services.sessions.registerSession({
        displayName: requiredOption(parsed, "display-name"),
        clientType: optionClientType(parsed, "client-type"),
        project: requiredOption(parsed, "project"),
        workspacePath: requiredOption(parsed, "workspace-path"),
        agentUid: optionalOption(parsed, "agent-uid") ?? null,
        capabilities: parseCapabilities(parsed.options.get("capability") ?? [])
      });

    case "heartbeat":
      return services.sessions.heartbeatSession(
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token")
      );

    case "sessions":
      return services.sessions.listSessions({
        project: optionalOption(parsed, "project"),
        clientType: optionalClientType(parsed, "client-type"),
        status: optionalSessionStatus(parsed, "status")
      });

    case "attention":
      return services.attention.getSessionAttention(requiredOption(parsed, "session-uid"), {
        sinceEventId: optionalNumberOption(parsed, "since-event-id"),
        includeCurrentHandoffs: !parsed.options.has("no-current-handoffs")
      });

    case "state":
      return services.sessions.updateSessionState(
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        optionSessionStatus(parsed, "status"),
        optionalOption(parsed, "detail") ?? null
      );

    case "ping-session":
      return services.sessions.pingSession(requiredOption(parsed, "target-session-uid"), {
        actorSessionUid: optionalOption(parsed, "actor-session-uid") ?? null,
        message: optionalOption(parsed, "message") ?? null
      });

    case "session-permission-request":
      return services.sessions.requestSessionPermission(
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        {
          question: requiredOption(parsed, "question"),
          requestedCapability: optionalOption(parsed, "requested-capability") ?? null,
          commandPreview: optionalOption(parsed, "command-preview") ?? null,
          source: optionalOption(parsed, "source") ?? null
        }
      );

    case "disconnect":
      return services.sessions.disconnectSession(
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token")
      );

    case "roles":
      return services.agents.listRoleDefinitions();

    case "agent-upsert":
      return services.agents.upsertAgentProfile({
        stableName: requiredOption(parsed, "stable-name"),
        displayName: requiredOption(parsed, "display-name"),
        role: optionalOption(parsed, "role") ?? "implementer",
        clientType: optionalClientType(parsed, "client-type") ?? null,
        project: optionalOption(parsed, "project") ?? null,
        description: optionalOption(parsed, "description") ?? null,
        capabilities: parseCapabilities(parsed.options.get("capability") ?? []),
        status: optionalAgentProfileStatus(parsed, "status") ?? "active",
        createdBySessionUid: optionalOption(parsed, "created-by-session-uid") ?? null
      });

    case "agents":
      return services.agents.listAgentProfiles({
        project: optionalOption(parsed, "project"),
        role: optionalOption(parsed, "role"),
        status: optionalAgentProfileStatus(parsed, "status")
      });

    case "publish":
      return services.handoffs.publishHandoff({
        shortPrompt: requiredOption(parsed, "short-prompt"),
        sourceProject: requiredOption(parsed, "source-project"),
        targetProject: requiredOption(parsed, "target-project"),
        relatedProjects: parsed.options.get("related-project") ?? [],
        relatedFiles: parsed.options.get("related-file") ?? [],
        sourceSessionUid: optionalOption(parsed, "source-session-uid") ?? null,
        suggestedSessionUid: optionalOption(parsed, "suggested-session-uid") ?? null,
        suggestedClientType: optionalClientType(parsed, "suggested-client-type") ?? null,
        vaultMemoryUid: optionalOption(parsed, "vault-memory-uid") ?? null,
        queueKey: optionalOption(parsed, "queue-key") ?? undefined,
        labels: parsed.options.get("label") ?? undefined,
        queuePosition: optionalNumberOption(parsed, "queue-position"),
        dependsOnHandoffUid: optionalOption(parsed, "depends-on-handoff-uid") ?? null,
        priority: optionalHandoffPriority(parsed, "priority") ?? "normal",
        urgent: parsed.options.has("urgent")
      });

    case "link-vault-memory":
      return services.handoffs.linkVaultMemoryFromSession(
        requiredOption(parsed, "handoff-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        requiredOption(parsed, "vault-memory-uid")
      );

    case "inbox":
      return services.handoffs.listInbox({
        sourceProject: optionalOption(parsed, "source-project"),
        targetProject: optionalOption(parsed, "target-project"),
        queueKey: optionalOption(parsed, "queue-key"),
        label: optionalOption(parsed, "label"),
        status: optionalHandoffStatus(parsed, "status"),
        includeResolved: parsed.options.has("include-resolved")
      });

    case "handoff":
      return services.handoffDetails.getHandoffDetail(requiredOption(parsed, "handoff-uid"));

    case "handoff-metadata":
      return services.handoffs.updateHandoffMetadata(
        requiredOption(parsed, "handoff-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        {
          queueKey: optionalOption(parsed, "queue-key"),
          labels: parsed.options.get("label") ?? undefined,
          queuePosition: optionalNumberOption(parsed, "queue-position"),
          dependsOnHandoffUid: optionalOption(parsed, "depends-on-handoff-uid")
        }
      );

    case "discussion-create":
      return services.discussions.createThread({
        project: requiredOption(parsed, "project"),
        handoffUid: optionalOption(parsed, "handoff-uid") ?? null,
        title: requiredOption(parsed, "title"),
        createdBySessionUid: requiredOption(parsed, "session-uid"),
        sessionToken: requiredOption(parsed, "session-token")
      });

    case "discussion-add-message":
      return services.discussions.addMessage(
        requiredOption(parsed, "thread-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        {
          messageType: optionDiscussionMessageType(parsed, "type"),
          body: requiredOption(parsed, "body"),
          metadata: parseCapabilities(parsed.options.get("metadata") ?? [])
        }
      );

    case "discussions":
      return services.discussions.listThreads({
        project: optionalOption(parsed, "project"),
        handoffUid: optionalOption(parsed, "handoff-uid"),
        status: optionalDiscussionThreadStatus(parsed, "status")
      });

    case "discussion":
      return services.discussions.getThread(requiredOption(parsed, "thread-uid"));

    case "events":
      return services.events.listEvents({
        handoffUid: optionalOption(parsed, "handoff-uid"),
        sessionUid: optionalOption(parsed, "session-uid"),
        eventType: optionalOption(parsed, "event-type")
      });

    case "claim":
      return services.handoffs.claimHandoff(
        requiredOption(parsed, "handoff-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token")
      );

    case "update":
      return services.handoffs.updateHandoff(
        requiredOption(parsed, "handoff-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        optionHandoffStatus(parsed, "status"),
        requiredOption(parsed, "progress-note")
      );

    case "handoff-permission-request":
      return services.handoffs.requestHandoffPermission(
        requiredOption(parsed, "handoff-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        {
          question: requiredOption(parsed, "question"),
          requestedCapability: optionalOption(parsed, "requested-capability") ?? null,
          commandPreview: optionalOption(parsed, "command-preview") ?? null,
          source: optionalOption(parsed, "source") ?? null
        }
      );

    case "resolve":
      return services.handoffs.resolveHandoff(
        requiredOption(parsed, "handoff-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        requiredOption(parsed, "summary")
      );

    case "recover":
      return services.handoffs.recoverHandoff(requiredOption(parsed, "handoff-uid"), {
        actorSessionUid: requiredOption(parsed, "actor-session-uid"),
        actorSessionToken: requiredOption(parsed, "actor-session-token"),
        reason: requiredOption(parsed, "reason"),
        resolutionSummary: requiredOption(parsed, "summary"),
        evidenceVaultMemoryUid: requiredOption(parsed, "evidence-vault-memory-uid")
      });

    case "reopen":
      return services.handoffs.reopenHandoff(
        requiredOption(parsed, "handoff-uid"),
        requiredOption(parsed, "reason"),
        optionalHandoffStatus(parsed, "status") ?? "available"
      );

    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

function createServices(dbPath: string): Services {
  const db = createCollabDatabase(dbPath);
  const events = new EventService(db);
  const agents = new AgentProfileService(db, events);
  const sessions = new SessionService(db, events);
  const handoffs = new HandoffService(db, events);
  const discussions = new DiscussionService(db, events);
  const attention = new AttentionService(db, sessions, handoffs, discussions, events);

  return {
    agents,
    sessions,
    handoffs,
    handoffDetails: new HandoffDetailService(handoffs, events, sessions, discussions),
    discussions,
    attention,
    events,
    close: () => db.close()
  };
}

function parseArgs(argv: string[]): ParsedCommand {
  const command = argv[0];
  if (!command) {
    throw new Error(`Missing command. Available commands: ${Array.from(commands).join(", ")}`);
  }

  if (!commands.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = new Map<string, string[]>();

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    const values = options.get(name) ?? [];

    if (!next || next.startsWith("--")) {
      values.push("true");
      options.set(name, values);
      continue;
    }

    values.push(next);
    options.set(name, values);
    index += 1;
  }

  return {
    command,
    options
  };
}

function requiredOption(parsed: ParsedCommand, name: string): string {
  const value = optionalOption(parsed, name);
  if (!value) {
    throw new Error(`Missing required option: --${name}`);
  }

  return value;
}

function optionalOption(parsed: ParsedCommand, name: string): string | undefined {
  return parsed.options.get(name)?.at(-1);
}

function optionalNumberOption(parsed: ParsedCommand, name: string): number | undefined {
  const value = optionalOption(parsed, name);
  if (value === undefined) {
    return undefined;
  }

  const parsedNumber = Number(value);
  if (!Number.isInteger(parsedNumber)) {
    throw new Error(`Invalid number for --${name}: ${value}`);
  }

  return parsedNumber;
}

function parseCapabilities(values: string[]): JsonRecord {
  return Object.fromEntries(values.map(parseCapability));
}

function parseCapability(value: string): [string, unknown] {
  const separator = value.indexOf("=");
  if (separator === -1) {
    throw new Error(`Capability must use key=value format: ${value}`);
  }

  const key = value.slice(0, separator);
  const rawValue = value.slice(separator + 1);
  if (!key) {
    throw new Error(`Capability key cannot be empty: ${value}`);
  }

  if (rawValue === "true") {
    return [key, true];
  }

  if (rawValue === "false") {
    return [key, false];
  }

  const numberValue = Number(rawValue);
  if (Number.isFinite(numberValue) && rawValue.trim() !== "") {
    return [key, numberValue];
  }

  return [key, rawValue];
}

function optionClientType(parsed: ParsedCommand, name: string): ClientType {
  return parseClientType(requiredOption(parsed, name));
}

function optionalClientType(parsed: ParsedCommand, name: string): ClientType | undefined {
  const value = optionalOption(parsed, name);
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

function optionSessionStatus(parsed: ParsedCommand, name: string): SessionStatus {
  return parseSessionStatus(requiredOption(parsed, name));
}

function optionalSessionStatus(parsed: ParsedCommand, name: string): SessionStatus | undefined {
  const value = optionalOption(parsed, name);
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

function optionHandoffStatus(parsed: ParsedCommand, name: string): HandoffStatus {
  return parseHandoffStatus(requiredOption(parsed, name));
}

function optionalHandoffStatus(parsed: ParsedCommand, name: string): HandoffStatus | undefined {
  const value = optionalOption(parsed, name);
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

function optionalHandoffPriority(parsed: ParsedCommand, name: string): HandoffPriority | undefined {
  const value = optionalOption(parsed, name);
  return value ? parseHandoffPriority(value) : undefined;
}

function parseHandoffPriority(value: string): HandoffPriority {
  const allowed: HandoffPriority[] = ["low", "normal", "high", "urgent"];
  if (!allowed.includes(value as HandoffPriority)) {
    throw new Error(`Invalid handoff priority: ${value}`);
  }

  return value as HandoffPriority;
}

function optionalAgentProfileStatus(
  parsed: ParsedCommand,
  name: string
): AgentProfileStatus | undefined {
  const value = optionalOption(parsed, name);
  return value ? parseAgentProfileStatus(value) : undefined;
}

function parseAgentProfileStatus(value: string): AgentProfileStatus {
  const allowed: AgentProfileStatus[] = ["active", "archived"];
  if (!allowed.includes(value as AgentProfileStatus)) {
    throw new Error(`Invalid agent profile status: ${value}`);
  }

  return value as AgentProfileStatus;
}

function optionDiscussionMessageType(parsed: ParsedCommand, name: string): DiscussionMessageType {
  const value = requiredOption(parsed, name);
  const allowed: DiscussionMessageType[] = [
    "note",
    "question",
    "proposal",
    "concern",
    "decision",
    "system"
  ];
  if (!allowed.includes(value as DiscussionMessageType)) {
    throw new Error(`Invalid discussion message type: ${value}`);
  }

  return value as DiscussionMessageType;
}

function optionalDiscussionThreadStatus(
  parsed: ParsedCommand,
  name: string
): DiscussionThreadStatus | undefined {
  const value = optionalOption(parsed, name);
  return value ? parseDiscussionThreadStatus(value) : undefined;
}

function parseDiscussionThreadStatus(value: string): DiscussionThreadStatus {
  const allowed: DiscussionThreadStatus[] = ["open", "resolved"];
  if (!allowed.includes(value as DiscussionThreadStatus)) {
    throw new Error(`Invalid discussion thread status: ${value}`);
  }

  return value as DiscussionThreadStatus;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
