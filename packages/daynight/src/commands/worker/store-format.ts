import type Database from "better-sqlite3";
import type { SqliteFormat } from "../../platform/sqlite-format.js";

const projects = `CREATE TABLE projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  repo_url TEXT NOT NULL,
  local_path TEXT NOT NULL
) STRICT`;
const tasks = `CREATE TABLE tasks (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'done')),
  agent TEXT NOT NULL CHECK(agent IN ('copilot', 'codex', 'claude')),
  session_id TEXT,
  agent_control_mode TEXT NOT NULL DEFAULT 'herdr' CHECK(agent_control_mode IN ('herdr', 'web')),
  PRIMARY KEY(project_id, task_id, claim_id)
) STRICT`;
const sixColumnTasks = `CREATE TABLE tasks (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'done')),
  agent TEXT NOT NULL CHECK(agent IN ('copilot', 'codex')),
  session_id TEXT,
  PRIMARY KEY(project_id, task_id, claim_id)
) STRICT`;
const activeIndex = "CREATE UNIQUE INDEX tasks_one_active_per_task ON tasks(project_id, task_id) WHERE status = 'active'";
const definition = (sql: string): string => {
  const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[^\s]/g);
  if (tokens === null) throw new Error("An empty SQLite definition cannot identify a known format.");
  const meaningful = tokens.filter(token => !token.startsWith("--") && !token.startsWith("/*"));
  if (meaningful.at(-1) === ";") meaningful.pop();
  return meaningful.map(token => token.startsWith("'") ? token : token.toLowerCase()).join("\0");
};
type SchemaObject = { type: string; name: string; sql: string | null };
const incompatible = (): never => { throw new Error("The Worker SQLite schema is incompatible with its known minimal index formats."); };

const validate = (db: Database.Database, allowSixColumns: boolean): "six" | "seven" => {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SchemaObject[];
  if (objects.length !== 3) return incompatible();
  const expected = new Map([["projects", projects], ["tasks_one_active_per_task", activeIndex]]);
  for (const [name, sql] of expected) {
    const object = objects.find(value => value.name === name);
    if (object === undefined || object.type !== (name === "projects" ? "table" : "index") || object.sql === null || definition(object.sql) !== definition(sql)) return incompatible();
  }
  const task = objects.find(value => value.name === "tasks");
  if (task === undefined || task.type !== "table" || task.sql === null) return incompatible();
  const sql = definition(task.sql);
  if (sql === definition(tasks)) return "seven";
  if (allowSixColumns && sql === definition(sixColumnTasks)) return "six";
  return incompatible();
};

export const workerStoreFormat: SqliteFormat = {
  name: "Worker state",
  baseline: {
    version: 5,
    create: db => { db.exec(`${projects}; ${tasks}; ${activeIndex};`); },
  },
  unversioned: {
    validate: db => { validate(db, true); },
    adopt: db => {
      if (validate(db, true) === "six") {
        db.exec("ALTER TABLE tasks RENAME TO legacy_tasks; DROP INDEX tasks_one_active_per_task;");
        db.exec(`${tasks}; ${activeIndex};`);
        db.exec("INSERT INTO tasks(project_id, task_id, claim_id, status, agent, session_id) SELECT project_id, task_id, claim_id, status, agent, session_id FROM legacy_tasks; DROP TABLE legacy_tasks;");
      }
    },
  },
  migrations: [],
  validateVersioned: (db, version) => {
    if (version !== 5) return incompatible();
    validate(db, false);
  },
};
