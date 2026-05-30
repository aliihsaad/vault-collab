import type { JsonRecord } from "./types.js";

export interface AgentNextAction {
  tool: string;
  args: JsonRecord;
  reason: string;
}

export function attentionNextAction(sessionUid: string): AgentNextAction {
  return {
    tool: "vault_collab_get_session_attention",
    args: {
      sessionUid,
      includeCurrentHandoffs: true
    },
    reason:
      "Discover pings, permission requests, suggested handoffs, claimed work, and available project handoffs for this active session."
  };
}

export function withAttentionNextAction<T extends { sessionUid: string }>(
  session: T
): T & { nextActions: AgentNextAction[] } {
  return {
    ...session,
    nextActions: [attentionNextAction(session.sessionUid)]
  };
}
