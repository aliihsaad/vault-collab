import { randomUUID } from "node:crypto";
import type { CollabDatabase } from "../database/connection.js";
import {
  assertTokenSafePayload,
  isForbiddenTokenKey,
  redactTokenUnsafeValue
} from "../event-registry.js";
import { projectKey } from "../project-key.js";
import type { EventService } from "./event.service.js";
import type {
  EventRecord,
  GateGuardAssessment,
  HandoffActionKind,
  HandoffStatus,
  JsonRecord,
  SecurityFindingSeverity,
  SecurityScanDomain
} from "../types.js";

export const defaultSecurityScanDomains = [
  "sessions",
  "handoffs",
  "discussions",
  "vault-memory-links",
  "mcp-configs",
  "connector-permissions",
  "dashboard-affordances",
  "owner-token-handling",
  "launch-broker-actions",
  "direct-db-writers",
  "external-action-settings"
] as const satisfies SecurityScanDomain[];

export interface SecurityScanFileSnapshot {
  path: string;
  content: string;
}

export interface SecurityConnectorPermissionSnapshot {
  connector: string;
  permissions: string[];
  approvalRequired?: boolean;
  source?: string | null;
}

export interface SecurityDashboardActionSnapshot {
  kind: string;
  enabled: boolean;
  toolName: string;
  requiredCapability?: string | null;
  requiresOwnerToken?: boolean;
  gateGuard?: GateGuardAssessment | null;
}

export interface SecurityDashboardActionSetSnapshot {
  resourceUid: string;
  resourceType: "handoff" | "launch_request" | "session" | "other";
  actions: SecurityDashboardActionSnapshot[];
}

export interface SecurityScanOptions {
  project: string;
  domains?: SecurityScanDomain[];
  mcpConfigFiles?: SecurityScanFileSnapshot[];
  connectorPermissions?: SecurityConnectorPermissionSnapshot[];
  dashboardActionSets?: SecurityDashboardActionSetSnapshot[];
  sourceFiles?: SecurityScanFileSnapshot[];
  evidencePackVaultMemoryUid?: string | null;
}

export interface SecurityFinding {
  domain: SecurityScanDomain;
  severity: SecurityFindingSeverity;
  findingCode: string;
  findingSummary: string;
  evidence: JsonRecord[];
}

export interface SecurityScanDomainResult {
  domain: SecurityScanDomain;
  checked: true;
  evidenceCount: number;
  findingCount: number;
}

export interface SecurityEvidencePack {
  project: string;
  scanUid: string;
  scannedAt: string;
  summary: {
    totalFindings: number;
    bySeverity: Record<SecurityFindingSeverity, number>;
  };
  domains: SecurityScanDomainResult[];
  findings: SecurityFinding[];
}

export interface SecurityScanReport {
  scanUid: string;
  project: string;
  scannedAt: string;
  domains: SecurityScanDomainResult[];
  findings: SecurityFinding[];
  evidencePack: SecurityEvidencePack;
  evidencePackVaultMemoryUid: string | null;
}

export interface GateGuardHandoffActionContext {
  project: string;
  handoffUid: string;
  actionKind: HandoffActionKind;
  handoffStatus: HandoffStatus;
  actorSessionUid: string;
  actorCapabilities: JsonRecord;
  sourceSessionUid: string | null;
  claimedBySessionUid: string | null;
  vaultMemoryUid: string | null;
  labels: string[];
  queueKey: string;
}

interface SessionScanRow {
  session_uid: string;
  client_type: string;
  project: string;
  workspace_path: string;
  role: string;
  role_profile_id: string | null;
  status: string;
  disconnected_at: string | null;
}

interface HandoffScanRow {
  handoff_uid: string;
  source_project: string;
  target_project: string;
  vault_memory_uid: string | null;
  status: HandoffStatus;
  claimed_by_session_uid: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  labels_json: string;
}

interface EventScanRow {
  event_id: number;
  handoff_uid: string | null;
  session_uid: string | null;
  event_type: string;
  payload_json: string;
}

interface LaunchRequestScanRow {
  launch_request_uid: string;
  status: string;
  broker_session_uid: string | null;
  launched_session_uid: string | null;
  permission_mode: string;
  command_preview: string | null;
  approval_policy_version: string | null;
  requested_capabilities_json: string;
}

const leasedHandoffStatuses = new Set<HandoffStatus>([
  "claimed",
  "in_progress",
  "blocked",
  "awaiting_user",
  "verification_needed"
]);

const dangerousConnectorPermissions = new Set([
  "send_mail",
  "send_email",
  "write",
  "delete",
  "admin",
  "publish",
  "post"
]);

const riskyDashboardActions = new Set([
  "recover",
  "reopen",
  "resolve",
  "release",
  "request_handoff_permission",
  "approve",
  "mark_launching",
  "mark_running",
  "stop",
  "fail",
  "cancel"
]);

const riskyExternalPermissionModes = new Set([
  "danger-full-access",
  "bypass",
  "unrestricted",
  "workspace-write"
]);

export class SecurityScanner {
  constructor(
    private readonly db: CollabDatabase,
    private readonly events: EventService,
    private readonly clock: () => Date = () => new Date()
  ) {}

  scan(options: SecurityScanOptions): SecurityScanReport {
    const scanUid = `sec_scan_${randomUUID()}`;
    const scannedAt = this.clock().toISOString();
    const domains = options.domains ?? [...defaultSecurityScanDomains];
    const findings: SecurityFinding[] = [];
    const domainResults: SecurityScanDomainResult[] = [];

    for (const domain of domains) {
      const before = findings.length;
      const evidenceCount = this.scanDomain(domain, options, findings);
      domainResults.push({
        domain,
        checked: true,
        evidenceCount,
        findingCount: findings.length - before
      });
    }

    const evidencePack: SecurityEvidencePack = {
      project: options.project,
      scanUid,
      scannedAt,
      summary: {
        totalFindings: findings.length,
        bySeverity: this.countBySeverity(findings)
      },
      domains: domainResults,
      findings
    };
    assertTokenSafePayload(evidencePack);

    return {
      scanUid,
      project: options.project,
      scannedAt,
      domains: domainResults,
      findings,
      evidencePack,
      evidencePackVaultMemoryUid: options.evidencePackVaultMemoryUid ?? null
    };
  }

  publishFindings(
    report: SecurityScanReport,
    context: { sessionUid?: string | null; handoffUid?: string | null } = {}
  ): EventRecord[] {
    return report.findings.map((finding) =>
      this.events.recordEvent({
        eventType: "security.finding",
        sessionUid: context.sessionUid ?? null,
        handoffUid: context.handoffUid ?? null,
        payload: {
          project: report.project,
          scanUid: report.scanUid,
          domain: finding.domain,
          severity: finding.severity,
          findingCode: finding.findingCode,
          findingSummary: finding.findingSummary,
          evidenceCount: finding.evidence.length,
          evidencePackVaultMemoryUid: report.evidencePackVaultMemoryUid
        }
      })
    );
  }

  assessHandoffActionRisk(context: GateGuardHandoffActionContext): GateGuardAssessment {
    switch (context.actionKind) {
      case "resolve":
        return {
          required: true,
          riskLevel: "medium",
          reason: "Resolving work closes the handoff lifecycle and should cite concrete completion facts.",
          factsRequired: ["completion evidence", "verification status", "token-safe summary"],
          findingCodes: ["handoff.resolve_requires_evidence"]
        };
      case "recover":
        return {
          required: true,
          riskLevel: "high",
          reason: "Recovery bypasses the claim-owner token and must prove authority and evidence.",
          factsRequired: [
            "recovery authority",
            "evidence Vault memory UID",
            "previous claim owner status",
            "token-safe summary"
          ],
          findingCodes: ["handoff.recover_requires_evidence"]
        };
      case "reopen":
        return {
          required: true,
          riskLevel: "high",
          reason: "Reopening closed work changes completion history and needs a concrete reason.",
          factsRequired: ["reopen reason", "current closed status", "follow-up owner"],
          findingCodes: ["handoff.reopen_requires_reason"]
        };
      case "release":
        return {
          required: true,
          riskLevel: "medium",
          reason: "Releasing work can strand progress unless current state and next ownership are explicit.",
          factsRequired: ["current progress state", "handoff remains actionable", "next owner or inbox route"],
          findingCodes: ["handoff.release_requires_state_check"]
        };
      case "request_handoff_permission":
      case "request_user_confirmation":
        return {
          required: true,
          riskLevel: "medium",
          reason: "Permission-style handoff actions should state the concrete action and authority requested.",
          factsRequired: ["requested capability", "action preview", "reason approval is required"],
          findingCodes: ["handoff.permission_requires_action_preview"]
        };
      default:
        return this.noGateGuardRequired();
    }
  }

  private scanDomain(
    domain: SecurityScanDomain,
    options: SecurityScanOptions,
    findings: SecurityFinding[]
  ): number {
    switch (domain) {
      case "sessions":
        return this.scanSessions(options, findings);
      case "handoffs":
        return this.scanHandoffs(options, findings);
      case "discussions":
        return this.scanDiscussions(options, findings);
      case "vault-memory-links":
        return this.scanVaultMemoryLinks(options, findings);
      case "mcp-configs":
        return this.scanMcpConfigs(options, findings);
      case "connector-permissions":
        return this.scanConnectorPermissions(options, findings);
      case "dashboard-affordances":
        return this.scanDashboardAffordances(options, findings);
      case "owner-token-handling":
        return this.scanOwnerTokenHandling(options, findings);
      case "launch-broker-actions":
        return this.scanLaunchBrokerActions(options, findings);
      case "direct-db-writers":
        return this.scanDirectDbWriters(options, findings);
      case "external-action-settings":
        return this.scanExternalActionSettings(options, findings);
    }
  }

  private scanSessions(options: SecurityScanOptions, findings: SecurityFinding[]): number {
    const rows = this.sessionRows(options.project);
    const activeRows = rows.filter((row) => row.status !== "disconnected" && !row.disconnected_at);
    const byIdentity = new Map<string, SessionScanRow[]>();

    for (const row of activeRows) {
      const identity = [
        row.workspace_path.toLowerCase(),
        row.client_type,
        row.role_profile_id ?? row.role
      ].join("|");
      byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), row]);

      if (!row.role_profile_id) {
        this.addFinding(findings, {
          domain: "sessions",
          severity: "medium",
          findingCode: "sessions.missing_role_profile",
          findingSummary: "Active session is not bound to a canonical role profile.",
          evidence: [{ sessionUid: row.session_uid, role: row.role }]
        });
      }
    }

    for (const duplicateRows of byIdentity.values()) {
      if (duplicateRows.length <= 1) {
        continue;
      }

      this.addFinding(findings, {
        domain: "sessions",
        severity: "high",
        findingCode: "sessions.duplicate_active_identity",
        findingSummary:
          "Multiple active sessions share workspace, client type, and role profile identity.",
        evidence: [
          {
            workspacePath: duplicateRows[0].workspace_path,
            clientType: duplicateRows[0].client_type,
            roleProfileId: duplicateRows[0].role_profile_id ?? duplicateRows[0].role,
            sessionUids: duplicateRows.map((row) => row.session_uid)
          }
        ]
      });
    }

    return rows.length;
  }

  private scanHandoffs(options: SecurityScanOptions, findings: SecurityFinding[]): number {
    const rows = this.handoffRows(options.project);
    for (const row of rows) {
      if (leasedHandoffStatuses.has(row.status) && !row.lease_expires_at) {
        this.addFinding(findings, {
          domain: "handoffs",
          severity: "high",
          findingCode: "handoffs.claimed_without_lease",
          findingSummary: "A claimed or in-progress handoff is missing a lease expiry.",
          evidence: [
            {
              handoffUid: row.handoff_uid,
              status: row.status,
              claimedBySessionUid: row.claimed_by_session_uid
            }
          ]
        });
      }

      if (row.claim_token && !row.claimed_by_session_uid) {
        this.addFinding(findings, {
          domain: "handoffs",
          severity: "critical",
          findingCode: "handoffs.orphaned_claim_token",
          findingSummary: "A handoff has claim-token state without a claim owner.",
          evidence: [{ handoffUid: row.handoff_uid, status: row.status }]
        });
      }
    }

    return rows.length;
  }

  private scanDiscussions(options: SecurityScanOptions, findings: SecurityFinding[]): number {
    const rows = this.db
      .prepare(
        `
        SELECT message_uid, thread_uid, metadata_json
        FROM discussion_messages
        WHERE thread_uid IN (
          SELECT thread_uid
          FROM discussion_threads
          WHERE project_key = ?
        )
        ORDER BY message_uid ASC
      `
      )
      .all(projectKey(options.project)) as Array<{
      message_uid: string;
      thread_uid: string;
      metadata_json: string;
    }>;

    for (const row of rows) {
      const unsafeKeys = this.unsafeKeyPaths(this.safeJson(row.metadata_json));
      if (unsafeKeys.length > 0) {
        this.addFinding(findings, {
          domain: "discussions",
          severity: "high",
          findingCode: "discussions.unsafe_metadata_keys",
          findingSummary: "Discussion message metadata contains token-like keys.",
          evidence: [
            {
              messageUid: row.message_uid,
              threadUid: row.thread_uid,
              unsafeKeys
            }
          ]
        });
      }
    }

    return rows.length;
  }

  private scanVaultMemoryLinks(options: SecurityScanOptions, findings: SecurityFinding[]): number {
    const rows = this.handoffRows(options.project).filter((row) => row.vault_memory_uid);
    for (const row of rows) {
      if (!/^vm_[A-Za-z0-9_-]+$/.test(row.vault_memory_uid ?? "")) {
        this.addFinding(findings, {
          domain: "vault-memory-links",
          severity: "medium",
          findingCode: "vault_memory_link.invalid_uid",
          findingSummary: "A handoff links a Vault memory id that does not match the expected vm_* shape.",
          evidence: [
            {
              handoffUid: row.handoff_uid,
              vaultMemoryUid: row.vault_memory_uid
            }
          ]
        });
      }
    }

    return rows.length;
  }

  private scanMcpConfigs(options: SecurityScanOptions, findings: SecurityFinding[]): number {
    const files = options.mcpConfigFiles ?? [];
    for (const file of files) {
      if (/(invoke-expression|\biex\b|curl\s+[^|]+\|\s*(sh|bash|powershell))/i.test(file.content)) {
        this.addFinding(findings, {
          domain: "mcp-configs",
          severity: "high",
          findingCode: "mcp_config.shell_injection_surface",
          findingSummary: "MCP config contains shell evaluation or pipe-to-shell patterns.",
          evidence: [{ path: file.path }]
        });
      }

      const parsed = this.tryJson(file.content);
      const unsafeKeys = parsed ? this.unsafeKeyPaths(parsed) : [];
      if (unsafeKeys.length > 0) {
        this.addFinding(findings, {
          domain: "mcp-configs",
          severity: "critical",
          findingCode: "mcp_config.token_key_present",
          findingSummary: "MCP config contains token-like key names.",
          evidence: [{ path: file.path, unsafeKeys }]
        });
      }
    }

    return files.length;
  }

  private scanConnectorPermissions(
    options: SecurityScanOptions,
    findings: SecurityFinding[]
  ): number {
    const connectorPermissions = options.connectorPermissions ?? [];
    for (const connector of connectorPermissions) {
      const dangerousPermissions = connector.permissions.filter((permission) =>
        dangerousConnectorPermissions.has(permission.toLowerCase())
      );
      if (dangerousPermissions.length > 0 && connector.approvalRequired === false) {
        this.addFinding(findings, {
          domain: "connector-permissions",
          severity: "high",
          findingCode: "connector.unapproved_external_mutation",
          findingSummary: "Connector mutation permissions are available without an approval requirement.",
          evidence: [
            {
              connector: connector.connector,
              permissions: dangerousPermissions,
              source: connector.source ?? null
            }
          ]
        });
      }
    }

    return connectorPermissions.length;
  }

  private scanDashboardAffordances(
    options: SecurityScanOptions,
    findings: SecurityFinding[]
  ): number {
    const actionSets = options.dashboardActionSets ?? [];
    let actionCount = 0;

    for (const actionSet of actionSets) {
      for (const action of actionSet.actions) {
        actionCount += 1;
        if (!action.enabled) {
          continue;
        }

        const risky =
          riskyDashboardActions.has(action.kind) ||
          riskyDashboardActions.has(action.toolName.replace(/^vault_collab_/, ""));
        if (!risky || action.gateGuard?.required) {
          continue;
        }

        this.addFinding(findings, {
          domain: "dashboard-affordances",
          severity: "high",
          findingCode: "dashboard.risky_action_missing_gateguard",
          findingSummary: "An enabled risky dashboard action is missing GateGuard metadata.",
          evidence: [
            {
              resourceUid: actionSet.resourceUid,
              resourceType: actionSet.resourceType,
              actionKind: action.kind,
              toolName: action.toolName,
              requiredCapability: action.requiredCapability ?? null
            }
          ]
        });
      }
    }

    return actionCount;
  }

  private scanOwnerTokenHandling(
    options: SecurityScanOptions,
    findings: SecurityFinding[]
  ): number {
    const projectSessionUids = new Set(this.sessionRows(options.project).map((row) => row.session_uid));
    const projectHandoffUids = new Set(this.handoffRows(options.project).map((row) => row.handoff_uid));
    const rows = this.db
      .prepare(
        `
        SELECT event_id, handoff_uid, session_uid, event_type, payload_json
        FROM events
        ORDER BY event_id ASC
      `
      )
      .all() as EventScanRow[];
    let checked = 0;

    for (const row of rows) {
      if (
        row.session_uid &&
        !projectSessionUids.has(row.session_uid) &&
        (!row.handoff_uid || !projectHandoffUids.has(row.handoff_uid))
      ) {
        continue;
      }

      checked += 1;
      const payload = this.safeJson(row.payload_json);
      const unsafeKeys = this.unsafeKeyPaths(payload);
      if (unsafeKeys.length === 0) {
        continue;
      }

      this.addFinding(findings, {
        domain: "owner-token-handling",
        severity: "critical",
        findingCode: "owner_token.event_payload",
        findingSummary: "Persisted event payload contains token-like key names.",
        evidence: [
          {
            eventId: row.event_id,
            eventType: row.event_type,
            handoffUid: row.handoff_uid,
            sessionUid: row.session_uid,
            unsafeKeys
          }
        ]
      });
    }

    return checked;
  }

  private scanLaunchBrokerActions(
    options: SecurityScanOptions,
    findings: SecurityFinding[]
  ): number {
    const rows = this.launchRequestRows(options.project);
    for (const row of rows) {
      if (["launching", "running"].includes(row.status) && !row.broker_session_uid) {
        this.addFinding(findings, {
          domain: "launch-broker-actions",
          severity: "high",
          findingCode: "launch_broker.missing_broker_session",
          findingSummary: "Launch request is in broker-controlled state without a broker session.",
          evidence: [
            {
              launchRequestUid: row.launch_request_uid,
              status: row.status
            }
          ]
        });
      }

      if (row.status === "running" && !row.launched_session_uid) {
        this.addFinding(findings, {
          domain: "launch-broker-actions",
          severity: "high",
          findingCode: "launch_broker.running_without_launched_session",
          findingSummary: "Launch request is running without a linked launched session.",
          evidence: [{ launchRequestUid: row.launch_request_uid }]
        });
      }
    }

    return rows.length;
  }

  private scanDirectDbWriters(options: SecurityScanOptions, findings: SecurityFinding[]): number {
    const files = options.sourceFiles ?? [];
    for (const file of files) {
      const normalizedPath = file.path.replace(/\\/g, "/");
      if (normalizedPath === "src/database/connection.ts" || normalizedPath.includes("/tests/")) {
        continue;
      }

      if (/better-sqlite3|new\s+Database\s*\(/.test(file.content)) {
        this.addFinding(findings, {
          domain: "direct-db-writers",
          severity: "critical",
          findingCode: "direct_db_writer.outside_connection_boundary",
          findingSummary: "Source file opens SQLite directly outside the database connection boundary.",
          evidence: [{ path: file.path }]
        });
      }
    }

    return files.length;
  }

  private scanExternalActionSettings(
    options: SecurityScanOptions,
    findings: SecurityFinding[]
  ): number {
    const rows = this.launchRequestRows(options.project);
    for (const row of rows) {
      const permissionMode = row.permission_mode.toLowerCase();
      if (
        riskyExternalPermissionModes.has(permissionMode) &&
        (!row.approval_policy_version || /ask-for-approval\s+never/i.test(row.command_preview ?? ""))
      ) {
        this.addFinding(findings, {
          domain: "external-action-settings",
          severity: "high",
          findingCode: "external_action.unguarded_permission_mode",
          findingSummary: "Launch request uses a broad external-action permission mode without a clear approval policy.",
          evidence: [
            {
              launchRequestUid: row.launch_request_uid,
              permissionMode: row.permission_mode,
              approvalPolicyVersion: row.approval_policy_version,
              requestedCapabilities: this.safeJsonArray(row.requested_capabilities_json)
            }
          ]
        });
      }
    }

    return rows.length;
  }

  private sessionRows(project: string): SessionScanRow[] {
    return this.db
      .prepare(
        `
        SELECT session_uid, client_type, project, workspace_path, role, role_profile_id, status, disconnected_at
        FROM sessions
        WHERE project_key = ?
        ORDER BY created_at ASC, session_uid ASC
      `
      )
      .all(projectKey(project)) as SessionScanRow[];
  }

  private handoffRows(project: string): HandoffScanRow[] {
    return this.db
      .prepare(
        `
        SELECT handoff_uid,
               source_project,
               target_project,
               vault_memory_uid,
               status,
               claimed_by_session_uid,
               claim_token,
               lease_expires_at,
               labels_json
        FROM handoffs
        WHERE source_project_key = ? OR target_project_key = ?
        ORDER BY created_at ASC, handoff_uid ASC
      `
      )
      .all(projectKey(project), projectKey(project)) as HandoffScanRow[];
  }

  private launchRequestRows(project: string): LaunchRequestScanRow[] {
    return this.db
      .prepare(
        `
        SELECT launch_request_uid,
               status,
               broker_session_uid,
               launched_session_uid,
               permission_mode,
               command_preview,
               approval_policy_version,
               requested_capabilities_json
        FROM launch_requests
        WHERE project_key = ?
        ORDER BY created_at ASC, launch_request_uid ASC
      `
      )
      .all(projectKey(project)) as LaunchRequestScanRow[];
  }

  private addFinding(
    findings: SecurityFinding[],
    finding: Omit<SecurityFinding, "evidence"> & { evidence: JsonRecord[] }
  ): void {
    const sanitizedEvidence = finding.evidence.map((evidence) =>
      redactTokenUnsafeValue(evidence)
    ) as JsonRecord[];
    const sanitizedFinding: SecurityFinding = {
      ...finding,
      evidence: sanitizedEvidence
    };
    assertTokenSafePayload(sanitizedFinding);
    findings.push(sanitizedFinding);
  }

  private unsafeKeyPaths(value: unknown, path = "payload"): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => this.unsafeKeyPaths(item, `${path}[${index}]`));
    }

    if (!this.isRecord(value)) {
      return [];
    }

    const paths: string[] = [];
    for (const [key, nestedValue] of Object.entries(value)) {
      const nestedPath = `${path}.${key}`;
      if (isForbiddenTokenKey(key)) {
        paths.push(nestedPath);
      }
      paths.push(...this.unsafeKeyPaths(nestedValue, nestedPath));
    }
    return paths;
  }

  private safeJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  private safeJsonArray(value: string): unknown[] {
    const parsed = this.safeJson(value);
    return Array.isArray(parsed) ? parsed : [];
  }

  private tryJson(value: string): unknown | null {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private countBySeverity(findings: SecurityFinding[]): Record<SecurityFindingSeverity, number> {
    return findings.reduce(
      (counts, finding) => {
        counts[finding.severity] += 1;
        return counts;
      },
      {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0
      }
    );
  }

  private noGateGuardRequired(): GateGuardAssessment {
    return {
      required: false,
      riskLevel: "low",
      reason: "No GateGuard fact check is required for this handoff action.",
      factsRequired: [],
      findingCodes: []
    };
  }

  private isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
