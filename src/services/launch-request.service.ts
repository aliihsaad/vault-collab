import { randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import { projectKey } from "../project-key.js";
import type { EventService } from "./event.service.js";
import type {
  ClientType,
  CreateLaunchRequestInput,
  EventRecord,
  JsonRecord,
  LaunchRequestActionAffordance,
  LaunchRequestActionKind,
  LaunchRequestActionSet,
  LaunchRequestDetail,
  LaunchRequestFilters,
  LaunchRequestRecord,
  LaunchRequestStatus
} from "../types.js";

interface LaunchRequestRow {
  launch_request_uid: string;
  project: string;
  project_key: string;
  provider: ClientType;
  model: string;
  effort_level: string | null;
  workspace_path: string;
  role: string | null;
  initial_instructions: string;
  permission_mode: string;
  command_preview: string | null;
  requested_capabilities_json: string;
  approval_policy_version: string | null;
  approval_snapshot_json: string | null;
  status: LaunchRequestStatus;
  status_detail: string | null;
  requested_by_session_uid: string;
  approved_by_session_uid: string | null;
  rejected_by_session_uid: string | null;
  broker_session_uid: string | null;
  launched_session_uid: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface SessionOwnerRow {
  session_uid: string;
  session_token: string;
  capabilities_json: string;
}

interface LaunchSessionRow {
  session_uid: string;
  client_type: ClientType;
  project_key: string;
  workspace_path: string;
  capabilities_json: string;
}

const launchableStatuses: LaunchRequestStatus[] = ["approved"];
const cancellableStatuses: LaunchRequestStatus[] = ["requested", "approved"];
const failableStatuses: LaunchRequestStatus[] = ["approved", "launching", "running"];

export class LaunchRequestService {
  constructor(
    private readonly db: CollabDatabase,
    private readonly events: EventService,
    private readonly clock: () => Date = () => new Date()
  ) {}

  createLaunchRequest(input: CreateLaunchRequestInput): LaunchRequestRecord {
    this.assertNonEmpty(input.model, "Launch request model");
    this.assertNonEmpty(input.project, "Launch request project");
    this.assertNonEmpty(input.workspacePath, "Launch request workspace path");
    this.assertNonEmpty(input.initialInstructions, "Launch request initial instructions");
    this.assertNonEmpty(input.permissionMode, "Launch request permission mode");
    this.assertSessionCapability(input.requestedBySessionUid, input.sessionToken, "launchRequests");

    const now = this.now();
    const launchRequestUid = `vc_launch_${randomUUID()}`;

    this.db
      .prepare(
        `
        INSERT INTO launch_requests (
          launch_request_uid,
          project,
          project_key,
          provider,
          model,
          effort_level,
          workspace_path,
          role,
          initial_instructions,
          permission_mode,
          command_preview,
          requested_capabilities_json,
          approval_policy_version,
          approval_snapshot_json,
          status,
          status_detail,
          requested_by_session_uid,
          approved_by_session_uid,
          rejected_by_session_uid,
          broker_session_uid,
          launched_session_uid,
          metadata_json,
          created_at,
          updated_at,
          approved_at,
          rejected_at,
          started_at,
          completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        launchRequestUid,
        input.project,
        projectKey(input.project),
        input.provider,
        input.model,
        input.effortLevel ?? null,
        input.workspacePath,
        input.role ?? null,
        input.initialInstructions,
        input.permissionMode,
        input.commandPreview ?? null,
        JSON.stringify(input.requestedCapabilities ?? []),
        input.approvalPolicyVersion ?? null,
        null,
        "requested",
        null,
        input.requestedBySessionUid,
        null,
        null,
        null,
        null,
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
        null,
        null,
        null,
        null
      );

    this.events.recordEvent({
      eventType: "launch_request.requested",
      sessionUid: input.requestedBySessionUid,
      payload: {
        launchRequestUid,
        provider: input.provider,
        model: input.model,
        project: input.project,
        permissionMode: input.permissionMode
      }
    });

    return this.requireLaunchRequest(launchRequestUid);
  }

  listLaunchRequests(filter: LaunchRequestFilters = {}): LaunchRequestRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.project) {
      clauses.push("project_key = ?");
      params.push(projectKey(filter.project));
    }

    if (filter.provider) {
      clauses.push("provider = ?");
      params.push(filter.provider);
    }

    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }

    if (filter.requestedBySessionUid) {
      clauses.push("requested_by_session_uid = ?");
      params.push(filter.requestedBySessionUid);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM launch_requests
        ${where}
        ORDER BY created_at ASC, launch_request_uid ASC
      `
      )
      .all(...params) as LaunchRequestRow[];

    return rows.map((row) => this.mapRow(row));
  }

  getLaunchRequest(launchRequestUid: string): LaunchRequestRecord | null {
    const row = this.findLaunchRequestRow(launchRequestUid);
    return row ? this.mapRow(row) : null;
  }

  getLaunchRequestDetail(launchRequestUid: string): LaunchRequestDetail {
    const launchRequest = this.getLaunchRequest(launchRequestUid);
    if (!launchRequest) {
      throw new Error(`Launch request not found: ${launchRequestUid}`);
    }

    return {
      launchRequest,
      events: this.launchRequestEvents(launchRequestUid)
    };
  }

  getLaunchRequestActions(
    launchRequestUid: string,
    sessionUid: string,
    sessionToken: string
  ): LaunchRequestActionSet {
    const actor = this.assertSessionOwner(sessionUid, sessionToken);
    const row = this.findLaunchRequestRow(launchRequestUid);
    if (!row) {
      throw new Error(`Launch request not found: ${launchRequestUid}`);
    }

    const hasLaunchApproval = this.hasCapability(actor, "launchApproval");
    const hasLaunchBroker = this.hasCapability(actor, "launchBroker");
    const isRequester = row.requested_by_session_uid === sessionUid;
    const isSameBroker = !row.broker_session_uid || row.broker_session_uid === sessionUid;

    return {
      launchRequest: this.mapRow(row),
      actingSessionUid: sessionUid,
      actions: [
        this.actionAffordance({
          kind: "approve",
          toolName: "vault_collab_approve_launch_request",
          requiredCapability: "launchApproval",
          requiresReason: false,
          requiresLaunchedSessionUid: false,
          enabled: row.status === "requested" && hasLaunchApproval,
          reason:
            row.status !== "requested"
              ? `Launch request must be requested to approve; current status is ${row.status}`
              : hasLaunchApproval
                ? "Acting session can approve this requested launch."
                : "Session requires launch approval capability."
        }),
        this.actionAffordance({
          kind: "reject",
          toolName: "vault_collab_reject_launch_request",
          requiredCapability: "launchApproval",
          requiresReason: true,
          requiresLaunchedSessionUid: false,
          enabled: row.status === "requested" && hasLaunchApproval,
          reason:
            row.status !== "requested"
              ? `Launch request must be requested to reject; current status is ${row.status}`
              : hasLaunchApproval
                ? "Acting session can reject this requested launch with a reason."
                : "Session requires launch approval capability."
        }),
        this.actionAffordance({
          kind: "cancel",
          toolName: "vault_collab_cancel_launch_request",
          requiredCapability: isRequester ? null : "launchApproval",
          requiresReason: true,
          requiresLaunchedSessionUid: false,
          enabled: cancellableStatuses.includes(row.status) && (isRequester || hasLaunchApproval),
          reason: this.cancelActionReason(row, isRequester, hasLaunchApproval)
        }),
        this.actionAffordance({
          kind: "mark_launching",
          toolName: "vault_collab_mark_launch_request_launching",
          requiredCapability: "launchBroker",
          requiresReason: false,
          requiresLaunchedSessionUid: false,
          enabled: row.status === "approved" && hasLaunchBroker,
          reason:
            row.status !== "approved"
              ? `Launch request must be approved to mark launching; current status is ${row.status}`
              : hasLaunchBroker
                ? "Acting broker can mark this approved request as launching."
                : "Session requires launch broker capability."
        }),
        this.actionAffordance({
          kind: "mark_running",
          toolName: "vault_collab_mark_launch_request_running",
          requiredCapability: "launchBroker",
          requiresReason: false,
          requiresLaunchedSessionUid: true,
          enabled: row.status === "launching" && hasLaunchBroker && isSameBroker,
          reason: this.runningActionReason(row, hasLaunchBroker, isSameBroker)
        }),
        this.actionAffordance({
          kind: "fail",
          toolName: "vault_collab_fail_launch_request",
          requiredCapability: "launchBroker",
          requiresReason: true,
          requiresLaunchedSessionUid: false,
          enabled: failableStatuses.includes(row.status) && hasLaunchBroker && isSameBroker,
          reason: this.failActionReason(row, hasLaunchBroker, isSameBroker)
        })
      ]
    };
  }

  approveLaunchRequest(
    launchRequestUid: string,
    sessionUid: string,
    sessionToken: string,
    detail: string | null = null
  ): LaunchRequestRecord {
    this.assertSessionCapability(sessionUid, sessionToken, "launchApproval");
    const current = this.requireMutableLaunchRequest(launchRequestUid, ["requested"], "approve");
    const now = this.now();
    const approvalSnapshot = this.approvalSnapshot(current);

    this.db
      .prepare(
        `
        UPDATE launch_requests
        SET status = ?,
            status_detail = ?,
            approved_by_session_uid = ?,
            approval_snapshot_json = ?,
            rejected_by_session_uid = NULL,
            updated_at = ?,
            approved_at = ?,
            rejected_at = NULL
        WHERE launch_request_uid = ?
      `
      )
      .run(
        "approved",
        detail,
        sessionUid,
        JSON.stringify(approvalSnapshot),
        now,
        now,
        current.launch_request_uid
      );

    this.recordLifecycleEvent("launch_request.approved", launchRequestUid, sessionUid, {
      detail
    });
    return this.requireLaunchRequest(launchRequestUid);
  }

  rejectLaunchRequest(
    launchRequestUid: string,
    sessionUid: string,
    sessionToken: string,
    reason: string
  ): LaunchRequestRecord {
    this.assertNonEmpty(reason, "Launch request rejection reason");
    this.assertSessionCapability(sessionUid, sessionToken, "launchApproval");
    const current = this.requireMutableLaunchRequest(launchRequestUid, ["requested"], "reject");
    const now = this.now();

    this.db
      .prepare(
        `
        UPDATE launch_requests
        SET status = ?,
            status_detail = ?,
            rejected_by_session_uid = ?,
            updated_at = ?,
            rejected_at = ?,
            completed_at = ?
        WHERE launch_request_uid = ?
      `
      )
      .run("rejected", reason, sessionUid, now, now, now, current.launch_request_uid);

    this.recordLifecycleEvent("launch_request.rejected", launchRequestUid, sessionUid, {
      reason
    });
    return this.requireLaunchRequest(launchRequestUid);
  }

  cancelLaunchRequest(
    launchRequestUid: string,
    sessionUid: string,
    sessionToken: string,
    reason: string
  ): LaunchRequestRecord {
    this.assertNonEmpty(reason, "Launch request cancellation reason");
    const actor = this.assertSessionOwner(sessionUid, sessionToken);
    const current = this.requireMutableLaunchRequest(launchRequestUid, cancellableStatuses, "cancel");
    if (
      current.requested_by_session_uid !== sessionUid &&
      !this.hasCapability(actor, "launchApproval")
    ) {
      throw new Error("Launch request cancellation requires requester or launch approval capability");
    }

    const now = this.now();
    this.db
      .prepare(
        `
        UPDATE launch_requests
        SET status = ?,
            status_detail = ?,
            updated_at = ?,
            completed_at = ?
        WHERE launch_request_uid = ?
      `
      )
      .run("cancelled", reason, now, now, current.launch_request_uid);

    this.recordLifecycleEvent("launch_request.cancelled", launchRequestUid, sessionUid, {
      reason
    });
    return this.requireLaunchRequest(launchRequestUid);
  }

  markLaunchRequestLaunching(
    launchRequestUid: string,
    sessionUid: string,
    sessionToken: string,
    detail: string | null = null
  ): LaunchRequestRecord {
    this.assertSessionCapability(sessionUid, sessionToken, "launchBroker");
    const current = this.requireMutableLaunchRequest(launchRequestUid, launchableStatuses, "launch");
    const now = this.now();

    this.db
      .prepare(
        `
        UPDATE launch_requests
        SET status = ?,
            status_detail = ?,
            broker_session_uid = ?,
            updated_at = ?,
            started_at = COALESCE(started_at, ?)
        WHERE launch_request_uid = ?
      `
      )
      .run("launching", detail, sessionUid, now, now, current.launch_request_uid);

    this.recordLifecycleEvent("launch_request.launching", launchRequestUid, sessionUid, {
      detail
    });
    return this.requireLaunchRequest(launchRequestUid);
  }

  markLaunchRequestRunning(
    launchRequestUid: string,
    sessionUid: string,
    sessionToken: string,
    launchedSessionUid: string,
    detail: string | null = null
  ): LaunchRequestRecord {
    this.assertNonEmpty(launchedSessionUid, "Launched session UID");
    this.assertSessionCapability(sessionUid, sessionToken, "launchBroker");
    const current = this.requireMutableLaunchRequest(launchRequestUid, ["launching"], "mark running");
    this.assertSameBroker(current, sessionUid);
    this.assertLaunchedSessionMatches(current, launchedSessionUid);
    const now = this.now();

    this.db
      .prepare(
        `
        UPDATE launch_requests
        SET status = ?,
            status_detail = ?,
            broker_session_uid = ?,
            launched_session_uid = ?,
            updated_at = ?
        WHERE launch_request_uid = ?
      `
      )
      .run("running", detail, sessionUid, launchedSessionUid, now, current.launch_request_uid);

    this.recordLifecycleEvent("launch_request.running", launchRequestUid, sessionUid, {
      detail,
      launchedSessionUid
    });
    return this.requireLaunchRequest(launchRequestUid);
  }

  failLaunchRequest(
    launchRequestUid: string,
    sessionUid: string,
    sessionToken: string,
    reason: string
  ): LaunchRequestRecord {
    this.assertNonEmpty(reason, "Launch request failure reason");
    this.assertSessionCapability(sessionUid, sessionToken, "launchBroker");
    const current = this.requireMutableLaunchRequest(launchRequestUid, failableStatuses, "fail");
    this.assertSameBroker(current, sessionUid);
    const now = this.now();

    this.db
      .prepare(
        `
        UPDATE launch_requests
        SET status = ?,
            status_detail = ?,
            broker_session_uid = COALESCE(broker_session_uid, ?),
            updated_at = ?,
            completed_at = ?
        WHERE launch_request_uid = ?
      `
      )
      .run("failed", reason, sessionUid, now, now, current.launch_request_uid);

    this.recordLifecycleEvent("launch_request.failed", launchRequestUid, sessionUid, {
      reason
    });
    return this.requireLaunchRequest(launchRequestUid);
  }

  private assertSessionCapability(
    sessionUid: string,
    sessionToken: string,
    capability: string
  ): SessionOwnerRow {
    const session = this.assertSessionOwner(sessionUid, sessionToken);
    if (!this.hasCapability(session, capability)) {
      throw new Error(`Session requires ${this.capabilityLabel(capability)} capability`);
    }

    return session;
  }

  private capabilityLabel(capability: string): string {
    return capability.replace(/([A-Z])/g, " $1").toLowerCase();
  }

  private hasCapability(session: SessionOwnerRow, capability: string): boolean {
    const capabilities = JSON.parse(session.capabilities_json) as Record<string, unknown>;
    return capabilities[capability] === true || capabilities.admin === true;
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

  private assertSameBroker(row: LaunchRequestRow, sessionUid: string): void {
    if (row.broker_session_uid && row.broker_session_uid !== sessionUid) {
      throw new Error("Launch request must be completed by the same broker session");
    }
  }

  private assertLaunchedSessionMatches(row: LaunchRequestRow, launchedSessionUid: string): void {
    const session = this.findLaunchSessionRow(launchedSessionUid);
    if (!session) {
      throw new Error(`Launched session not found: ${launchedSessionUid}`);
    }

    if (session.client_type !== row.provider) {
      throw new Error("Launched session provider does not match launch request");
    }

    if (session.project_key !== row.project_key) {
      throw new Error("Launched session project does not match launch request");
    }

    if (session.workspace_path !== row.workspace_path) {
      throw new Error("Launched session workspace path does not match launch request");
    }

    const capabilities = JSON.parse(session.capabilities_json) as Record<string, unknown>;
    if (capabilities.launchedBy !== row.launch_request_uid) {
      throw new Error("Launched session must include launchedBy matching the launch request UID");
    }
  }

  private findLaunchSessionRow(sessionUid: string): LaunchSessionRow | undefined {
    return this.db
      .prepare(
        `
        SELECT session_uid, client_type, project_key, workspace_path, capabilities_json
        FROM sessions
        WHERE session_uid = ?
      `
      )
      .get(sessionUid) as LaunchSessionRow | undefined;
  }

  private assertNonEmpty(value: string, label: string): void {
    if (value.trim() === "") {
      throw new Error(`${label} cannot be empty`);
    }
  }

  private requireMutableLaunchRequest(
    launchRequestUid: string,
    allowedStatuses: LaunchRequestStatus[],
    action: string
  ): LaunchRequestRow {
    const row = this.findLaunchRequestRow(launchRequestUid);
    if (!row) {
      throw new Error(`Launch request not found: ${launchRequestUid}`);
    }

    if (!allowedStatuses.includes(row.status)) {
      throw new Error(
        `Launch request must be ${allowedStatuses.join(" or ")} to ${action}; current status is ${row.status}`
      );
    }

    return row;
  }

  private requireLaunchRequest(launchRequestUid: string): LaunchRequestRecord {
    const row = this.findLaunchRequestRow(launchRequestUid);
    if (!row) {
      throw new Error(`Launch request not found: ${launchRequestUid}`);
    }

    return this.mapRow(row);
  }

  private findLaunchRequestRow(launchRequestUid: string): LaunchRequestRow | undefined {
    return this.db
      .prepare("SELECT * FROM launch_requests WHERE launch_request_uid = ?")
      .get(launchRequestUid) as LaunchRequestRow | undefined;
  }

  private recordLifecycleEvent(
    eventType: string,
    launchRequestUid: string,
    sessionUid: string,
    payload: JsonRecord
  ): void {
    this.events.recordEvent({
      eventType,
      sessionUid,
      payload: {
        launchRequestUid,
        ...payload
      }
    });
  }

  private launchRequestEvents(launchRequestUid: string): EventRecord[] {
    return this.events
      .listEvents()
      .filter((event) => event.payload.launchRequestUid === launchRequestUid);
  }

  private actionAffordance(input: {
    kind: LaunchRequestActionKind;
    enabled: boolean;
    reason: string;
    toolName: string;
    requiredCapability: string | null;
    requiresReason: boolean;
    requiresLaunchedSessionUid: boolean;
  }): LaunchRequestActionAffordance {
    return {
      ...input,
      requiresOwnerToken: true
    };
  }

  private cancelActionReason(
    row: LaunchRequestRow,
    isRequester: boolean,
    hasLaunchApproval: boolean
  ): string {
    if (!cancellableStatuses.includes(row.status)) {
      return `Launch request must be requested or approved to cancel; current status is ${row.status}`;
    }

    if (isRequester) {
      return "Requester can cancel this launch request with a reason.";
    }

    if (hasLaunchApproval) {
      return "Launch approver can cancel this launch request with a reason.";
    }

    return "Cancellation requires requester ownership or launch approval capability.";
  }

  private runningActionReason(
    row: LaunchRequestRow,
    hasLaunchBroker: boolean,
    isSameBroker: boolean
  ): string {
    if (row.status !== "launching") {
      return `Launch request must be launching to mark running; current status is ${row.status}`;
    }

    if (!hasLaunchBroker) {
      return "Session requires launch broker capability.";
    }

    if (!isSameBroker) {
      return "Launch request must be completed by the same broker session.";
    }

    return "Acting broker can attach a registered launched session that matches the request.";
  }

  private failActionReason(
    row: LaunchRequestRow,
    hasLaunchBroker: boolean,
    isSameBroker: boolean
  ): string {
    if (!failableStatuses.includes(row.status)) {
      return `Launch request must be approved, launching, or running to fail; current status is ${row.status}`;
    }

    if (!hasLaunchBroker) {
      return "Session requires launch broker capability.";
    }

    if (!isSameBroker) {
      return "Launch request must be completed by the same broker session.";
    }

    return "Acting broker can mark this launch request failed with a reason.";
  }

  private approvalSnapshot(row: LaunchRequestRow): JsonRecord {
    return {
      provider: row.provider,
      model: row.model,
      effortLevel: row.effort_level,
      project: row.project,
      workspacePath: row.workspace_path,
      role: row.role,
      initialInstructions: row.initial_instructions,
      permissionMode: row.permission_mode,
      commandPreview: row.command_preview,
      requestedCapabilities: JSON.parse(row.requested_capabilities_json) as string[],
      approvalPolicyVersion: row.approval_policy_version,
      metadata: JSON.parse(row.metadata_json) as JsonRecord
    };
  }

  private mapRow(row: LaunchRequestRow): LaunchRequestRecord {
    return {
      launchRequestUid: row.launch_request_uid,
      provider: row.provider,
      model: row.model,
      effortLevel: row.effort_level,
      project: row.project,
      workspacePath: row.workspace_path,
      role: row.role,
      initialInstructions: row.initial_instructions,
      permissionMode: row.permission_mode,
      commandPreview: row.command_preview,
      requestedCapabilities: JSON.parse(row.requested_capabilities_json) as string[],
      approvalPolicyVersion: row.approval_policy_version,
      approvalSnapshot: row.approval_snapshot_json
        ? (JSON.parse(row.approval_snapshot_json) as JsonRecord)
        : null,
      status: row.status,
      statusDetail: row.status_detail,
      requestedBySessionUid: row.requested_by_session_uid,
      approvedBySessionUid: row.approved_by_session_uid,
      rejectedBySessionUid: row.rejected_by_session_uid,
      brokerSessionUid: row.broker_session_uid,
      launchedSessionUid: row.launched_session_uid,
      metadata: JSON.parse(row.metadata_json) as JsonRecord,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      approvedAt: row.approved_at,
      rejectedAt: row.rejected_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
