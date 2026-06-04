import { z } from "zod";
import { isForbiddenTokenKey } from "../event-registry.js";
import { projectKey } from "../project-key.js";
import {
  SessionAdapterType,
  type JsonRecord,
  type VaultCollabSessionSnapshotV1
} from "../types.js";

const snapshotSchemaVersion = "vault_collab.session.v1";
const riskLevels = ["low", "medium", "high", "critical", "unknown"] as const;
const sessionStates = [
  "idle",
  "working",
  "blocked",
  "awaiting_user",
  "awaiting_verification",
  "complete",
  "disconnected",
  "unknown"
] as const;
const handoffStatuses = [
  "available",
  "claimed",
  "in_progress",
  "blocked",
  "awaiting_user",
  "verification_needed",
  "resolved",
  "abandoned",
  "stale",
  "unknown"
] as const;
const adapterTypes = [
  SessionAdapterType.Native,
  SessionAdapterType.AdapterBacked,
  SessionAdapterType.InstructionBacked
] as const;

const isoTimestamp = z.string().datetime({ offset: true });
const nullableIsoTimestamp = isoTimestamp.nullable();
const shortString = z.string().min(1).max(120);
const displayString = z.string().min(1).max(300);
const longString = z.string().min(1).max(1000);
const nonNegativeInteger = z.number().finite().int().min(0);
const nonNegativeNumber = z.number().finite().min(0);

const snapshotSchema = z
  .object({
    schemaVersion: z.literal(snapshotSchemaVersion),
    adapterId: shortString,
    sessionUid: z.string().min(1).max(100).regex(/^vc_sess_/),
    project: z.string().min(1).max(200),
    workspace: z
      .object({
        path: z.string().min(1).max(1000),
        projectKey: z.string().min(1).max(200).nullable().optional()
      })
      .strict(),
    state: z.enum(sessionStates),
    context: z
      .object({
        model: shortString.nullable(),
        provider: shortString.nullable(),
        tokensUsed: nonNegativeInteger.nullable(),
        tokensRemaining: nonNegativeInteger.nullable(),
        compactionRisk: z.enum(riskLevels)
      })
      .strict(),
    active_handoffs: z
      .array(
        z
          .object({
            handoffUid: z.string().min(1).max(100),
            status: z.enum(handoffStatuses),
            progressNote: longString.nullable(),
            claimedAt: nullableIsoTimestamp
          })
          .strict()
      )
      .max(20),
    progress: z
      .object({
        currentTask: displayString.nullable(),
        percentComplete: z.number().finite().min(0).max(100).nullable(),
        blockers: z.array(displayString).max(10)
      })
      .strict(),
    cost: z
      .object({
        estimatedUSD: nonNegativeNumber.nullable(),
        tokensTotal: nonNegativeInteger.nullable()
      })
      .strict(),
    risk: z
      .object({
        level: z.enum(riskLevels),
        reasons: z.array(displayString).max(10)
      })
      .strict(),
    tool_grants: z
      .array(
        z
          .object({
            toolName: shortString,
            scope: shortString,
            grantedAt: nullableIsoTimestamp
          })
          .strict()
      )
      .max(50),
    capabilities: z
      .object({
        canMutateHandoffs: z.boolean(),
        canPublishHandoffs: z.boolean(),
        canSendMessages: z.boolean(),
        adapterType: z.enum(adapterTypes)
      })
      .strict(),
    sync_cursor: z
      .object({
        lastEventId: nonNegativeInteger.nullable(),
        lastHeartbeatAt: nullableIsoTimestamp
      })
      .strict()
  })
  .strict();

export interface ValidateSessionSnapshotOptions {
  sessionUid: string;
  project: string;
}

export function validateVaultCollabSessionSnapshot(
  value: unknown,
  options: ValidateSessionSnapshotOptions
): VaultCollabSessionSnapshotV1 {
  assertNoTokenLikeKeys(value, "snapshot");
  const result = snapshotSchema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "snapshot";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Invalid session snapshot: ${message}`);
  }

  const snapshot = result.data;
  if (snapshot.sessionUid !== options.sessionUid) {
    throw new Error("Invalid session snapshot: sessionUid must match the reported session");
  }

  if (projectKey(snapshot.project) !== projectKey(options.project)) {
    throw new Error("Invalid session snapshot: project must match the reported session");
  }

  return snapshot;
}

function assertNoTokenLikeKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoTokenLikeKeys(item, `${path}[${index}]`));
    return;
  }

  if (!isPlainRecord(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (isForbiddenTokenKey(key)) {
      throw new Error(`Invalid session snapshot: token-like key is not allowed at ${nestedPath}`);
    }
    assertNoTokenLikeKeys(nestedValue, nestedPath);
  }
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
