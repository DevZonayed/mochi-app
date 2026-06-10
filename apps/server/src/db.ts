import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Built-in node:sqlite (stable in Node 24) — no native build step.
export type Db = InstanceType<typeof DatabaseSync>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  budgetCap REAL NOT NULL DEFAULT 200,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT 'claude-code',
  instructions TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'blue',
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  phase TEXT NOT NULL DEFAULT '',
  progress INTEGER NOT NULL DEFAULT 0,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  effort TEXT NOT NULL DEFAULT 'balanced',
  cost REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  projectId TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'review',
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt INTEGER NOT NULL,
  resolvedAt INTEGER
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  projectId TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL DEFAULT 'daily',
  enabled INTEGER NOT NULL DEFAULT 1,
  nextRun INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  kind TEXT NOT NULL DEFAULT 'builtin',
  version TEXT NOT NULL DEFAULT '1.0.0',
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  icon TEXT NOT NULL DEFAULT 'spark',
  engine TEXT NOT NULL DEFAULT 'claude-code',
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspaceId);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(projectId);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
`;

export function openDb(path = process.env.DB_PATH || ':memory:'): Db {
  if (path !== ':memory:') {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* dir exists */
    }
  }
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
