import Database from "better-sqlite3";
import { applySchema, seedRoleProfiles } from "./schema.js";

export type CollabDatabase = Database.Database;

export function createCollabDatabase(location = ":memory:"): CollabDatabase {
  const db = new Database(location);
  db.pragma("foreign_keys = ON");
  applySchema(db);
  seedRoleProfiles(db);
  return db;
}
