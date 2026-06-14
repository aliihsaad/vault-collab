import { createCollabDatabase, type CollabDatabase } from "../src/database/connection.js";

export const defaultTestProjectSlugs = [
  "Vault Collab",
  "vault-collab",
  "vault_collab",
  "the-vault",
  "Codex-brain",
  "codex-brain",
  "Source Project",
  "Target Project",
  "Other Project",
  "Renamed Display Label",
  "Renamed Source Label",
  "Renamed Target Label"
];

export function seedTestProjects(
  db: CollabDatabase,
  slugs: string[] = defaultTestProjectSlugs
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);

  const insert = db.prepare("INSERT OR IGNORE INTO projects (slug, name) VALUES (?, ?)");
  for (const slug of slugs) {
    insert.run(slug, slug);
  }
}

export function seedTestProjectsAtPath(
  dbPath: string,
  slugs: string[] = defaultTestProjectSlugs
): void {
  const db = createCollabDatabase(dbPath);
  try {
    seedTestProjects(db, slugs);
  } finally {
    db.close();
  }
}
