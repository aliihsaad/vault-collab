import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { DiscussionService } from "../src/services/discussion.service.js";
import { EventService } from "../src/services/event.service.js";
import { HandoffService } from "../src/services/handoff.service.js";
import { LaunchRequestService } from "../src/services/launch-request.service.js";
import {
  defaultSecurityScanDomains,
  SecurityScanner
} from "../src/services/security-scanner.service.js";
import { SessionService } from "../src/services/session.service.js";
import type { HandoffActionAffordance, RegisteredSession } from "../src/types.js";
import { seedTestProjects } from "./project-fixture.js";

const workspacePath = "C:\\workspace\\vault-collab";

describe("SecurityScanner", () => {
  let db: CollabDatabase;
  let now: Date;
  let events: EventService;
  let launchRequests: LaunchRequestService;
  let sessions: SessionService;
  let handoffs: HandoffService;
  let discussions: DiscussionService;
  let scanner: SecurityScanner;
  let coordinator: RegisteredSession;
  let worker: RegisteredSession;

  beforeEach(() => {
    now = new Date("2026-06-03T09:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    seedTestProjects(db);
    events = new EventService(db, clock);
    launchRequests = new LaunchRequestService(db, events, clock);
    sessions = new SessionService(db, events, launchRequests, clock);
    scanner = new SecurityScanner(db, events, clock);
    handoffs = new HandoffService(db, events, clock, scanner);
    discussions = new DiscussionService(db, events, clock);

    coordinator = sessions.registerSession({
      displayName: "Coordinator",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "coordinator",
      capabilities: {
        launchRequests: true
      }
    });
    worker = sessions.registerSession({
      displayName: "Worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      capabilities: {}
    });
  });

  afterEach(() => {
    db.close();
  });

  it("scans every Phase 4 domain into a token-safe evidence pack", () => {
    const duplicate = sessions.registerSession({
      displayName: "Duplicate Worker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      capabilities: {}
    });
    const handoff = handoffs.publishHandoff({
      shortPrompt: "Unsafe linked handoff",
      sourceProject: "Vault Collab",
      targetProject: "Vault Collab",
      sourceSessionUid: coordinator.sessionUid,
      vaultMemoryUid: "not-a-vault-memory-id"
    });
    handoffs.claimHandoff(handoff.handoffUid, worker.sessionUid, worker.sessionToken);
    db.prepare("UPDATE handoffs SET lease_expires_at = NULL WHERE handoff_uid = ?").run(
      handoff.handoffUid
    );
    const thread = discussions.createThread({
      project: "Vault Collab",
      handoffUid: handoff.handoffUid,
      title: "Unsafe metadata",
      createdBySessionUid: coordinator.sessionUid,
      sessionToken: coordinator.sessionToken
    });
    db.prepare(
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
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
    `
    ).run(
      "vc_msg_unsafe",
      thread.threadUid,
      coordinator.sessionUid,
      "note",
      "Metadata contains an unsafe key.",
      JSON.stringify({ sessionToken: coordinator.sessionToken }),
      now.toISOString()
    );
    db.prepare(
      `
      INSERT INTO events (handoff_uid, session_uid, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
    ).run(
      handoff.handoffUid,
      worker.sessionUid,
      "legacy.unsafe",
      JSON.stringify({ ownerToken: worker.sessionToken }),
      now.toISOString()
    );
    const launchRequest = launchRequests.createLaunchRequest({
      requestedBySessionUid: coordinator.sessionUid,
      sessionToken: coordinator.sessionToken,
      provider: "codex",
      model: "gpt-5-codex",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      initialInstructions: "Run external work.",
      permissionMode: "danger-full-access",
      commandPreview: "codex --ask-for-approval never",
      requestedCapabilities: ["filesystem-write"]
    });
    db.prepare(
      "UPDATE launch_requests SET status = ?, broker_session_uid = NULL WHERE launch_request_uid = ?"
    ).run("launching", launchRequest.launchRequestUid);

    const report = scanner.scan({
      project: "Vault Collab",
      mcpConfigFiles: [
        {
          path: ".mcp.json",
          content: JSON.stringify({
            mcpServers: {
              risky: {
                command: "powershell",
                args: ["-Command", "Invoke-Expression $env:PAYLOAD"]
              }
            }
          })
        }
      ],
      connectorPermissions: [
        {
          connector: "gmail",
          permissions: ["send_mail"],
          approvalRequired: false
        }
      ],
      dashboardActionSets: [
        {
          resourceUid: handoff.handoffUid,
          resourceType: "handoff",
          actions: [
            {
              kind: "recover",
              enabled: true,
              reason: "Recovery-capable session can recover-resolve this handoff with evidence.",
              toolName: "vault_collab_recover_handoff",
              requiredCapability: "handoffRecovery",
              requiresOwnerToken: true,
              requiresProgressNote: false,
              requiresQuestion: false,
              requiresReason: true,
              requiresSummary: true,
              requiresEvidenceVaultMemoryUid: true
            } as HandoffActionAffordance
          ]
        }
      ],
      sourceFiles: [
        {
          path: "src/bypass.ts",
          content: 'import Database from "better-sqlite3"; new Database("vault-collab.db");'
        }
      ]
    });

    expect(report.domains.map((domain) => domain.domain)).toEqual(defaultSecurityScanDomains);
    expect(new Set(report.findings.map((finding) => finding.domain))).toEqual(
      new Set(defaultSecurityScanDomains)
    );
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "sessions",
          findingCode: "sessions.duplicate_active_identity",
          severity: "high"
        }),
        expect.objectContaining({
          domain: "dashboard-affordances",
          findingCode: "dashboard.risky_action_missing_gateguard"
        }),
        expect.objectContaining({
          domain: "owner-token-handling",
          findingCode: "owner_token.event_payload"
        })
      ])
    );
    expect(report.evidencePack.summary.totalFindings).toBe(report.findings.length);
    expect(JSON.stringify(report)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(report)).not.toContain(coordinator.sessionToken);
    expect(JSON.stringify(report)).not.toContain(duplicate.sessionToken);
  });

  it("publishes token-safe security finding events for coordinator review", () => {
    db.prepare(
      `
      INSERT INTO events (handoff_uid, session_uid, event_type, payload_json, created_at)
      VALUES (NULL, ?, ?, ?, ?)
    `
    ).run(
      worker.sessionUid,
      "legacy.unsafe",
      JSON.stringify({ sessionToken: worker.sessionToken }),
      now.toISOString()
    );
    const report = scanner.scan({ project: "Vault Collab" });

    const published = scanner.publishFindings(report, {
      sessionUid: coordinator.sessionUid
    });

    expect(published.map((event) => event.eventType)).toEqual(["security.finding"]);
    expect(published[0]).toMatchObject({
      sessionUid: coordinator.sessionUid,
      payload: {
        project: "Vault Collab",
        scanUid: report.scanUid,
        domain: "owner-token-handling",
        severity: "critical",
        findingCode: "owner_token.event_payload",
        evidenceCount: 1
      }
    });
    expect(JSON.stringify(published)).not.toContain(worker.sessionToken);
    expect(JSON.stringify(published)).not.toContain(coordinator.sessionToken);
  });
});
