import type { CollabDatabase } from "../database/connection.js";

export function missingVaultProjectSlugMessage(projectSlug: string): string {
  return `Project '${projectSlug.trim()}' does not exist in vault-memory. Create it first or use an existing project slug.`;
}

export function assertVaultProjectSlugExists(
  db: CollabDatabase,
  projectSlug: string
): void {
  if (!hasVaultMemoryProjectsTable(db)) {
    return;
  }

  if (!vaultProjectSlugExists(db, projectSlug)) {
    throw new Error(missingVaultProjectSlugMessage(projectSlug));
  }
}

export function missingVaultProjectSlugWarnings(
  db: CollabDatabase,
  projectSlugs: string[]
): string[] {
  if (!hasVaultMemoryProjectsTable(db)) {
    return [];
  }

  const missingSlugs = new Set<string>();
  for (const projectSlug of projectSlugs) {
    const slug = projectSlug.trim();
    if (!vaultProjectSlugExists(db, slug)) {
      missingSlugs.add(slug);
    }
  }

  return Array.from(missingSlugs).map((slug) => missingVaultProjectSlugMessage(slug));
}

function hasVaultMemoryProjectsTable(db: CollabDatabase): boolean {
  const row = db
    .prepare(
      `
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'projects'
      LIMIT 1
    `
    )
    .get() as { "1": number } | undefined;

  return row !== undefined;
}

function vaultProjectSlugExists(db: CollabDatabase, projectSlug: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM projects WHERE slug = ? LIMIT 1")
    .get(projectSlug.trim()) as { "1": number } | undefined;

  return row !== undefined;
}
