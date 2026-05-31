#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { getAgentOperatingGuide } from "./agent-guide.js";
import { createCollabDatabase, type CollabDatabase } from "./database/connection.js";
import { withAttentionNextAction } from "./next-actions.js";
import { AgentProfileService } from "./services/agent-profile.service.js";
import { AttentionService } from "./services/attention.service.js";
import { DiscussionService } from "./services/discussion.service.js";
import { EventService } from "./services/event.service.js";
import { HandoffDetailService } from "./services/handoff-detail.service.js";
import { HandoffService } from "./services/handoff.service.js";
import { LaunchRequestService } from "./services/launch-request.service.js";
import { AttentionReceiverService, type ReceiverAdapter } from "./services/attention-receiver.service.js";
import { SessionService } from "./services/session.service.js";
import { launchRequestStatuses, progressHandoffStatuses } from "./types.js";
import type {
  AgentProfileStatus,
  ClientType,
  DiscussionMessageType,
  DiscussionThreadStatus,
  HandoffPriority,
  HandoffStatus,
  JsonRecord,
  LaunchRequestStatus,
  SessionAttentionFeed,
  SessionAttentionItem,
  AttentionDeliveryAttemptStatus,
  SessionDeliveryMode,
  AttentionDeliveryAttempt,
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
  db: CollabDatabase;
  agents: AgentProfileService;
  sessions: SessionService;
  handoffs: HandoffService;
  handoffDetails: HandoffDetailService;
  launchRequests: LaunchRequestService;
  discussions: DiscussionService;
  attention: AttentionService;
  events: EventService;
  close: () => void;
}

interface RecommendedAttentionAction {
  kind: string;
  reason: string;
  eventId?: number;
  handoffUid?: string;
  launchRequestUid?: string;
  command?: string;
}

interface AttentionWatchResult {
  timedOut: boolean;
  elapsedMs: number;
  intervalMs: number;
  timeoutMs: number;
  attention: SessionAttentionFeed;
  recommendedActions: RecommendedAttentionAction[];
}

interface AttentionReceiveResult {
  timedOut: boolean;
  elapsedMs: number;
  intervalMs: number;
  timeoutMs: number;
  attempt: AttentionDeliveryAttempt | null;
  deliveredMessage: string | null;
  session: ReturnType<SessionService["getSession"]>;
}

const commands = new Set([
  "guide",
  "check",
  "register",
  "heartbeat",
  "sessions",
  "attention",
  "attention-ack",
  "watch-attention",
  "receive",
  "receive-attention",
  "sweep-leases",
  "delivery-attempts",
  "state",
  "ping-session",
  "session-permission-request",
  "session-rename",
  "session-close",
  "disconnect",
  "launch-create",
  "launches",
  "launch",
  "launch-detail",
  "launch-actions",
  "launch-approve",
  "launch-reject",
  "launch-cancel",
  "launch-mark-launching",
  "launch-mark-running",
  "launch-stop",
  "launch-fail",
  "roles",
  "agent-upsert",
  "agents",
  "publish",
  "link-vault-memory",
  "inbox",
  "handoff",
  "handoff-actions",
  "handoff-metadata",
  "discussion-create",
  "discussion-add-message",
  "discussions",
  "discussion",
  "events",
  "claim",
  "update",
  "user-confirmation-request",
  "handoff-permission-request",
  "resolve",
  "recover",
  "reopen"
]);

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<CliResult> {
  let services: Services | null = null;

  try {
    const parsed = parseArgs(argv);
    if (parsed.command === "guide") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(
          getAgentOperatingGuide({
            clientType: optionalClientType(parsed, "client-type") ?? null,
            project: optionalOption(parsed, "project") ?? null
          }),
          null,
          2
        )}\n`,
        stderr: ""
      };
    }

    services = createServices(requiredOption(parsed, "db"));
    const output = await execute(parsed, services);

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

async function execute(parsed: ParsedCommand, services: Services): Promise<unknown> {
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
      return withAttentionNextAction(
        services.sessions.registerSession({
          displayName: requiredOption(parsed, "display-name"),
          clientType: optionClientType(parsed, "client-type"),
          project: requiredOption(parsed, "project"),
          workspacePath: requiredOption(parsed, "workspace-path"),
          role: optionalOption(parsed, "role"),
          agentUid: optionalOption(parsed, "agent-uid") ?? null,
          capabilities: parseCapabilities(parsed.options.get("capability") ?? []),
          delivery: {
            mode: optionalSessionDeliveryMode(parsed, "delivery-mode") ?? "manual_poll",
            wakeable: parsed.options.has("wakeable")
          }
        })
      );

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

    case "attention-ack":
      return services.sessions.acknowledgeAttention(
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        requiredNumberOption(parsed, "latest-event-id")
      );

    case "watch-attention":
      return watchAttention(parsed, services);

    case "receive":
      return receive(parsed, services);

    case "receive-attention":
      return receiveAttention(parsed, services);

    case "sweep-leases": {
      const released = services.handoffs.sweepExpiredLeases();
      return {
        released,
        count: released.length
      };
    }

    case "delivery-attempts":
      return createAttentionReceiver(services).listDeliveryAttempts({
        sessionUid: optionalOption(parsed, "session-uid"),
        status: optionalAttentionDeliveryAttemptStatus(parsed, "status")
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

    case "session-rename":
      return services.sessions.renameSession(
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        requiredOption(parsed, "display-name")
      );

    case "session-close":
      return services.sessions.closeSession(
        requiredOption(parsed, "target-session-uid"),
        requiredOption(parsed, "actor-session-uid"),
        requiredOption(parsed, "actor-session-token"),
        optionalOption(parsed, "reason") ?? null
      );

    case "disconnect":
      return services.sessions.disconnectSession(
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token")
      );

    case "launch-create":
      return services.launchRequests.createLaunchRequest({
        requestedBySessionUid: requiredOption(parsed, "session-uid"),
        sessionToken: requiredOption(parsed, "session-token"),
        provider: optionClientType(parsed, "provider"),
        model: requiredOption(parsed, "model"),
        effortLevel: optionalOption(parsed, "effort-level") ?? null,
        project: requiredOption(parsed, "project"),
        workspacePath: requiredOption(parsed, "workspace-path"),
        role: optionalOption(parsed, "role") ?? null,
        initialInstructions: requiredOption(parsed, "initial-instructions"),
        permissionMode: requiredOption(parsed, "permission-mode"),
        commandPreview: optionalOption(parsed, "command-preview") ?? null,
        requestedCapabilities: parsed.options.get("requested-capability") ?? [],
        approvalPolicyVersion: optionalOption(parsed, "approval-policy-version") ?? null,
        metadata: parseCapabilities(parsed.options.get("metadata") ?? [])
      });

    case "launches":
      return services.launchRequests.listLaunchRequests({
        project: optionalOption(parsed, "project"),
        provider: optionalClientType(parsed, "provider"),
        status: optionalLaunchRequestStatus(parsed, "status"),
        requestedBySessionUid: optionalOption(parsed, "requested-by-session-uid")
      });

    case "launch":
      return services.launchRequests.getLaunchRequest(
        requiredOption(parsed, "launch-request-uid")
      );

    case "launch-detail":
      return services.launchRequests.getLaunchRequestDetail(
        requiredOption(parsed, "launch-request-uid")
      );

    case "launch-actions":
      return services.launchRequests.getLaunchRequestActions(
        requiredOption(parsed, "launch-request-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token")
      );

    case "launch-approve":
      return services.launchRequests.approveLaunchRequest(
        requiredOption(parsed, "launch-request-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        optionalOption(parsed, "detail") ?? null
      );

    case "launch-reject":
      return services.launchRequests.rejectLaunchRequest(
        requiredOption(parsed, "launch-request-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        requiredOption(parsed, "reason")
      );

    case "launch-cancel":
      return services.launchRequests.cancelLaunchRequest(
        requiredOption(parsed, "launch-request-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        requiredOption(parsed, "reason")
      );

    case "launch-mark-launching":
      return services.launchRequests.markLaunchRequestLaunching(
        requiredOption(parsed, "launch-request-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        optionalOption(parsed, "detail") ?? null
      );

    case "launch-mark-running":
      return services.launchRequests.markLaunchRequestRunning(
        requiredOption(parsed, "launch-request-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        requiredOption(parsed, "launched-session-uid"),
        optionalOption(parsed, "detail") ?? null
      );

    case "launch-stop":
      return services.launchRequests.markLaunchRequestStopped(
        requiredOption(parsed, "launch-request-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        optionalOption(parsed, "detail") ?? null,
        optionalNumberOption(parsed, "exit-code") ?? null
      );

    case "launch-fail":
      return services.launchRequests.failLaunchRequest(
        requiredOption(parsed, "launch-request-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        requiredOption(parsed, "reason")
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

    case "handoff-actions":
      return services.handoffs.getHandoffActions(
        requiredOption(parsed, "handoff-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token")
      );

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
        optionProgressHandoffStatus(parsed, "status"),
        requiredOption(parsed, "progress-note")
      );

    case "user-confirmation-request":
      return services.handoffs.requestUserConfirmation(
        requiredOption(parsed, "handoff-uid"),
        requiredOption(parsed, "session-uid"),
        requiredOption(parsed, "session-token"),
        requiredOption(parsed, "question")
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
  const launchRequests = new LaunchRequestService(db, events);
  const sessions = new SessionService(db, events, launchRequests);
  const handoffs = new HandoffService(db, events);
  const discussions = new DiscussionService(db, events);
  const attention = new AttentionService(db, sessions, handoffs, discussions, events, launchRequests);

  return {
    db,
    agents,
    sessions,
    handoffs,
    handoffDetails: new HandoffDetailService(handoffs, events, sessions, discussions),
    launchRequests,
    discussions,
    attention,
    events,
    close: () => db.close()
  };
}

async function watchAttention(
  parsed: ParsedCommand,
  services: Services
): Promise<AttentionWatchResult> {
  const sessionUid = requiredOption(parsed, "session-uid");
  const dbPath = requiredOption(parsed, "db");
  const intervalMs = optionalNumberOption(parsed, "interval-ms") ?? 2000;
  const timeoutMs = optionalNumberOption(parsed, "timeout-ms") ?? 30_000;
  const sinceEventId = optionalNumberOption(parsed, "since-event-id");
  const includeCurrentHandoffs = !parsed.options.has("no-current-handoffs");

  if (intervalMs <= 0) {
    throw new Error("--interval-ms must be greater than 0");
  }

  if (timeoutMs < 0) {
    throw new Error("--timeout-ms must be 0 or greater");
  }

  const startedAt = Date.now();
  let attention = services.attention.getSessionAttention(sessionUid, {
    sinceEventId,
    includeCurrentHandoffs
  });

  while (attention.items.length === 0 && Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    await sleep(Math.min(intervalMs, Math.max(0, remainingMs)));
    attention = services.attention.getSessionAttention(sessionUid, {
      sinceEventId,
      includeCurrentHandoffs
    });
  }

  const elapsedMs = Date.now() - startedAt;
  return {
    timedOut: attention.items.length === 0,
    elapsedMs,
    intervalMs,
    timeoutMs,
    attention,
    recommendedActions: recommendedAttentionActions(attention, dbPath)
  };
}

async function receive(
  parsed: ParsedCommand,
  services: Services
): Promise<unknown> {
  const timeoutSeconds = optionalNumberOption(parsed, "timeout");
  const timeoutMs = optionalNumberOption(parsed, "timeout-ms") ?? (
    timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000
  );
  const options = {
    includeCurrentHandoffs: !parsed.options.has("no-current-handoffs"),
    advanceCursor: !parsed.options.has("no-advance"),
    timeoutMs,
    pollIntervalMs: optionalNumberOption(parsed, "interval-ms")
  };
  const sessionUid = requiredOption(parsed, "session-uid");
  const sessionToken = requiredOptionAlias(parsed, "token", "session-token");

  if (parsed.options.has("wait")) {
    return services.attention.waitForAttention(sessionUid, sessionToken, options);
  }

  return services.attention.receiveOnce(sessionUid, sessionToken, options);
}

async function receiveAttention(
  parsed: ParsedCommand,
  services: Services
): Promise<AttentionReceiveResult> {
  const sessionUid = requiredOption(parsed, "session-uid");
  const sessionToken = requiredOption(parsed, "session-token");
  const intervalMs = optionalNumberOption(parsed, "interval-ms") ?? 2000;
  const timeoutMs = optionalNumberOption(parsed, "timeout-ms") ?? 30_000;

  if (intervalMs <= 0) {
    throw new Error("--interval-ms must be greater than 0");
  }

  if (timeoutMs < 0) {
    throw new Error("--timeout-ms must be 0 or greater");
  }

  let deliveredMessage: string | null = null;
  const adapter: ReceiverAdapter = {
    name: "stdout",
    canDeliver: () => true,
    deliver: async (batch) => {
      deliveredMessage = batch.message;
      return {
        delivered: true,
        message: "Delivered to stdout adapter."
      };
    }
  };
  const receiver = createAttentionReceiver(services, adapter);

  const startedAt = Date.now();
  let attempt: AttentionDeliveryAttempt | null = null;

  while (Date.now() - startedAt <= timeoutMs) {
    attempt = await receiver.deliverOnce(sessionUid, sessionToken);
    if (attempt.status === "delivered") {
      break;
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(intervalMs, remainingMs));
  }

  return {
    timedOut: attempt?.status !== "delivered",
    elapsedMs: Date.now() - startedAt,
    intervalMs,
    timeoutMs,
    attempt,
    deliveredMessage,
    session: services.sessions.getSession(sessionUid)
  };
}

function createAttentionReceiver(
  services: Services,
  adapter: ReceiverAdapter = {
    name: "reader",
    canDeliver: () => false,
    deliver: async () => ({
      delivered: false,
      message: "Reader adapter cannot deliver."
    })
  }
): AttentionReceiverService {
  return new AttentionReceiverService(
    services.db,
    services.sessions,
    services.attention,
    adapter
  );
}

function recommendedAttentionActions(
  attention: SessionAttentionFeed,
  dbPath: string
): RecommendedAttentionAction[] {
  const actions = new Map<string, RecommendedAttentionAction>();

  for (const item of attention.items) {
    const action = recommendedAttentionAction(attention, item, dbPath);
    if (action) {
      actions.set(
        `${action.kind}:${action.handoffUid ?? action.launchRequestUid ?? action.eventId ?? ""}`,
        action
      );
    }
  }

  return Array.from(actions.values());
}

function recommendedAttentionAction(
  attention: SessionAttentionFeed,
  item: SessionAttentionItem,
  dbPath: string
): RecommendedAttentionAction | null {
  if (item.kind === "suggested_handoff" || item.kind === "available_handoff") {
    const handoffUid = item.handoff?.handoffUid;
    if (!handoffUid) {
      return null;
    }

    if (attention.session.status !== "idle") {
      return {
        kind: "defer_claim_until_idle",
        handoffUid,
        reason: `Session is ${attention.session.status}; do not interrupt or auto-claim.`
      };
    }

    return {
      kind: "claim_handoff",
      handoffUid,
      command: `vault-collab claim --db ${dbPath} --handoff-uid ${handoffUid} --session-uid ${attention.session.sessionUid} --session-token <owner-token>`,
      reason: "Session is idle and the handoff is available; inspect detail before claiming."
    };
  }

  if (item.kind === "claimed_handoff" && item.handoff) {
    return {
      kind: "inspect_claimed_handoff",
      handoffUid: item.handoff.handoffUid,
      command: `vault-collab handoff --db ${dbPath} --handoff-uid ${item.handoff.handoffUid}`,
      reason: "Session already owns this handoff; inspect detail and continue, update, resolve, or release."
    };
  }

  if (item.kind === "claimed_by_other_handoff" && item.handoff) {
    return {
      kind: "inspect_claimed_by_other_handoff",
      handoffUid: item.handoff.handoffUid,
      command: `vault-collab handoff --db ${dbPath} --handoff-uid ${item.handoff.handoffUid}`,
      reason:
        "This handoff was suggested to the session, but another session claimed it; inspect detail before coordinating reassignment or follow-up."
    };
  }

  if (item.kind === "handoff_permission" && item.handoff) {
    return {
      kind: "await_user_permission",
      eventId: item.event?.eventId,
      handoffUid: item.handoff.handoffUid,
      command: `vault-collab handoff --db ${dbPath} --handoff-uid ${item.handoff.handoffUid}`,
      reason: "Handoff is awaiting user permission; do not proceed until the user decides."
    };
  }

  if (item.kind === "session_permission") {
    return {
      kind: "await_user_permission",
      eventId: item.event?.eventId,
      reason: "Session is awaiting user permission; do not proceed until the user decides."
    };
  }

  if (item.kind === "session_ping") {
    return {
      kind: "inspect_ping",
      eventId: item.event?.eventId,
      reason: "Soft ping noticed by watcher; inspect the attention payload before deciding what to do."
    };
  }

  if (item.kind === "discussion_message") {
    const threadUid = item.event?.payload.threadUid;
    return {
      kind: "read_discussion",
      eventId: item.event?.eventId,
      handoffUid: item.handoff?.handoffUid,
      command:
        typeof threadUid === "string"
          ? `vault-collab discussion --db ${dbPath} --thread-uid ${threadUid}`
          : undefined,
      reason: "A relevant handoff discussion has a new message; read the thread before continuing."
    };
  }

  if (item.kind === "launch_request" && item.launchRequest) {
    return {
      kind: "inspect_launch_request",
      launchRequestUid: item.launchRequest.launchRequestUid,
      command: `vault-collab launch-detail --db ${dbPath} --launch-request-uid ${item.launchRequest.launchRequestUid}`,
      reason: "A project launch request needs operator attention; inspect approval state before acting."
    };
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      if (command === "receive" && !options.has("session-uid")) {
        options.set("session-uid", [token]);
        continue;
      }

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

function requiredOptionAlias(
  parsed: ParsedCommand,
  primaryName: string,
  fallbackName: string
): string {
  return optionalOption(parsed, primaryName) ?? requiredOption(parsed, fallbackName);
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

function requiredNumberOption(parsed: ParsedCommand, name: string): number {
  const value = optionalNumberOption(parsed, name);
  if (value === undefined) {
    throw new Error(`Missing required option --${name}`);
  }

  return value;
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

function optionProgressHandoffStatus(parsed: ParsedCommand, name: string): HandoffStatus {
  const value = requiredOption(parsed, name);
  if (!progressHandoffStatuses.includes(value as (typeof progressHandoffStatuses)[number])) {
    throw new Error(
      `Invalid handoff progress status: ${value}. Use a dedicated lifecycle method for available, claimed, resolved, abandoned, or stale.`
    );
  }

  return value as HandoffStatus;
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

function optionalLaunchRequestStatus(
  parsed: ParsedCommand,
  name: string
): LaunchRequestStatus | undefined {
  const value = optionalOption(parsed, name);
  return value ? parseLaunchRequestStatus(value) : undefined;
}

function parseLaunchRequestStatus(value: string): LaunchRequestStatus {
  if (!launchRequestStatuses.includes(value as (typeof launchRequestStatuses)[number])) {
    throw new Error(`Invalid launch request status: ${value}`);
  }

  return value as LaunchRequestStatus;
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

function optionalSessionDeliveryMode(
  parsed: ParsedCommand,
  name: string
): SessionDeliveryMode | undefined {
  const value = optionalOption(parsed, name);
  if (!value) {
    return undefined;
  }

  const allowed: SessionDeliveryMode[] = [
    "manual_poll",
    "local_watch",
    "mcp_notification",
    "managed_process"
  ];
  if (!allowed.includes(value as SessionDeliveryMode)) {
    throw new Error(`Invalid session delivery mode: ${value}`);
  }

  return value as SessionDeliveryMode;
}

function optionalAttentionDeliveryAttemptStatus(
  parsed: ParsedCommand,
  name: string
): AttentionDeliveryAttemptStatus | undefined {
  const value = optionalOption(parsed, name);
  if (!value) {
    return undefined;
  }

  const allowed: AttentionDeliveryAttemptStatus[] = ["delivered", "failed"];
  if (!allowed.includes(value as AttentionDeliveryAttemptStatus)) {
    throw new Error(`Invalid attention delivery attempt status: ${value}`);
  }

  return value as AttentionDeliveryAttemptStatus;
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
