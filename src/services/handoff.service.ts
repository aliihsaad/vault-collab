import { randomBytes, randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import type { EventService } from "./event.service.js";
import type {
  ClientType,
  HandoffFilters,
  HandoffPriority,
  HandoffRecord,
  HandoffStatus,
  PublishHandoffInput,
  RecoverHandoffInput,
  UpdateHandoffMetadataInput
} from "../types.js";

interface HandoffRow {
  handoff_uid: string;
  vault_memory_uid: string | null;
  short_prompt: string;
  source_project: string;
  target_project: string;
  related_projects_json: string;
  related_files_json: string;
  source_session_uid: string | null;
  suggested_session_uid: string | null;
  suggested_client_type: ClientType | null;
  queue_key: string;
  labels_json: string;
  queue_position: number | null;
  depends_on_handoff_uid: string | null;
  status: HandoffStatus;
  priority: HandoffPriority;
  urgent: 0 | 1;
  claimed_by_session_uid: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  progress_note: string | null;
  resolution_summary: string | null;
  reopen_reason: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  stale_at: string | null;
}

interface SessionOwnerRow {
  session_uid: string;
  session_token: string;
  capabilities_json: string;
}

const closedInboxStatuses: HandoffStatus[] = ["resolved", "abandoned", "stale"];

export class HandoffService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly events: EventService,
    private readonly clock: () => Date = () => new Date()
  ) {}

  publishHandoff(input: PublishHandoffInput): HandoffRecord {
    const now = this.now();
    const handoffUid = `vc_handoff_${randomUUID()}`;
    const priority = input.priority ?? "normal";
    const urgent = input.urgent ?? priority === "urgent";
    const queueKey = input.queueKey ?? "default";
    const queuePosition =
      input.queuePosition ?? this.nextQueuePosition(input.targetProject, queueKey);

    this.db
      .prepare(
        `
        INSERT INTO handoffs (
          handoff_uid,
          vault_memory_uid,
          short_prompt,
          source_project,
          target_project,
          related_projects_json,
          related_files_json,
          source_session_uid,
          suggested_session_uid,
          suggested_client_type,
          queue_key,
          labels_json,
          queue_position,
          depends_on_handoff_uid,
          status,
          priority,
          urgent,
          claimed_by_session_uid,
          claim_token,
          lease_expires_at,
          progress_note,
          resolution_summary,
          reopen_reason,
          created_at,
          updated_at,
          resolved_at,
          stale_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        handoffUid,
        input.vaultMemoryUid ?? null,
        input.shortPrompt,
        input.sourceProject,
        input.targetProject,
        JSON.stringify(input.relatedProjects ?? []),
        JSON.stringify(input.relatedFiles ?? []),
        input.sourceSessionUid ?? null,
        input.suggestedSessionUid ?? null,
        input.suggestedClientType ?? null,
        queueKey,
        JSON.stringify(input.labels ?? []),
        queuePosition,
        input.dependsOnHandoffUid ?? null,
        "available",
        priority,
        urgent ? 1 : 0,
        null,
        null,
        null,
        null,
        null,
        null,
        now,
        now,
        null,
        null
      );

    this.events.recordEvent({
      eventType: "handoff.published",
      handoffUid,
      sessionUid: input.sourceSessionUid ?? null,
      payload: {
        sourceProject: input.sourceProject,
        targetProject: input.targetProject,
        priority,
        urgent
      }
      });

    return this.requireHandoff(handoffUid);
  }

  listInbox(filter: HandoffFilters = {}): HandoffRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.sourceProject) {
      clauses.push("source_project = ?");
      params.push(filter.sourceProject);
    }

    if (filter.targetProject) {
      clauses.push("target_project = ?");
      params.push(filter.targetProject);
    }

    if (filter.queueKey) {
      clauses.push("queue_key = ?");
      params.push(filter.queueKey);
    }

    if (filter.label) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(labels_json) WHERE value = ?)");
      params.push(filter.label);
    }

    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    } else if (!filter.includeResolved) {
      clauses.push(
        `status NOT IN (${closedInboxStatuses.map(() => "?").join(", ")})`
      );
      params.push(...closedInboxStatuses);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM handoffs
        ${where}
        ORDER BY urgent DESC,
                 queue_key ASC,
                 CASE WHEN queue_position IS NULL THEN 1 ELSE 0 END ASC,
                 queue_position ASC,
                 created_at ASC,
                 handoff_uid ASC
      `
      )
      .all(...params) as HandoffRow[];

    return rows.map((row) => this.mapRow(row));
  }

  getHandoff(handoffUid: string): HandoffRecord | null {
    const row = this.findHandoffRow(handoffUid);
    return row ? this.mapRow(row) : null;
  }

  linkVaultMemory(
    handoffUid: string,
    vaultMemoryUid: string,
    sessionUid: string | null = null
  ): HandoffRecord {
    const now = this.now();
    const result = this.db
      .prepare(
        `
        UPDATE handoffs
        SET vault_memory_uid = ?, updated_at = ?
        WHERE handoff_uid = ?
      `
      )
      .run(vaultMemoryUid, now, handoffUid);

    if (result.changes !== 1) {
      throw new Error(`Handoff not found: ${handoffUid}`);
    }

    this.events.recordEvent({
      eventType: "handoff.vault_memory_linked",
      handoffUid,
      sessionUid,
      payload: {
        vaultMemoryUid
      }
    });

    return this.requireHandoff(handoffUid);
  }

  updateHandoffMetadata(
    handoffUid: string,
    sessionUid: string,
    sessionToken: string,
    metadata: UpdateHandoffMetadataInput
  ): HandoffRecord {
    this.assertSessionOwner(sessionUid, sessionToken);
    const handoff = this.findHandoffRow(handoffUid);
    if (!handoff) {
      throw new Error(`Handoff not found: ${handoffUid}`);
    }

    const isSourceOwner = handoff.source_session_uid === sessionUid;
    const isClaimOwner = handoff.claimed_by_session_uid === sessionUid;
    if (!isSourceOwner && !isClaimOwner) {
      throw new Error("Handoff metadata can only be updated by source session or claimed session");
    }

    const now = this.now();
    this.db
      .prepare(
        `
        UPDATE handoffs
        SET queue_key = ?,
            labels_json = ?,
            queue_position = ?,
            depends_on_handoff_uid = ?,
            updated_at = ?
        WHERE handoff_uid = ?
      `
      )
      .run(
        metadata.queueKey ?? handoff.queue_key,
        JSON.stringify(metadata.labels ?? (JSON.parse(handoff.labels_json) as string[])),
        metadata.queuePosition === undefined ? handoff.queue_position : metadata.queuePosition,
        metadata.dependsOnHandoffUid === undefined
          ? handoff.depends_on_handoff_uid
          : metadata.dependsOnHandoffUid,
        now,
        handoffUid
      );

    this.events.recordEvent({
      eventType: "handoff.metadata_updated",
      handoffUid,
      sessionUid,
      payload: {
        queueKey: metadata.queueKey,
        labels: metadata.labels,
        queuePosition: metadata.queuePosition,
        dependsOnHandoffUid: metadata.dependsOnHandoffUid
      }
    });

    return this.requireHandoff(handoffUid);
  }

  linkVaultMemoryFromSession(
    handoffUid: string,
    sessionUid: string,
    sessionToken: string,
    vaultMemoryUid: string
  ): HandoffRecord {
    this.assertSessionOwner(sessionUid, sessionToken);
    const handoff = this.findHandoffRow(handoffUid);
    if (!handoff) {
      throw new Error(`Handoff not found: ${handoffUid}`);
    }

    if (!handoff.source_session_uid) {
      throw new Error("Handoff has no source session owner");
    }

    if (handoff.source_session_uid !== sessionUid) {
      throw new Error("Vault memory can only be linked by the source session owner");
    }

    return this.linkVaultMemory(handoffUid, vaultMemoryUid, sessionUid);
  }

  claimHandoff(handoffUid: string, sessionUid: string, sessionToken: string): HandoffRecord {
    this.assertSessionOwner(sessionUid, sessionToken);
    const now = this.now();
    const claimToken = randomBytes(32).toString("base64url");

    const claim = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `
          UPDATE handoffs
          SET status = ?,
              claimed_by_session_uid = ?,
              claim_token = ?,
              updated_at = ?
          WHERE handoff_uid = ?
            AND status = ?
            AND claimed_by_session_uid IS NULL
        `
        )
        .run("claimed", sessionUid, claimToken, now, handoffUid, "available");

      if (result.changes !== 1) {
        const current = this.findHandoffRow(handoffUid);
        if (!current) {
          throw new Error(`Handoff not found: ${handoffUid}`);
        }

        if (current.claimed_by_session_uid || current.status === "claimed") {
          throw new Error("Handoff already claimed");
        }

        throw new Error(`Handoff is not available: ${current.status}`);
      }

      this.db
        .prepare(
          `
          UPDATE sessions
          SET current_handoff_uid = ?, updated_at = ?
          WHERE session_uid = ?
        `
        )
        .run(handoffUid, now, sessionUid);
    });

    claim();

    this.events.recordEvent({
      eventType: "handoff.claimed",
      handoffUid,
      sessionUid,
      payload: {}
    });

    return this.requireHandoff(handoffUid);
  }

  updateHandoff(
    handoffUid: string,
    sessionUid: string,
    sessionToken: string,
    status: HandoffStatus,
    progressNote: string
  ): HandoffRecord {
    this.assertClaimOwner(handoffUid, sessionUid, sessionToken);
    if (status === "available" || status === "claimed" || status === "resolved") {
      throw new Error(`Use a dedicated lifecycle method for handoff status: ${status}`);
    }

    const now = this.now();
    this.db
      .prepare(
        `
        UPDATE handoffs
        SET status = ?, progress_note = ?, updated_at = ?
        WHERE handoff_uid = ?
      `
      )
      .run(status, progressNote, now, handoffUid);

    this.events.recordEvent({
      eventType: "handoff.updated",
      handoffUid,
      sessionUid,
      payload: {
        status,
        progressNote
      }
    });

    return this.requireHandoff(handoffUid);
  }

  requestUserConfirmation(
    handoffUid: string,
    sessionUid: string,
    sessionToken: string,
    question: string
  ): HandoffRecord {
    this.assertClaimOwner(handoffUid, sessionUid, sessionToken);
    const now = this.now();

    this.db
      .prepare(
        `
        UPDATE handoffs
        SET status = ?, progress_note = ?, updated_at = ?
        WHERE handoff_uid = ?
      `
      )
      .run("awaiting_user", question, now, handoffUid);

    this.events.recordEvent({
      eventType: "handoff.user_confirmation_requested",
      handoffUid,
      sessionUid,
      payload: {
        question
      }
    });

    return this.requireHandoff(handoffUid);
  }

  releaseHandoff(
    handoffUid: string,
    sessionUid: string,
    sessionToken: string
  ): HandoffRecord {
    this.assertClaimOwner(handoffUid, sessionUid, sessionToken);
    const now = this.now();

    const release = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE handoffs
          SET status = ?,
              claimed_by_session_uid = NULL,
              claim_token = NULL,
              lease_expires_at = NULL,
              progress_note = NULL,
              updated_at = ?
          WHERE handoff_uid = ?
        `
        )
        .run("available", now, handoffUid);

      this.db
        .prepare(
          `
          UPDATE sessions
          SET current_handoff_uid = NULL, updated_at = ?
          WHERE session_uid = ?
            AND current_handoff_uid = ?
        `
        )
        .run(now, sessionUid, handoffUid);
    });

    release();

    this.events.recordEvent({
      eventType: "handoff.released",
      handoffUid,
      sessionUid,
      payload: {}
    });

    return this.requireHandoff(handoffUid);
  }

  resolveHandoff(
    handoffUid: string,
    sessionUid: string,
    sessionToken: string,
    summary: string
  ): HandoffRecord {
    this.assertClaimOwner(handoffUid, sessionUid, sessionToken);
    const now = this.now();

    const resolve = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE handoffs
          SET status = ?,
              resolution_summary = ?,
              resolved_at = ?,
              updated_at = ?
          WHERE handoff_uid = ?
        `
        )
        .run("resolved", summary, now, now, handoffUid);

      this.db
        .prepare(
          `
          UPDATE sessions
          SET current_handoff_uid = NULL, updated_at = ?
          WHERE session_uid = ?
            AND current_handoff_uid = ?
        `
        )
        .run(now, sessionUid, handoffUid);
    });

    resolve();

    this.events.recordEvent({
      eventType: "handoff.resolved",
      handoffUid,
      sessionUid,
      payload: {
        summary
      }
    });

    return this.requireHandoff(handoffUid);
  }

  recoverHandoff(handoffUid: string, input: RecoverHandoffInput): HandoffRecord {
    this.assertNonEmpty(input.reason, "Recovery reason");
    this.assertNonEmpty(input.resolutionSummary, "Recovery resolution summary");
    this.assertNonEmpty(input.evidenceVaultMemoryUid, "Recovery evidence Vault memory UID");

    const actor = this.assertSessionOwner(input.actorSessionUid, input.actorSessionToken);
    const handoff = this.findHandoffRow(handoffUid);
    if (!handoff) {
      throw new Error(`Handoff not found: ${handoffUid}`);
    }

    if (handoff.status === "resolved") {
      throw new Error("Handoff is already resolved");
    }

    const actorCapabilities = JSON.parse(actor.capabilities_json) as Record<string, unknown>;
    const isSourceSession = handoff.source_session_uid === input.actorSessionUid;
    const hasRecoveryCapability =
      actorCapabilities.handoffRecovery === true || actorCapabilities.admin === true;
    if (!isSourceSession && !hasRecoveryCapability) {
      throw new Error("Recovery resolve requires source session or recovery-capable session");
    }

    const now = this.now();
    const actorAuthorizedBy = isSourceSession ? "source_session" : "recovery_capability";
    const previousClaimedBySessionUid = handoff.claimed_by_session_uid;
    const previousStatus = handoff.status;

    const recover = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE handoffs
          SET status = ?,
              vault_memory_uid = COALESCE(vault_memory_uid, ?),
              claim_token = NULL,
              lease_expires_at = NULL,
              resolution_summary = ?,
              resolved_at = ?,
              updated_at = ?
          WHERE handoff_uid = ?
        `
        )
        .run(
          "resolved",
          input.evidenceVaultMemoryUid,
          input.resolutionSummary,
          now,
          now,
          handoffUid
        );

      if (previousClaimedBySessionUid) {
        this.db
          .prepare(
            `
            UPDATE sessions
            SET current_handoff_uid = NULL, updated_at = ?
            WHERE session_uid = ?
              AND current_handoff_uid = ?
          `
          )
          .run(now, previousClaimedBySessionUid, handoffUid);
      }
    });

    recover();

    this.events.recordEvent({
      eventType: "handoff.recovery_resolved",
      handoffUid,
      sessionUid: input.actorSessionUid,
      payload: {
        reason: input.reason,
        summary: input.resolutionSummary,
        evidenceVaultMemoryUid: input.evidenceVaultMemoryUid,
        previousClaimedBySessionUid,
        previousStatus,
        actorAuthorizedBy
      }
    });

    return this.requireHandoff(handoffUid);
  }

  reopenHandoff(
    handoffUid: string,
    reason: string,
    targetStatus: HandoffStatus = "available"
  ): HandoffRecord {
    if (closedInboxStatuses.includes(targetStatus)) {
      throw new Error(`Cannot reopen a handoff into closed status: ${targetStatus}`);
    }

    const current = this.requireHandoff(handoffUid);
    const now = this.now();

    const reopen = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE handoffs
          SET status = ?,
              claimed_by_session_uid = NULL,
              claim_token = NULL,
              lease_expires_at = NULL,
              progress_note = NULL,
              resolution_summary = NULL,
              reopen_reason = ?,
              resolved_at = NULL,
              stale_at = NULL,
              updated_at = ?
          WHERE handoff_uid = ?
        `
        )
        .run(targetStatus, reason, now, handoffUid);

      if (current.claimedBySessionUid) {
        this.db
          .prepare(
            `
            UPDATE sessions
            SET current_handoff_uid = NULL, updated_at = ?
            WHERE session_uid = ?
              AND current_handoff_uid = ?
          `
          )
          .run(now, current.claimedBySessionUid, handoffUid);
      }
    });

    reopen();

    this.events.recordEvent({
      eventType: "handoff.reopened",
      handoffUid,
      sessionUid: null,
      payload: {
        reason,
        targetStatus
      }
    });

    return this.requireHandoff(handoffUid);
  }

  private assertClaimOwner(
    handoffUid: string,
    sessionUid: string,
    sessionToken: string
  ): HandoffRow {
    this.assertSessionOwner(sessionUid, sessionToken);
    const handoff = this.findHandoffRow(handoffUid);
    if (!handoff) {
      throw new Error(`Handoff not found: ${handoffUid}`);
    }

    if (handoff.claimed_by_session_uid !== sessionUid) {
      throw new Error("Handoff is not claimed by session");
    }

    if (closedInboxStatuses.includes(handoff.status)) {
      throw new Error(`Cannot mutate closed handoff: ${handoff.status}`);
    }

    return handoff;
  }

  private assertSessionOwner(sessionUid: string, sessionToken: string): SessionOwnerRow {
    const row = this.db
      .prepare(
        "SELECT session_uid, session_token, capabilities_json FROM sessions WHERE session_uid = ?"
      )
      .get(sessionUid) as SessionOwnerRow | undefined;

    if (!row) {
      throw new Error(`Session not found: ${sessionUid}`);
    }

    if (row.session_token !== sessionToken) {
      throw new Error("Invalid session token");
    }

    return row;
  }

  private assertNonEmpty(value: string, label: string): void {
    if (value.trim() === "") {
      throw new Error(`${label} cannot be empty`);
    }
  }

  private requireHandoff(handoffUid: string): HandoffRecord {
    const row = this.findHandoffRow(handoffUid);
    if (!row) {
      throw new Error(`Handoff not found: ${handoffUid}`);
    }

    return this.mapRow(row);
  }

  private findHandoffRow(handoffUid: string): HandoffRow | undefined {
    return this.db.prepare("SELECT * FROM handoffs WHERE handoff_uid = ?").get(handoffUid) as
      | HandoffRow
      | undefined;
  }

  private mapRow(row: HandoffRow): HandoffRecord {
    return {
      handoffUid: row.handoff_uid,
      vaultMemoryUid: row.vault_memory_uid,
      shortPrompt: row.short_prompt,
      sourceProject: row.source_project,
      targetProject: row.target_project,
      relatedProjects: JSON.parse(row.related_projects_json) as string[],
      relatedFiles: JSON.parse(row.related_files_json) as string[],
      sourceSessionUid: row.source_session_uid,
      suggestedSessionUid: row.suggested_session_uid,
      suggestedClientType: row.suggested_client_type,
      queueKey: row.queue_key,
      labels: JSON.parse(row.labels_json) as string[],
      queuePosition: row.queue_position,
      dependsOnHandoffUid: row.depends_on_handoff_uid,
      status: row.status,
      priority: row.priority,
      urgent: row.urgent === 1,
      claimedBySessionUid: row.claimed_by_session_uid,
      leaseExpiresAt: row.lease_expires_at,
      progressNote: row.progress_note,
      resolutionSummary: row.resolution_summary,
      reopenReason: row.reopen_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      staleAt: row.stale_at
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private nextQueuePosition(targetProject: string, queueKey: string): number {
    const row = this.db
      .prepare(
        `
        SELECT MAX(queue_position) AS max_position
        FROM handoffs
        WHERE target_project = ?
          AND queue_key = ?
      `
      )
      .get(targetProject, queueKey) as { max_position: number | null } | undefined;

    return (row?.max_position ?? 0) + 1000;
  }
}
