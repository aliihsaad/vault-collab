import { randomBytes, randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import { getLeaseTtlMs } from "../lease.js";
import { projectKey } from "../project-key.js";
import { progressHandoffStatuses } from "../types.js";
import type { EventService } from "./event.service.js";
import type {
  ClientType,
  HandoffFilters,
  HandoffPriority,
  HandoffActionAffordance,
  HandoffActionKind,
  HandoffActionSet,
  HandoffRecord,
  HandoffStatus,
  JsonRecord,
  PermissionRequestInput,
  PublishHandoffInput,
  RecoverHandoffInput,
  SessionStatus,
  UpdateHandoffMetadataInput
} from "../types.js";

interface HandoffRow {
  handoff_uid: string;
  vault_memory_uid: string | null;
  short_prompt: string;
  source_project: string;
  source_project_key: string;
  target_project: string;
  target_project_key: string;
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

function normalizeRelatedProjects(input: PublishHandoffInput): string[] {
  const relatedProjects =
    input.relatedProjects && input.relatedProjects.length > 0
      ? input.relatedProjects
      : [input.sourceProject, input.targetProject];
  const seenProjectKeys = new Set<string>();
  const normalized: string[] = [];

  for (const project of relatedProjects) {
    const key = projectKey(project);
    if (seenProjectKeys.has(key)) {
      continue;
    }
    seenProjectKeys.add(key);
    normalized.push(project);
  }

  return normalized;
}

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
    const sourceProjectKey = projectKey(input.sourceProject);
    const targetProjectKey = projectKey(input.targetProject);
    const relatedProjects = normalizeRelatedProjects(input);
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
          source_project_key,
          target_project,
          target_project_key,
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        handoffUid,
        input.vaultMemoryUid ?? null,
        input.shortPrompt,
        input.sourceProject,
        sourceProjectKey,
        input.targetProject,
        targetProjectKey,
        JSON.stringify(relatedProjects),
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
      clauses.push("source_project_key = ?");
      params.push(projectKey(filter.sourceProject));
    }

    if (filter.targetProject) {
      clauses.push("target_project_key = ?");
      params.push(projectKey(filter.targetProject));
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

  getHandoffActions(
    handoffUid: string,
    sessionUid: string,
    sessionToken: string
  ): HandoffActionSet {
    const actor = this.assertSessionOwner(sessionUid, sessionToken);
    const row = this.findHandoffRow(handoffUid);
    if (!row) {
      throw new Error(`Handoff not found: ${handoffUid}`);
    }

    const actorCapabilities = JSON.parse(actor.capabilities_json) as Record<string, unknown>;
    const isClaimOwner = row.claimed_by_session_uid === sessionUid;
    const isSourceSession = row.source_session_uid === sessionUid;
    const isClosed = closedInboxStatuses.includes(row.status);
    const hasRecoveryCapability =
      actorCapabilities.handoffRecovery === true || actorCapabilities.admin === true;
    const canRecover = !isClosed && (isSourceSession || hasRecoveryCapability);

    return {
      handoff: this.mapRow(row),
      actingSessionUid: sessionUid,
      actions: [
        this.actionAffordance({
          kind: "claim",
          toolName: "vault_collab_claim_handoff",
          enabled: row.status === "available" && row.claimed_by_session_uid === null,
          reason: this.claimActionReason(row, isClaimOwner)
        }),
        this.actionAffordance({
          kind: "update",
          toolName: "vault_collab_update_handoff",
          requiresProgressNote: true,
          enabled: !isClosed && isClaimOwner,
          reason: this.claimOwnerActionReason(row, isClaimOwner, "update")
        }),
        this.actionAffordance({
          kind: "request_user_confirmation",
          toolName: "vault_collab_request_user_confirmation",
          requiresQuestion: true,
          enabled: !isClosed && isClaimOwner,
          reason: this.claimOwnerActionReason(row, isClaimOwner, "request user confirmation")
        }),
        this.actionAffordance({
          kind: "request_handoff_permission",
          toolName: "vault_collab_request_handoff_permission",
          requiresQuestion: true,
          enabled: !isClosed && isClaimOwner,
          reason: this.claimOwnerActionReason(row, isClaimOwner, "request handoff permission")
        }),
        this.actionAffordance({
          kind: "release",
          toolName: "vault_collab_release_handoff",
          enabled: !isClosed && isClaimOwner,
          reason: this.claimOwnerActionReason(row, isClaimOwner, "release")
        }),
        this.actionAffordance({
          kind: "resolve",
          toolName: "vault_collab_resolve_handoff",
          requiresSummary: true,
          enabled: !isClosed && isClaimOwner,
          reason: this.claimOwnerActionReason(row, isClaimOwner, "resolve")
        }),
        this.actionAffordance({
          kind: "recover",
          toolName: "vault_collab_recover_handoff",
          requiredCapability: isSourceSession ? null : "handoffRecovery",
          requiresReason: true,
          requiresSummary: true,
          requiresEvidenceVaultMemoryUid: true,
          enabled: canRecover,
          reason: this.recoverActionReason(row, isSourceSession, hasRecoveryCapability)
        }),
        this.actionAffordance({
          kind: "reopen",
          toolName: "vault_collab_reopen_handoff",
          requiresOwnerToken: false,
          requiresReason: true,
          enabled: isClosed,
          reason: isClosed
            ? "Closed handoff can be reopened as recoverable work."
            : `Handoff must be closed to reopen; current status is ${row.status}.`
        })
      ]
    };
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
              lease_expires_at = ?,
              updated_at = ?
          WHERE handoff_uid = ?
            AND status = ?
            AND claimed_by_session_uid IS NULL
        `
        )
        .run(
          "claimed",
          sessionUid,
          claimToken,
          this.leaseExpiresAt(),
          now,
          handoffUid,
          "available"
        );

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
          SET current_handoff_uid = ?,
              status = ?,
              status_detail = ?,
              updated_at = ?
          WHERE session_uid = ?
            AND status NOT IN (?, ?)
        `
        )
        .run(
          handoffUid,
          "working",
          `Claimed handoff ${handoffUid}.`,
          now,
          sessionUid,
          "complete",
          "disconnected"
        );
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
    if (!progressHandoffStatuses.includes(status as (typeof progressHandoffStatuses)[number])) {
      throw new Error(`Use a dedicated lifecycle method for handoff status: ${status}`);
    }

    const now = this.now();
    this.db
      .prepare(
        `
        UPDATE handoffs
        SET status = ?, progress_note = ?, lease_expires_at = ?, updated_at = ?
        WHERE handoff_uid = ?
      `
      )
      .run(status, progressNote, this.leaseExpiresAt(), now, handoffUid);
    this.updateSessionWorkState(
      sessionUid,
      this.sessionStatusForHandoffStatus(status),
      progressNote,
      now
    );

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
    this.updateSessionWorkState(sessionUid, "awaiting_user", question, now);

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

  requestHandoffPermission(
    handoffUid: string,
    sessionUid: string,
    sessionToken: string,
    input: PermissionRequestInput
  ): HandoffRecord {
    this.assertNonEmpty(input.question, "Permission question");
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
      .run("awaiting_user", input.question, now, handoffUid);
    this.updateSessionWorkState(sessionUid, "awaiting_user", input.question, now);

    this.events.recordEvent({
      eventType: "handoff.permission_requested",
      handoffUid,
      sessionUid,
      payload: {
        permissionRequest: this.permissionRequestPayload(input, now)
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
          SET current_handoff_uid = NULL,
              status = ?,
              status_detail = NULL,
              updated_at = ?
          WHERE session_uid = ?
            AND current_handoff_uid = ?
            AND status NOT IN (?, ?)
        `
        )
        .run("idle", now, sessionUid, handoffUid, "complete", "disconnected");
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
          SET current_handoff_uid = NULL,
              status = ?,
              status_detail = NULL,
              updated_at = ?
          WHERE session_uid = ?
            AND current_handoff_uid = ?
            AND status NOT IN (?, ?)
        `
        )
        .run("idle", now, sessionUid, handoffUid, "complete", "disconnected");
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
            SET current_handoff_uid = NULL,
                status = ?,
                status_detail = NULL,
                updated_at = ?
            WHERE session_uid = ?
              AND current_handoff_uid = ?
              AND status NOT IN (?, ?)
          `
          )
          .run("idle", now, previousClaimedBySessionUid, handoffUid, "complete", "disconnected");
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
            SET current_handoff_uid = NULL,
                status = ?,
                status_detail = NULL,
                updated_at = ?
            WHERE session_uid = ?
              AND current_handoff_uid = ?
              AND status NOT IN (?, ?)
          `
          )
          .run("idle", now, current.claimedBySessionUid, handoffUid, "complete", "disconnected");
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

  private updateSessionWorkState(
    sessionUid: string,
    status: SessionStatus,
    detail: string | null,
    now: string
  ): void {
    this.db
      .prepare(
        `
        UPDATE sessions
        SET status = ?,
            status_detail = ?,
            updated_at = ?
        WHERE session_uid = ?
          AND status NOT IN (?, ?)
      `
      )
      .run(status, detail, now, sessionUid, "complete", "disconnected");
  }

  private sessionStatusForHandoffStatus(status: HandoffStatus): SessionStatus {
    switch (status) {
      case "in_progress":
        return "working";
      case "blocked":
        return "blocked";
      case "awaiting_user":
        return "awaiting_user";
      case "verification_needed":
        return "awaiting_verification";
      default:
        return "working";
    }
  }

  private actionAffordance(input: {
    kind: HandoffActionKind;
    toolName: string;
    enabled: boolean;
    reason: string;
    requiredCapability?: string | null;
    requiresOwnerToken?: boolean;
    requiresProgressNote?: boolean;
    requiresQuestion?: boolean;
    requiresReason?: boolean;
    requiresSummary?: boolean;
    requiresEvidenceVaultMemoryUid?: boolean;
  }): HandoffActionAffordance {
    return {
      kind: input.kind,
      enabled: input.enabled,
      reason: input.reason,
      toolName: input.toolName,
      requiredCapability: input.requiredCapability ?? null,
      requiresOwnerToken: input.requiresOwnerToken ?? true,
      requiresProgressNote: input.requiresProgressNote ?? false,
      requiresQuestion: input.requiresQuestion ?? false,
      requiresReason: input.requiresReason ?? false,
      requiresSummary: input.requiresSummary ?? false,
      requiresEvidenceVaultMemoryUid: input.requiresEvidenceVaultMemoryUid ?? false
    };
  }

  private claimActionReason(row: HandoffRow, isClaimOwner: boolean): string {
    if (closedInboxStatuses.includes(row.status)) {
      return `Handoff is closed: ${row.status}.`;
    }

    if (row.claimed_by_session_uid) {
      return isClaimOwner
        ? "Handoff is already claimed by the acting session."
        : "Handoff is already claimed by another session.";
    }

    if (row.status !== "available") {
      return `Handoff must be available to claim; current status is ${row.status}.`;
    }

    return "Acting session can claim this available handoff.";
  }

  private claimOwnerActionReason(
    row: HandoffRow,
    isClaimOwner: boolean,
    action: string
  ): string {
    if (closedInboxStatuses.includes(row.status)) {
      return `Cannot ${action} a closed handoff: ${row.status}.`;
    }

    if (!isClaimOwner) {
      return `Handoff must be claimed by the acting session to ${action}.`;
    }

    return `Acting session can ${action} this handoff.`;
  }

  private recoverActionReason(
    row: HandoffRow,
    isSourceSession: boolean,
    hasRecoveryCapability: boolean
  ): string {
    if (closedInboxStatuses.includes(row.status)) {
      return `Cannot recover a closed handoff: ${row.status}.`;
    }

    if (isSourceSession) {
      return "Source session can recover-resolve this handoff with evidence.";
    }

    if (hasRecoveryCapability) {
      return "Recovery-capable session can recover-resolve this handoff with evidence.";
    }

    return "Recover resolve requires source session or handoffRecovery capability.";
  }

  private permissionRequestPayload(
    input: PermissionRequestInput,
    createdAt: string
  ): JsonRecord {
    return {
      question: input.question,
      requestedCapability: input.requestedCapability ?? null,
      commandPreview: input.commandPreview ?? null,
      source: input.source ?? "agent",
      createdAt
    };
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

  private leaseExpiresAt(): string {
    return new Date(this.clock().getTime() + getLeaseTtlMs()).toISOString();
  }

  private nextQueuePosition(targetProject: string, queueKey: string): number {
    const rows = this.db
      .prepare(
        `
        SELECT queue_position
        FROM handoffs
        WHERE queue_key = ?
          AND target_project_key = ?
      `
      )
      .all(queueKey, projectKey(targetProject)) as Array<{ queue_position: number | null }>;

    const maxPosition = rows.reduce((max, row) => {
      if (row.queue_position === null) {
        return max;
      }

      return Math.max(max, row.queue_position);
    }, 0);

    return maxPosition + 1000;
  }
}
