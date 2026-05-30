import { randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import type { EventService } from "./event.service.js";
import type {
  AddDiscussionMessageInput,
  CreateHandoffDiscussionThreadInput,
  CreateDiscussionThreadInput,
  DiscussionMessage,
  DiscussionMessageType,
  DiscussionThreadDetail,
  DiscussionThreadFilters,
  DiscussionThreadStatus,
  DiscussionThreadSummary,
  JsonRecord
} from "../types.js";

interface SessionOwnerRow {
  session_uid: string;
  session_token: string;
  agent_uid: string | null;
}

interface DiscussionThreadRow {
  thread_uid: string;
  handoff_uid: string | null;
  project: string;
  title: string;
  status: DiscussionThreadStatus;
  created_by_session_uid: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  message_count: number;
  last_message_at: string | null;
}

interface DiscussionMessageRow {
  message_uid: string;
  thread_uid: string;
  session_uid: string | null;
  agent_uid: string | null;
  message_type: DiscussionMessageType;
  body: string;
  metadata_json: string;
  created_at: string;
}

export class DiscussionService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly events: EventService,
    private readonly clock: () => Date = () => new Date()
  ) {}

  createThread(input: CreateDiscussionThreadInput): DiscussionThreadSummary {
    this.assertSessionOwner(input.createdBySessionUid, input.sessionToken);
    const title = input.title.trim();
    if (!title) {
      throw new Error("Discussion thread title cannot be empty");
    }

    if (input.handoffUid) {
      const targetProject = this.requireHandoffTargetProject(input.handoffUid);

      if (targetProject !== input.project) {
        throw new Error("Discussion project must match handoff target project");
      }
    }

    const now = this.now();
    const threadUid = `vc_thread_${randomUUID()}`;

    this.db
      .prepare(
        `
        INSERT INTO discussion_threads (
          thread_uid,
          handoff_uid,
          project,
          title,
          status,
          created_by_session_uid,
          created_at,
          updated_at,
          resolved_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        threadUid,
        input.handoffUid ?? null,
        input.project,
        title,
        "open",
        input.createdBySessionUid,
        now,
        now,
        null
      );

    this.events.recordEvent({
      eventType: "discussion.thread_created",
      handoffUid: input.handoffUid ?? null,
      sessionUid: input.createdBySessionUid,
      payload: {
        threadUid,
        project: input.project,
        title
      }
    });

    return this.requireThreadSummary(threadUid);
  }

  createHandoffThread(input: CreateHandoffDiscussionThreadInput): DiscussionThreadSummary {
    const project = this.requireHandoffTargetProject(input.handoffUid);
    return this.createThread({
      project,
      handoffUid: input.handoffUid,
      title: input.title,
      createdBySessionUid: input.createdBySessionUid,
      sessionToken: input.sessionToken
    });
  }

  addMessage(
    threadUid: string,
    sessionUid: string,
    sessionToken: string,
    input: AddDiscussionMessageInput
  ): DiscussionMessage {
    const session = this.assertSessionOwner(sessionUid, sessionToken);
    const thread = this.findThreadSummary(threadUid);
    if (!thread) {
      throw new Error(`Discussion thread not found: ${threadUid}`);
    }
    const body = input.body.trim();
    if (!body) {
      throw new Error("Discussion message body cannot be empty");
    }

    const now = this.now();
    const messageUid = `vc_msg_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO discussion_messages (
          message_uid,
          thread_uid,
          session_uid,
          agent_uid,
          message_type,
          body,
          metadata_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        messageUid,
        threadUid,
        sessionUid,
        session.agent_uid,
        input.messageType,
        body,
        JSON.stringify(input.metadata ?? {}),
        now
      );

    this.db
      .prepare(
        `
        UPDATE discussion_threads
        SET updated_at = ?
        WHERE thread_uid = ?
      `
      )
      .run(now, threadUid);

    this.events.recordEvent({
      eventType: "discussion.message_added",
      handoffUid: thread.handoffUid,
      sessionUid,
      payload: {
        threadUid,
        messageUid,
        messageType: input.messageType
      }
    });

    return this.requireMessage(messageUid);
  }

  listThreads(filter: DiscussionThreadFilters = {}): DiscussionThreadSummary[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.project) {
      clauses.push("discussion_threads.project = ?");
      params.push(filter.project);
    }

    if (filter.handoffUid) {
      clauses.push("discussion_threads.handoff_uid = ?");
      params.push(filter.handoffUid);
    }

    if (filter.status) {
      clauses.push("discussion_threads.status = ?");
      params.push(filter.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
        ${this.threadSummarySelect()}
        FROM discussion_threads
        LEFT JOIN discussion_messages
          ON discussion_messages.thread_uid = discussion_threads.thread_uid
        ${where}
        GROUP BY discussion_threads.thread_uid
        ORDER BY discussion_threads.created_at ASC, discussion_threads.thread_uid ASC
      `
      )
      .all(...params) as DiscussionThreadRow[];

    return rows.map((row) => this.mapThreadRow(row));
  }

  getThread(threadUid: string): DiscussionThreadDetail | null {
    const summary = this.findThreadSummary(threadUid);
    if (!summary) {
      return null;
    }

    return {
      ...summary,
      messages: this.listMessages(threadUid)
    };
  }

  private listMessages(threadUid: string): DiscussionMessage[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM discussion_messages
        WHERE thread_uid = ?
        ORDER BY created_at ASC, rowid ASC
      `
      )
      .all(threadUid) as DiscussionMessageRow[];

    return rows.map((row) => this.mapMessageRow(row));
  }

  private requireThreadSummary(threadUid: string): DiscussionThreadSummary {
    const thread = this.findThreadSummary(threadUid);
    if (!thread) {
      throw new Error(`Discussion thread not found: ${threadUid}`);
    }

    return thread;
  }

  private requireHandoffTargetProject(handoffUid: string): string {
    const handoff = this.db
      .prepare("SELECT target_project FROM handoffs WHERE handoff_uid = ?")
      .get(handoffUid) as { target_project: string } | undefined;
    if (!handoff) {
      throw new Error(`Handoff not found: ${handoffUid}`);
    }

    return handoff.target_project;
  }

  private findThreadSummary(threadUid: string): DiscussionThreadSummary | null {
    const row = this.db
      .prepare(
        `
        ${this.threadSummarySelect()}
        FROM discussion_threads
        LEFT JOIN discussion_messages
          ON discussion_messages.thread_uid = discussion_threads.thread_uid
        WHERE discussion_threads.thread_uid = ?
        GROUP BY discussion_threads.thread_uid
      `
      )
      .get(threadUid) as DiscussionThreadRow | undefined;

    return row ? this.mapThreadRow(row) : null;
  }

  private requireMessage(messageUid: string): DiscussionMessage {
    const row = this.db
      .prepare("SELECT * FROM discussion_messages WHERE message_uid = ?")
      .get(messageUid) as DiscussionMessageRow | undefined;
    if (!row) {
      throw new Error(`Discussion message not found: ${messageUid}`);
    }

    return this.mapMessageRow(row);
  }

  private assertSessionOwner(sessionUid: string, sessionToken: string): SessionOwnerRow {
    const row = this.db
      .prepare("SELECT session_uid, session_token, agent_uid FROM sessions WHERE session_uid = ?")
      .get(sessionUid) as SessionOwnerRow | undefined;

    if (!row) {
      throw new Error(`Session not found: ${sessionUid}`);
    }

    if (row.session_token !== sessionToken) {
      throw new Error("Invalid session token");
    }

    return row;
  }

  private threadSummarySelect(): string {
    return `
        SELECT
          discussion_threads.thread_uid,
          discussion_threads.handoff_uid,
          discussion_threads.project,
          discussion_threads.title,
          discussion_threads.status,
          discussion_threads.created_by_session_uid,
          discussion_threads.created_at,
          discussion_threads.updated_at,
          discussion_threads.resolved_at,
          COUNT(discussion_messages.message_uid) AS message_count,
          MAX(discussion_messages.created_at) AS last_message_at
    `;
  }

  private mapThreadRow(row: DiscussionThreadRow): DiscussionThreadSummary {
    return {
      threadUid: row.thread_uid,
      handoffUid: row.handoff_uid,
      project: row.project,
      title: row.title,
      status: row.status,
      createdBySessionUid: row.created_by_session_uid,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      messageCount: Number(row.message_count),
      lastMessageAt: row.last_message_at
    };
  }

  private mapMessageRow(row: DiscussionMessageRow): DiscussionMessage {
    return {
      messageUid: row.message_uid,
      threadUid: row.thread_uid,
      sessionUid: row.session_uid,
      agentUid: row.agent_uid,
      messageType: row.message_type,
      body: row.body,
      metadata: JSON.parse(row.metadata_json) as JsonRecord,
      createdAt: row.created_at
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
