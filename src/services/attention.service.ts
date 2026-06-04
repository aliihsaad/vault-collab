import type { CollabDatabase } from "../database/connection.js";
import type { DiscussionService } from "./discussion.service.js";
import type { EventService } from "./event.service.js";
import type { HandoffService } from "./handoff.service.js";
import type { LaunchRequestService } from "./launch-request.service.js";
import type { PolicyEngine } from "./policy-engine.service.js";
import type { SessionService } from "./session.service.js";
import { getEventTypeDefinition } from "../event-registry.js";
import { projectKey } from "../project-key.js";
import type {
  EventRecord,
  HandoffRecord,
  LaunchRequestRecord,
  ReceiveOptions,
  ReceiveResult,
  SessionAttentionFeed,
  SessionAttentionItem,
  SessionAttentionOptions,
  WaitForAttentionOptions
} from "../types.js";

const closedHandoffStatuses = new Set(["resolved", "abandoned", "stale"]);

export class AttentionService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly sessions: SessionService,
    private readonly handoffs: HandoffService,
    private readonly discussions: DiscussionService,
    private readonly events: EventService,
    private readonly launchRequests?: LaunchRequestService,
    private readonly policyEngine?: PolicyEngine
  ) {
    void this.db;
    void this.discussions;
  }

  getSessionAttention(
    sessionUid: string,
    options: SessionAttentionOptions = {}
  ): SessionAttentionFeed {
    const session = this.sessions.getSession(sessionUid);
    if (!session) {
      throw new Error(`Session not found: ${sessionUid}`);
    }

    const sinceEventId = options.sinceEventId ?? 0;
    const allEvents = this.events.listEvents();
    const latestEventId = this.latestCursorEventId(allEvents, sinceEventId);
    const openHandoffs = this.handoffs
      .listInbox({
        includeResolved: false
      })
      .filter((handoff) => !closedHandoffStatuses.has(handoff.status));
    const projectHandoffs = this.handoffs
      .listInbox({
        targetProject: session.project,
        includeResolved: false
      })
      .filter((handoff) => !closedHandoffStatuses.has(handoff.status));
    const projectHandoffUids = new Set(
      projectHandoffs.map((handoff) => handoff.handoffUid)
    );
    const currentHandoffs = this.uniqueHandoffs(
      projectHandoffs,
      openHandoffs.filter((handoff) => this.isSessionLinkedHandoff(handoff, sessionUid))
    );
    const relevantHandoffUids = new Set(
      currentHandoffs.map((handoff) => handoff.handoffUid)
    );
    const handoffsByUid = new Map(
      currentHandoffs.map((handoff) => [handoff.handoffUid, handoff] as const)
    );
    const projectLaunchRequests = this.launchRequests
      ? this.launchRequests.listLaunchRequests({ project: session.project })
      : [];
    const launchRequestsByUid = new Map(
      projectLaunchRequests.map((launchRequest) => [
        launchRequest.launchRequestUid,
        launchRequest
      ] as const)
    );
    const items: SessionAttentionItem[] = [];

    for (const event of allEvents) {
      if (event.eventId <= sinceEventId) {
        continue;
      }

      const eventItem = this.mapEventToAttentionItem(
        event,
        session,
        sessionUid,
        relevantHandoffUids,
        handoffsByUid,
        launchRequestsByUid
      );
      if (eventItem) {
        items.push(eventItem);
      }
    }

    for (const launchRequest of projectLaunchRequests) {
      if (["requested", "approved", "launching"].includes(launchRequest.status)) {
        items.push(this.launchRequestItem("launch_request", null, launchRequest));
      }
    }

    if (options.includeCurrentHandoffs !== false) {
      for (const handoff of currentHandoffs) {
        if (handoff.claimedBySessionUid === sessionUid) {
          items.push(this.handoffItem("claimed_handoff", handoff));
        } else if (handoff.suggestedSessionUid === sessionUid) {
          items.push(
            this.handoffItem(
              handoff.claimedBySessionUid ? "claimed_by_other_handoff" : "suggested_handoff",
              handoff
            )
          );
        } else if (
          handoff.status === "available" &&
          projectHandoffUids.has(handoff.handoffUid)
        ) {
          items.push(this.handoffItem("available_handoff", handoff));
        }
      }
    }

    const dedupedItems = this.dedupeLaunchRequestItems(items);

    dedupedItems.sort((left, right) => {
      const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
      if (byCreatedAt !== 0) {
        return byCreatedAt;
      }

      return this.kindOrder(left.kind) - this.kindOrder(right.kind);
    });

    return {
      session,
      sinceEventId,
      latestEventId,
      items: dedupedItems
    };
  }

  private mapEventToAttentionItem(
    event: EventRecord,
    session: SessionAttentionFeed["session"],
    sessionUid: string,
    relevantHandoffUids: Set<string>,
    handoffsByUid: Map<string, HandoffRecord>,
    launchRequestsByUid: Map<string, LaunchRequestRecord>
  ): SessionAttentionItem | null {
    if (event.eventType === "session.pinged" && event.sessionUid === sessionUid) {
      return this.eventItem("session_ping", event, null);
    }

    if (event.eventType === "session.permission_requested" && event.sessionUid === sessionUid) {
      return this.eventItem("session_permission", event, null);
    }

    if (event.eventType === "handoff.permission_requested" && event.sessionUid === sessionUid) {
      return this.eventItem(
        "handoff_permission",
        event,
        event.handoffUid ? handoffsByUid.get(event.handoffUid) ?? null : null
      );
    }

    if (event.eventType.startsWith("launch_request.")) {
      const launchRequestUid = event.payload.launchRequestUid;
      if (typeof launchRequestUid === "string") {
        const launchRequest = launchRequestsByUid.get(launchRequestUid);
        if (launchRequest) {
          return this.launchRequestItem("launch_request", event, launchRequest);
        }
      }
    }

    if (
      event.eventType === "discussion.message_added" &&
      event.sessionUid !== sessionUid &&
      event.handoffUid &&
      relevantHandoffUids.has(event.handoffUid)
    ) {
      return this.eventItem(
        "discussion_message",
        event,
        handoffsByUid.get(event.handoffUid) ?? null
      );
    }

    const registryItem = this.mapRegistryEventToAttentionItem(event, session, handoffsByUid);
    if (registryItem) {
      return registryItem;
    }

    return null;
  }

  private mapRegistryEventToAttentionItem(
    event: EventRecord,
    session: SessionAttentionFeed["session"],
    handoffsByUid: Map<string, HandoffRecord>
  ): SessionAttentionItem | null {
    const definition = getEventTypeDefinition(event.eventType);
    const attention = definition?.attention;
    if (!attention || attention.itemKind === null) {
      return null;
    }

    if (attention.scope === "project_role") {
      if (
        !session.roleProfileId ||
        !attention.roleProfileIds.some((roleProfileId) => roleProfileId === session.roleProfileId)
      ) {
        return null;
      }

      if (!this.eventMatchesSessionProject(event, session, handoffsByUid)) {
        return null;
      }

      if (!this.policyAllowsAttentionRoute(event, session, attention.itemKind)) {
        return null;
      }

      return this.eventItem(
        attention.itemKind,
        event,
        event.handoffUid ? handoffsByUid.get(event.handoffUid) ?? null : null
      );
    }

    return null;
  }

  private policyAllowsAttentionRoute(
    event: EventRecord,
    session: SessionAttentionFeed["session"],
    itemKind: SessionAttentionItem["kind"]
  ): boolean {
    if (!this.policyEngine) {
      return true;
    }

    const decision = this.policyEngine.evaluate({
      actionType: "attention.route",
      dryRun: true,
      payload: {
        eventId: event.eventId,
        eventType: event.eventType,
        itemKind,
        targetSessionUid: session.sessionUid,
        targetRoleProfileId: session.roleProfileId,
        project: typeof event.payload.project === "string" ? event.payload.project : session.project
      }
    });

    return decision.allowed;
  }

  private eventItem(
    kind: SessionAttentionItem["kind"],
    event: EventRecord,
    handoff: HandoffRecord | null
  ): SessionAttentionItem {
    return {
      kind,
      event,
      handoff,
      launchRequest: null,
      createdAt: event.createdAt
    };
  }

  private handoffItem(
    kind: SessionAttentionItem["kind"],
    handoff: HandoffRecord
  ): SessionAttentionItem {
    return {
      kind,
      event: null,
      handoff,
      launchRequest: null,
      createdAt: handoff.updatedAt
    };
  }

  private launchRequestItem(
    kind: SessionAttentionItem["kind"],
    event: EventRecord | null,
    launchRequest: LaunchRequestRecord
  ): SessionAttentionItem {
    return {
      kind,
      event,
      handoff: null,
      launchRequest,
      createdAt: event?.createdAt ?? launchRequest.updatedAt
    };
  }

  private isSessionLinkedHandoff(handoff: HandoffRecord, sessionUid: string): boolean {
    return (
      handoff.sourceSessionUid === sessionUid ||
      handoff.suggestedSessionUid === sessionUid ||
      handoff.claimedBySessionUid === sessionUid
    );
  }

  private uniqueHandoffs(...groups: HandoffRecord[][]): HandoffRecord[] {
    const unique = new Map<string, HandoffRecord>();
    for (const group of groups) {
      for (const handoff of group) {
        unique.set(handoff.handoffUid, handoff);
      }
    }

    return Array.from(unique.values());
  }

  private dedupeLaunchRequestItems(
    items: SessionAttentionItem[]
  ): SessionAttentionItem[] {
    const nonLaunchItems: SessionAttentionItem[] = [];
    const launchItemsByUid = new Map<string, SessionAttentionItem>();

    for (const item of items) {
      if (item.kind !== "launch_request" || !item.launchRequest) {
        nonLaunchItems.push(item);
        continue;
      }

      const uid = item.launchRequest.launchRequestUid;
      const existing = launchItemsByUid.get(uid);
      if (!existing || this.isNewerLaunchRequestItem(existing, item)) {
        launchItemsByUid.set(uid, item);
      }
    }

    return [...nonLaunchItems, ...launchItemsByUid.values()];
  }

  private isNewerLaunchRequestItem(
    existing: SessionAttentionItem,
    candidate: SessionAttentionItem
  ): boolean {
    const byCreatedAt = candidate.createdAt.localeCompare(existing.createdAt);
    if (byCreatedAt !== 0) {
      return byCreatedAt > 0;
    }

    return Boolean(candidate.event && !existing.event);
  }

  private kindOrder(kind: SessionAttentionItem["kind"]): number {
    return [
      "session_permission",
      "handoff_permission",
      "policy_notice",
      "security_finding",
      "context_warning",
      "cost_warning",
      "risk_critical",
      "loop_stall",
      "tool_failure",
      "launch_request",
      "session_ping",
      "discussion_message",
      "claimed_handoff",
      "claimed_by_other_handoff",
      "suggested_handoff",
      "available_handoff"
    ].indexOf(kind);
  }

  receiveOnce(
    sessionUid: string,
    sessionToken: string,
    options: ReceiveOptions = {}
  ): ReceiveResult {
    const session = this.sessions.getOwnedSession(sessionUid, sessionToken);
    const fromEventId = this.sessions.getAttentionCursor(sessionUid);
    const feed = this.getSessionAttention(sessionUid, {
      sinceEventId: fromEventId,
      includeCurrentHandoffs: options.includeCurrentHandoffs
    });
    const items = this.receiveItems(feed, fromEventId);
    const result: ReceiveResult = {
      session: feed.session,
      fromEventId,
      toEventId: feed.latestEventId,
      items,
      drained: true
    };

    if (options.advanceCursor !== false && items.length > 0) {
      result.session = this.sessions.acknowledgeAttention(
        sessionUid,
        sessionToken,
        feed.latestEventId
      );
    }

    return result;
  }

  async waitForAttention(
    sessionUid: string,
    sessionToken: string,
    options: WaitForAttentionOptions = {}
  ): Promise<ReceiveResult> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;

    if (timeoutMs < 0) {
      throw new Error("timeoutMs must be 0 or greater");
    }

    if (pollIntervalMs <= 0) {
      throw new Error("pollIntervalMs must be greater than 0");
    }

    const startedAt = Date.now();
    let result = this.receiveOnce(sessionUid, sessionToken, options);

    while (result.items.length === 0 && Date.now() - startedAt < timeoutMs) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      await this.sleep(Math.min(pollIntervalMs, Math.max(0, remainingMs)));
      result = this.receiveOnce(sessionUid, sessionToken, options);
    }

    return result;
  }

  private receiveItems(
    feed: SessionAttentionFeed,
    fromEventId: number
  ): SessionAttentionItem[] {
    if (feed.latestEventId <= fromEventId) {
      return feed.items.filter((item) => item.event !== null);
    }

    return feed.items;
  }

  private latestCursorEventId(events: EventRecord[], fallback: number): number {
    return events.reduce((latest, event) => {
      if (this.isAuditOnlyEvent(event)) {
        return latest;
      }

      return Math.max(latest, event.eventId);
    }, fallback);
  }

  private isAuditOnlyEvent(event: EventRecord): boolean {
    const definition = getEventTypeDefinition(event.eventType);
    if (definition?.attention?.itemKind) {
      return false;
    }

    return event.eventType.startsWith("tool.call_");
  }

  private eventMatchesSessionProject(
    event: EventRecord,
    session: SessionAttentionFeed["session"],
    handoffsByUid: Map<string, HandoffRecord>
  ): boolean {
    const eventProject = event.payload.project;
    if (typeof eventProject === "string" && projectKey(eventProject) === projectKey(session.project)) {
      return true;
    }

    if (event.handoffUid) {
      const handoff = handoffsByUid.get(event.handoffUid);
      if (!handoff) {
        return false;
      }

      return (
        projectKey(handoff.targetProject) === projectKey(session.project) ||
        projectKey(handoff.sourceProject) === projectKey(session.project)
      );
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
