import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Built-in node:sqlite (Node 22.5+, stable in 24+) — no native build step.
export type Db = InstanceType<typeof DatabaseSync>;

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}
