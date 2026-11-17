import type Database from "better-sqlite3";
import type { SqliteFormat } from "../../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../../platform/sqlite-sql.js";
import { decodeStrictSessionJson, SessionV2Error } from "../../../session/v2/values.js";
import { canonicalId } from "../../../api/parse.js";

const steps = loadSqliteSequence(new URL("./sqlite/", import.meta.url));
const [baseline, ...upgrades] = steps;
const schemas = sqliteSchemaSnapshots(steps);
const definition = (sql: string): string => {
  const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[^\s]/g);
  if (tokens === null) throw new Error("An empty SQLite definition cannot identify a known format.");
  const meaningful = tokens.filter(token => !token.startsWith("--") && !token.startsWith("/*"));
  if (meaningful.at(-1) === ";") meaningful.pop();
  return meaningful.map(token => token.startsWith("'") ? token : token.toLowerCase()).join("\0");
};
const validateSchema = (db: Database.Database, expected: readonly SqliteSchemaObject[]): undefined => {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
  if (objects.length !== expected.length || objects.some((object, index) => {
    const known = expected[index]!;
    return object.type !== known.type || object.name !== known.name || object.sql === null || known.sql === null || definition(object.sql) !== definition(known.sql);
  })) throw new Error("The Web execution SQLite schema is incompatible with its known state format.");
};

const backfillTerminationInventory = (db: Database.Database): void => {
  const owner = db.prepare(`INSERT INTO termination_owners(identity,server_origin,owner_user_id,worker_id,project_id,task_id,claim_id,worktree_id,provider,status,cleanup,session_id,execution_id,controller_id,generation)
    SELECT identity, json_extract(data, '$.serverOrigin'), json_extract(data, '$.userId'), json_extract(data, '$.workerId'), json_extract(data, '$.projectId'), json_extract(data, '$.taskId'), json_extract(data, '$.claimId'), json_extract(data, '$.worktreeId'), json_extract(data, '$.configuration.agent'), json_extract(data, '$.status'), json_extract(data, '$.cleanup.kind'), json_extract(data, '$.webExecution.sessionId'), json_extract(data, '$.webExecution.executionId'), json_extract(data, '$.webExecution.controllerId'), json_extract(data, '$.webExecution.executionGeneration') FROM executions WHERE identity=?`);
  const launch = db.prepare(`INSERT INTO termination_launches(identity,generation,execution_id,launch_id,controller_id,controller_instance_id,session_id,submission)
    SELECT identity, json_extract(data, '$.webExecution.executionGeneration'), json_extract(data, '$.webExecution.executionId'), json_extract(data, '$.webExecution.launchId'), json_extract(data, '$.webExecution.controllerId'), json_extract(data, '$.webExecution.controllerInstanceId'), json_extract(data, '$.webExecution.sessionId'), json_extract(data, '$.webExecution.launchSubmission') FROM executions WHERE identity=? AND json_type(data, '$.webExecution')='object'`);
  const strip = db.prepare("SELECT json_type(?, '$.webExecution.initialPrompt') AS kind, json_remove(?, '$.webExecution.initialPrompt') AS value");
  for (const row of db.prepare("SELECT identity,data FROM executions").all() as { identity: string; data: string }[]) {
    let value: unknown;
    try {
      let metadata = row.data;
      for (;;) {
        const result = strip.get(metadata, metadata) as { kind: string | null; value: string };
        if (result.kind === null) break;
        if (result.value === metadata) throw new SessionV2Error();
        metadata = result.value;
      }
      value = decodeStrictSessionJson(metadata, Number.POSITIVE_INFINITY);
    }
    catch (error) {
      if (error instanceof SessionV2Error || error instanceof Error && "code" in error && error.code === "SQLITE_ERROR" && /malformed json/i.test(error.message)) continue;
      throw error;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const data = value as Record<string, unknown>, ids = [data.projectId, data.taskId, data.claimId];
    if (ids.some(id => typeof id !== "string" || canonicalId(id) !== id) || ids.join("/") !== row.identity) continue;
    try { db.transaction(() => { owner.run(row.identity); launch.run(row.identity); })(); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT"))) throw error;
    }
  }
};

export const webExecutionStoreFormat: SqliteFormat = {
  name: "Web execution state",
  baseline: { version: baseline.version, create: db => { db.exec(baseline.sql); } },
  migrations: upgrades.map(step => ({ toVersion: step.version, up: (db: Database.Database): undefined => { db.exec(step.sql); if (step.version === 5) backfillTerminationInventory(db); } })),
  validateVersioned: (db, version) => {
    const expected = schemas.get(version);
    if (expected === undefined) throw new Error("Unsupported Web execution SQLite version.");
    validateSchema(db, expected);
  },
};
