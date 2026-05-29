import type { DiscussionService } from "./discussion.service.js";
import type { EventService } from "./event.service.js";
import type { HandoffService } from "./handoff.service.js";
import type { SessionService } from "./session.service.js";
import type { HandoffDetail, SessionSnapshot } from "../types.js";

export class HandoffDetailService {
  constructor(
    private readonly handoffs: HandoffService,
    private readonly events: EventService,
    private readonly sessions: SessionService,
    private readonly discussions?: DiscussionService
  ) {}

  getHandoffDetail(handoffUid: string): HandoffDetail | null {
    const handoff = this.handoffs.getHandoff(handoffUid);
    if (!handoff) {
      return null;
    }

    return {
      handoff,
      events: this.events.listEvents({ handoffUid }),
      discussionThreads: this.discussions?.listThreads({ handoffUid }) ?? [],
      sessions: {
        sourceSession: this.findSession(handoff.sourceSessionUid),
        suggestedSession: this.findSession(handoff.suggestedSessionUid),
        claimedBySession: this.findSession(handoff.claimedBySessionUid)
      }
    };
  }

  private findSession(sessionUid: string | null): SessionSnapshot | null {
    return sessionUid ? this.sessions.getSession(sessionUid) : null;
  }
}
