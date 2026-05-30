import type { CollabDatabase } from "../database/connection.js";
import type { DiscussionService } from "./discussion.service.js";
import type { EventService } from "./event.service.js";
import type { HandoffService } from "./handoff.service.js";
import type { LaunchRequestService } from "./launch-request.service.js";
import type { SessionService } from "./session.service.js";
import type {
  EventRecord,
  HandoffRecord,
  LaunchRequestRecord,
  SessionAttentionFeed,
  SessionAttentionItem,
  SessionAttentionOptions
} from "../types.js";

const closedHandoffStatuses = new Set(["resolved", "abandoned", "stale"]);

export class AttentionService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly sessions: SessionService,
    private readonly handoffs: HandoffService,
    private readonly discussions: DiscussionService,
    private readonly events: EventService,
    private readonly launchRequests?: LaunchRequestService
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
    const latestEventId = allEvents.reduce(
      (latest, event) => Math.max(latest, event.eventId),
      sinceEventId
    );
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

    return null;
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
      "launch_request",
      "session_ping",
      "discussion_message",
      "claimed_handoff",
      "claimed_by_other_handoff",
      "suggested_handoff",
      "available_handoff"
    ].indexOf(kind);
  }
}
