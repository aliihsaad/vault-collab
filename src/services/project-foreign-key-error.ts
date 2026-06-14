import type { CollabDatabase } from "../database/connection.js";

export function missingProjectSlugMessage(projectSlug: string): string {
  return `Project '${projectSlug.trim()}' does not exist. Use vault_list_projects to see valid project slugs.`;
}

export function rethrowProjectForeignKeyError(
  db: CollabDatabase,
  error: unknown,
  projectSlugs: string[]
): never {
  if (isSqliteForeignKeyConstraint(error)) {
    throw new Error(missingProjectSlugMessage(firstMissingProjectSlug(db, projectSlugs)));
  }

  throw error;
}

export function missingProjectSlugWarnings(
  db: CollabDatabase,
  projectSlugs: string[]
): string[] {
  const missingSlugs = new Set<string>();
  for (const projectSlug of projectSlugs) {
    const slug = projectSlug.trim();
    if (slug !== "" && !projectSlugExists(db, slug)) {
      missingSlugs.add(slug);
    }
  }

  return Array.from(missingSlugs).map((slug) => missingProjectSlugMessage(slug));
}

function firstMissingProjectSlug(db: CollabDatabase, projectSlugs: string[]): string {
  for (const projectSlug of projectSlugs) {
    const slug = projectSlug.trim();
    if (slug !== "" && !projectSlugExists(db, slug)) {
      return slug;
    }
  }

  return projectSlugs[0]?.trim() || "unknown";
}

function projectSlugExists(db: CollabDatabase, projectSlug: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 FROM projects WHERE slug = ? LIMIT 1")
      .get(projectSlug) as { "1": number } | undefined;

    return row !== undefined;
  } catch {
    return false;
  }
}

function isSqliteForeignKeyConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY"
  );
}
