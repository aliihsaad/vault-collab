import type { CollabDatabase } from "../database/connection.js";
import type { DiscussionService } from "./discussion.service.js";
import type { EventService } from "./event.service.js";
import type { HandoffService } from "./handoff.service.js";
import type { SessionService } from "./session.service.js";
import type {
  EventRecord,
  HandoffRecord,
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
    private readonly events: EventService
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
    const currentHandoffs = this.handoffs
      .listInbox({
        targetProject: session.project,
        includeResolved: false
      })
      .filter((handoff) => !closedHandoffStatuses.has(handoff.status));
    const relevantHandoffUids = new Set(
      currentHandoffs
        .filter(
          (handoff) =>
            handoff.targetProject === session.project ||
            handoff.sourceSessionUid === sessionUid ||
            handoff.suggestedSessionUid === sessionUid ||
            handoff.claimedBySessionUid === sessionUid
        )
        .map((handoff) => handoff.handoffUid)
    );
    const handoffsByUid = new Map(
      currentHandoffs.map((handoff) => [handoff.handoffUid, handoff] as const)
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
        handoffsByUid
      );
      if (eventItem) {
        items.push(eventItem);
      }
    }

    if (options.includeCurrentHandoffs !== false) {
      for (const handoff of currentHandoffs) {
        if (handoff.claimedBySessionUid === sessionUid) {
          items.push(this.handoffItem("claimed_handoff", handoff));
        } else if (handoff.suggestedSessionUid === sessionUid) {
          items.push(this.handoffItem("suggested_handoff", handoff));
        } else if (handoff.status === "available") {
          items.push(this.handoffItem("available_handoff", handoff));
        }
      }
    }

    items.sort((left, right) => {
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
      items
    };
  }

  private mapEventToAttentionItem(
    event: EventRecord,
    sessionUid: string,
    relevantHandoffUids: Set<string>,
    handoffsByUid: Map<string, HandoffRecord>
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
      createdAt: handoff.updatedAt
    };
  }

  private kindOrder(kind: SessionAttentionItem["kind"]): number {
    return [
      "session_permission",
      "handoff_permission",
      "session_ping",
      "discussion_message",
      "claimed_handoff",
      "suggested_handoff",
      "available_handoff"
    ].indexOf(kind);
  }
}
