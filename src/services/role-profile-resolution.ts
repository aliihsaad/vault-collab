import type { CollabDatabase } from "../database/connection.js";

export function resolveRoleProfileIdFromDb(
  db: CollabDatabase,
  roleOrAlias: string | null | undefined
): string | null {
  const normalized = roleOrAlias?.trim();
  if (!normalized) {
    return null;
  }

  const direct = db
    .prepare(
      `
      SELECT role_profile_id
      FROM role_profiles
      WHERE role_profile_id = ?
        AND status = 'active'
    `
    )
    .get(normalized) as { role_profile_id: string } | undefined;
  if (direct) {
    return direct.role_profile_id;
  }

  const aliased = db
    .prepare(
      `
      SELECT role_profile_id
      FROM role_profile_aliases
      WHERE alias = ?
    `
    )
    .get(normalized.toLowerCase()) as { role_profile_id: string } | undefined;

  if (!aliased) {
    return null;
  }

  const targetExists = db
    .prepare(
      `
      SELECT 1 AS exists_flag
      FROM role_profiles
      WHERE role_profile_id = ?
        AND status = 'active'
    `
    )
    .get(aliased.role_profile_id) as { exists_flag: number } | undefined;

  return targetExists ? aliased.role_profile_id : null;
}

export function firstSuggestedRoleProfileIdForLabels(
  db: CollabDatabase,
  labels: string[]
): string | null {
  const normalizedLabels = labels.map((label) => label.trim().toLowerCase()).filter(Boolean);
  if (normalizedLabels.length === 0) {
    return null;
  }

  const placeholders = normalizedLabels.map(() => "?").join(", ");
  const route = db
    .prepare(
      `
      SELECT role_profile_id
      FROM role_label_routes
      WHERE label IN (${placeholders})
      ORDER BY priority ASC, blocks_completion DESC, label ASC, role_profile_id ASC
      LIMIT 1
    `
    )
    .get(...normalizedLabels) as { role_profile_id: string } | undefined;

  return route?.role_profile_id ?? null;
}
