import { projectKey } from "../project-key.js";
import type { CollabDatabase } from "../database/connection.js";

/**
 * Resolve a caller-supplied project name to the canonical projects.slug,
 * creating the project row when no existing slug matches. Matching order:
 * exact slug, normalized project key, then a key-equivalent existing slug.
 */
export function resolveOrCreateProjectSlug(db: CollabDatabase, project: string): string {
  const trimmed = project.trim();
  const selectSlug = db.prepare("SELECT slug FROM projects WHERE slug = ? LIMIT 1");

  const exact = selectSlug.get(trimmed) as { slug: string } | undefined;
  if (exact) {
    return exact.slug;
  }

  const key = projectKey(project);
  const byKey = selectSlug.get(key) as { slug: string } | undefined;
  if (byKey) {
    return byKey.slug;
  }

  const rows = db.prepare("SELECT slug FROM projects").all() as Array<{ slug: string }>;
  for (const row of rows) {
    if (projectKey(row.slug) === key) {
      return row.slug;
    }
  }

  db.prepare("INSERT INTO projects (slug, name) VALUES (?, ?)").run(key, trimmed || key);
  return key;
}
