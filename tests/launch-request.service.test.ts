import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";
import { EventService } from "../src/services/event.service.js";
import { LaunchRequestService } from "../src/services/launch-request.service.js";
import { SessionService } from "../src/services/session.service.js";
import type { RegisteredSession } from "../src/types.js";

const workspacePath = "C:\\workspace\\vault-collab";

describe("LaunchRequestService", () => {
  let db: CollabDatabase;
  let now: Date;
  let events: EventService;
  let sessions: SessionService;
  let service: LaunchRequestService;
  let requester: RegisteredSession;
  let unauthorized: RegisteredSession;
  let approver: RegisteredSession;
  let broker: RegisteredSession;
  let secondBroker: RegisteredSession;

  beforeEach(() => {
    now = new Date("2026-05-30T09:00:00.000Z");
    const clock = () => now;
    db = createCollabDatabase(":memory:");
    events = new EventService(db, clock);
    sessions = new SessionService(db, events, clock);
    service = new LaunchRequestService(db, events, clock);

    requester = sessions.registerSession({
      displayName: "Operator",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        launchRequests: true
      }
    });
    unauthorized = sessions.registerSession({
      displayName: "Observer",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });
    approver = sessions.registerSession({
      displayName: "Launch Approver",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        launchApproval: true
      }
    });
    broker = sessions.registerSession({
      displayName: "Local Broker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        launchBroker: true
      }
    });
    secondBroker = sessions.registerSession({
      displayName: "Backup Broker",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        launchBroker: true
      }
    });
  });

  afterEach(() => {
    db.close();
  });

  it("creates token-safe durable launch requests and routes them by project key", () => {
    const request = service.createLaunchRequest({
      requestedBySessionUid: requester.sessionUid,
      sessionToken: requester.sessionToken,
      provider: "codex",
      model: "gpt-5-codex",
      effortLevel: "high",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      initialInstructions: "Implement the launch broker foundation.",
      permissionMode: "workspace-write",
      commandPreview: "codex --model gpt-5-codex",
      requestedCapabilities: ["filesystem-write"],
      approvalPolicyVersion: "cockpit-v2.0",
      metadata: {
        source: "cockpit"
      }
    });

    expect(request.launchRequestUid).toMatch(/^vc_launch_/);
    expect(request).toMatchObject({
      provider: "codex",
      model: "gpt-5-codex",
      effortLevel: "high",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      initialInstructions: "Implement the launch broker foundation.",
      permissionMode: "workspace-write",
      commandPreview: "codex --model gpt-5-codex",
      requestedCapabilities: ["filesystem-write"],
      approvalPolicyVersion: "cockpit-v2.0",
      approvalSnapshot: null,
      status: "requested",
      requestedBySessionUid: requester.sessionUid,
      approvedBySessionUid: null,
      brokerSessionUid: null,
      launchedSessionUid: null,
      statusDetail: null,
      metadata: {
        source: "cockpit"
      },
      createdAt: "2026-05-30T09:00:00.000Z",
      updatedAt: "2026-05-30T09:00:00.000Z"
    });
    expect(request).not.toHaveProperty("sessionToken");

    expect(() =>
      service.createLaunchRequest({
        requestedBySessionUid: unauthorized.sessionUid,
        sessionToken: unauthorized.sessionToken,
        provider: "codex",
        model: "gpt-5-codex",
        project: "Vault Collab",
        workspacePath,
        initialInstructions: "Should fail.",
        permissionMode: "read-only"
      })
    ).toThrow(/launch requests capability/i);

    db.prepare("UPDATE launch_requests SET project = ? WHERE launch_request_uid = ?").run(
      "Renamed Display Label",
      request.launchRequestUid
    );

    expect(service.listLaunchRequests({ project: "vault-collab" })[0]?.launchRequestUid).toBe(
      request.launchRequestUid
    );

    const launchEvents = events
      .listEvents({ sessionUid: requester.sessionUid, eventType: "launch_request.requested" })
      .filter((event) => event.payload.launchRequestUid === request.launchRequestUid);

    expect(launchEvents).toHaveLength(1);
    expect(JSON.stringify(launchEvents)).not.toContain(requester.sessionToken);
  });

  it("requires approval capability and broker capability for launch lifecycle transitions", () => {
    const request = service.createLaunchRequest({
      requestedBySessionUid: requester.sessionUid,
      sessionToken: requester.sessionToken,
      provider: "codex",
      model: "gpt-5-codex",
      effortLevel: "medium",
      project: "Vault Collab",
      workspacePath,
      role: "reviewer",
      initialInstructions: "Review the launch broker API.",
      permissionMode: "read-only",
      commandPreview: "codex --ask-for-approval on-request",
      requestedCapabilities: ["filesystem-read"],
      approvalPolicyVersion: "cockpit-v2.0"
    });

    expect(() =>
      service.approveLaunchRequest(
        request.launchRequestUid,
        requester.sessionUid,
        requester.sessionToken,
        "Requester should not self-approve without capability."
      )
    ).toThrow(/launch approval capability/i);

    now = new Date("2026-05-30T09:01:00.000Z");
    const approved = service.approveLaunchRequest(
      request.launchRequestUid,
      approver.sessionUid,
      approver.sessionToken,
      "Approved for local broker pickup."
    );

    expect(approved).toMatchObject({
      status: "approved",
      approvedBySessionUid: approver.sessionUid,
      statusDetail: "Approved for local broker pickup.",
      approvedAt: "2026-05-30T09:01:00.000Z",
      approvalSnapshot: {
        provider: "codex",
        model: "gpt-5-codex",
        workspacePath,
        permissionMode: "read-only",
        commandPreview: "codex --ask-for-approval on-request",
        requestedCapabilities: ["filesystem-read"],
        approvalPolicyVersion: "cockpit-v2.0"
      }
    });
    expect(() =>
      service.markLaunchRequestLaunching(
        approved.launchRequestUid,
        approver.sessionUid,
        approver.sessionToken,
        "Approver is not the broker."
      )
    ).toThrow(/launch broker capability/i);

    now = new Date("2026-05-30T09:02:00.000Z");
    const launching = service.markLaunchRequestLaunching(
      approved.launchRequestUid,
      broker.sessionUid,
      broker.sessionToken,
      "Broker accepted approved request."
    );

    expect(launching).toMatchObject({
      status: "launching",
      brokerSessionUid: broker.sessionUid,
      statusDetail: "Broker accepted approved request.",
      startedAt: "2026-05-30T09:02:00.000Z"
    });

    const launched = sessions.registerSession({
      displayName: "Spawned Codex",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {
        launchedBy: launching.launchRequestUid
      }
    });
    expect(() =>
      service.markLaunchRequestRunning(
        launching.launchRequestUid,
        secondBroker.sessionUid,
        secondBroker.sessionToken,
        launched.sessionUid,
        "Backup broker should not complete another broker's launch."
      )
    ).toThrow(/same broker/i);

    now = new Date("2026-05-30T09:03:00.000Z");
    const running = service.markLaunchRequestRunning(
      launching.launchRequestUid,
      broker.sessionUid,
      broker.sessionToken,
      launched.sessionUid,
      "Launched session registered."
    );

    expect(running).toMatchObject({
      status: "running",
      brokerSessionUid: broker.sessionUid,
      launchedSessionUid: launched.sessionUid,
      statusDetail: "Launched session registered.",
      completedAt: null
    });
    expect(() =>
      service.markLaunchRequestStopped(
        running.launchRequestUid,
        secondBroker.sessionUid,
        secondBroker.sessionToken,
        "Backup broker should not stop another broker's launch.",
        0
      )
    ).toThrow(/same broker/i);
    now = new Date("2026-05-30T09:04:00.000Z");
    const stopped = service.markLaunchRequestStopped(
      running.launchRequestUid,
      broker.sessionUid,
      broker.sessionToken,
      "User stopped the managed worker.",
      0
    );

    expect(stopped).toMatchObject({
      status: "stopped",
      brokerSessionUid: broker.sessionUid,
      launchedSessionUid: launched.sessionUid,
      statusDetail: "User stopped the managed worker.",
      completedAt: "2026-05-30T09:04:00.000Z",
      metadata: {
        stopped: {
          detail: "User stopped the managed worker.",
          exitCode: 0,
          brokerSessionUid: broker.sessionUid,
          stoppedAt: "2026-05-30T09:04:00.000Z"
        }
      }
    });
    expect(() =>
      service.rejectLaunchRequest(
        stopped.launchRequestUid,
        approver.sessionUid,
        approver.sessionToken,
        "Too late to reject."
      )
    ).toThrow(/requested/i);
  });

  it("describes owner-token-aware launch request actions for dashboards", () => {
    const request = service.createLaunchRequest({
      requestedBySessionUid: requester.sessionUid,
      sessionToken: requester.sessionToken,
      provider: "codex",
      model: "gpt-5-codex",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      initialInstructions: "Expose safe dashboard actions.",
      permissionMode: "workspace-write"
    });

    const requesterActions = service.getLaunchRequestActions(
      request.launchRequestUid,
      requester.sessionUid,
      requester.sessionToken
    );
    expect(requesterActions.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "approve",
          enabled: false,
          requiredCapability: "launchApproval"
        }),
        expect.objectContaining({
          kind: "cancel",
          enabled: true,
          toolName: "vault_collab_cancel_launch_request"
        })
      ])
    );

    const approverActions = service.getLaunchRequestActions(
      request.launchRequestUid,
      approver.sessionUid,
      approver.sessionToken
    );
    expect(approverActions.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "approve", enabled: true }),
        expect.objectContaining({ kind: "reject", enabled: true }),
        expect.objectContaining({ kind: "cancel", enabled: true })
      ])
    );
    expect(JSON.stringify(approverActions)).not.toContain(approver.sessionToken);

    service.approveLaunchRequest(
      request.launchRequestUid,
      approver.sessionUid,
      approver.sessionToken,
      "Approved for broker pickup."
    );
    const approvedBrokerActions = service.getLaunchRequestActions(
      request.launchRequestUid,
      broker.sessionUid,
      broker.sessionToken
    );
    expect(approvedBrokerActions.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "mark_launching", enabled: true }),
        expect.objectContaining({ kind: "mark_running", enabled: false }),
        expect.objectContaining({ kind: "stop", enabled: false }),
        expect.objectContaining({ kind: "fail", enabled: true })
      ])
    );

    service.markLaunchRequestLaunching(
      request.launchRequestUid,
      broker.sessionUid,
      broker.sessionToken,
      "Broker accepted request."
    );
    const sameBrokerActions = service.getLaunchRequestActions(
      request.launchRequestUid,
      broker.sessionUid,
      broker.sessionToken
    );
    const secondBrokerActions = service.getLaunchRequestActions(
      request.launchRequestUid,
      secondBroker.sessionUid,
      secondBroker.sessionToken
    );

    expect(sameBrokerActions.actions).toContainEqual(
      expect.objectContaining({
        kind: "mark_running",
        enabled: true,
        requiresLaunchedSessionUid: true
      })
    );
    expect(sameBrokerActions.actions).toContainEqual(
      expect.objectContaining({
        kind: "stop",
        enabled: true,
        toolName: "vault_collab_mark_launch_request_stopped"
      })
    );
    expect(secondBrokerActions.actions).toContainEqual(
      expect.objectContaining({
        kind: "mark_running",
        enabled: false,
        reason: expect.stringMatching(/same broker/i)
      })
    );
    expect(secondBrokerActions.actions).toContainEqual(
      expect.objectContaining({
        kind: "stop",
        enabled: false,
        reason: expect.stringMatching(/same broker/i)
      })
    );
  });

  it("rejects and cancels requests without allowing later execution", () => {
    const rejectedRequest = service.createLaunchRequest({
      requestedBySessionUid: requester.sessionUid,
      sessionToken: requester.sessionToken,
      provider: "codex",
      model: "gpt-5-codex",
      project: "Vault Collab",
      workspacePath,
      role: "reviewer",
      initialInstructions: "Review only.",
      permissionMode: "read-only"
    });

    const rejected = service.rejectLaunchRequest(
      rejectedRequest.launchRequestUid,
      approver.sessionUid,
      approver.sessionToken,
      "Needs a tighter brief."
    );

    expect(rejected).toMatchObject({
      status: "rejected",
      rejectedBySessionUid: approver.sessionUid,
      statusDetail: "Needs a tighter brief."
    });
    expect(() =>
      service.approveLaunchRequest(
        rejected.launchRequestUid,
        approver.sessionUid,
        approver.sessionToken,
        "Cannot revive rejected request."
      )
    ).toThrow(/requested/i);

    const cancellable = service.createLaunchRequest({
      requestedBySessionUid: requester.sessionUid,
      sessionToken: requester.sessionToken,
      provider: "codex",
      model: "gpt-5-codex",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      initialInstructions: "Cancel before approval.",
      permissionMode: "read-only"
    });
    const cancelled = service.cancelLaunchRequest(
      cancellable.launchRequestUid,
      requester.sessionUid,
      requester.sessionToken,
      "Operator changed scope."
    );

    expect(cancelled).toMatchObject({
      status: "cancelled",
      statusDetail: "Operator changed scope."
    });
    expect(() =>
      service.markLaunchRequestLaunching(
        cancelled.launchRequestUid,
        broker.sessionUid,
        broker.sessionToken,
        "Cannot launch cancelled request."
      )
    ).toThrow(/approved/i);
  });

  it("requires launched sessions to match the approved request handshake", () => {
    const request = service.createLaunchRequest({
      requestedBySessionUid: requester.sessionUid,
      sessionToken: requester.sessionToken,
      provider: "codex",
      model: "gpt-5-codex",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      initialInstructions: "Launch with handshake.",
      permissionMode: "read-only"
    });
    service.approveLaunchRequest(
      request.launchRequestUid,
      approver.sessionUid,
      approver.sessionToken,
      "Approved."
    );
    service.markLaunchRequestLaunching(
      request.launchRequestUid,
      broker.sessionUid,
      broker.sessionToken,
      "Broker accepted request."
    );
    const wrongWorkspace = sessions.registerSession({
      displayName: "Wrong workspace",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath: "C:\\workspace\\other",
      capabilities: {
        launchedBy: request.launchRequestUid
      }
    });
    const missingLaunchUid = sessions.registerSession({
      displayName: "Missing launch uid",
      clientType: "codex",
      project: "Vault Collab",
      workspacePath,
      capabilities: {}
    });

    expect(() =>
      service.markLaunchRequestRunning(
        request.launchRequestUid,
        broker.sessionUid,
        broker.sessionToken,
        wrongWorkspace.sessionUid,
        "Wrong workspace."
      )
    ).toThrow(/workspace/i);
    expect(() =>
      service.markLaunchRequestRunning(
        request.launchRequestUid,
        broker.sessionUid,
        broker.sessionToken,
        missingLaunchUid.sessionUid,
        "Missing launchedBy."
      )
    ).toThrow(/launchedBy/i);
  });

  it("returns launch request detail with token-safe lifecycle events", () => {
    const request = service.createLaunchRequest({
      requestedBySessionUid: requester.sessionUid,
      sessionToken: requester.sessionToken,
      provider: "codex",
      model: "gpt-5-codex",
      project: "Vault Collab",
      workspacePath,
      role: "implementer",
      initialInstructions: "Inspect detail.",
      permissionMode: "read-only"
    });
    service.approveLaunchRequest(
      request.launchRequestUid,
      approver.sessionUid,
      approver.sessionToken,
      "Approved for detail inspection."
    );

    const detail = service.getLaunchRequestDetail(request.launchRequestUid);

    expect(detail).toMatchObject({
      launchRequest: {
        launchRequestUid: request.launchRequestUid,
        status: "approved"
      },
      events: [
        expect.objectContaining({ eventType: "launch_request.requested" }),
        expect.objectContaining({ eventType: "launch_request.approved" })
      ]
    });
    expect(JSON.stringify(detail)).not.toContain(requester.sessionToken);
    expect(JSON.stringify(detail)).not.toContain(approver.sessionToken);
  });
});
