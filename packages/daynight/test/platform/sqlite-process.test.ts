import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const temporary = fileURLToPath(new URL("../../../../.tmp/sqlite-process-tests/", import.meta.url));
const directories: string[] = [];
const children = new Set<ReturnType<typeof launch>>();
const access = new URL("../../dist/platform/sqlite-access.js", import.meta.url).href;
const fixture = () => {
  mkdirSync(temporary, { recursive: true }); const directory = mkdtempSync(path.join(temporary, "migration-")); directories.push(directory);
  const file = path.join(directory, "state.sqlite"), release = path.join(directory, "release");
  const db = new Database(file);
  db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT; CREATE TABLE migration_runs(version INTEGER PRIMARY KEY) STRICT; INSERT INTO records VALUES(1,'{\"state\":\"old\"}'); PRAGMA user_version=1;"); db.close();
  return { file, release };
};
const childSource = `
import Database from 'better-sqlite3';
import { existsSync, writeSync } from 'node:fs';
import { openSqliteDatabase } from ${JSON.stringify(access)};
const [mode,file,release] = process.argv.slice(1);
const barrier = new Int32Array(new SharedArrayBuffer(4));
const mark = (value) => writeSync(1,value+'\\n');
const format = {
 name:'process test', baseline:{version:1,create:(db)=>{ db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT; CREATE TABLE migration_runs(version INTEGER PRIMARY KEY) STRICT;'); }},
 migrations:[{toVersion:2,up:(db)=>{
  db.exec(\"ALTER TABLE records ADD COLUMN extra TEXT; INSERT INTO migration_runs VALUES(2); UPDATE records SET data=json_set(data,'$.state','new');\");
  if(mode==='crash'||mode==='hold') {
   mark('inside');
   while(mode==='crash'||!existsSync(release)) Atomics.wait(barrier,0,0,20);
  }
 }}],
 validateVersioned:(db,version)=>{
  const columns=db.pragma('table_info(records)').map(value=>value.name).join(',');
  if(columns!==(version===1?'id,data':'id,data,extra')) throw Error('Unexpected layout');
 }
};
try {
 const db=openSqliteDatabase({file,format,allowEmpty:false,timeoutMs:10000,onMigration:(event)=>{if(event.kind==='started')mark('attempt');}});
 mark('committed');
 if(mode==='after-commit') while(true) Atomics.wait(barrier,0,0,20);
 mark(JSON.stringify({version:db.pragma('user_version',{simple:true}),runs:db.prepare('SELECT count(*) AS n FROM migration_runs').get().n}));
 db.close();
} catch(error) { writeSync(2,String(error.stack)); process.exitCode=1; }
`;
const launch = (mode: string, file: string, release: string) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource, mode, file, release], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", (value: Buffer) => { output += value.toString(); }); child.stderr.on("data", (value: Buffer) => { errors += value.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  const waitFor = (text: string): Promise<void> => new Promise((resolve, reject) => {
    if (output.includes(`${text}\n`)) { resolve(); return; }
    const cleanup = () => { clearTimeout(timer); child.stdout.off("data", check); child.off("exit", exit); };
    const check = () => { if (output.includes(`${text}\n`)) { cleanup(); resolve(); } };
    const exit = () => { cleanup(); reject(new Error(`Child exited before ${text}: ${errors}\n${output}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Child did not reach ${text}: ${errors}\n${output}`)); }, 10000);
    child.stdout.on("data", check); child.once("exit", exit); check();
  });
  const result = () => { const line = output.split("\n").find(value => value.startsWith("{")); if (line === undefined) throw new Error(`Missing child result: ${errors}\n${output}`); return JSON.parse(line) as { version: number; runs: number }; };
  return { child, exited, waitFor, result, errors: () => errors };
};
afterEach(async () => {
  for (const item of children) { if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill("SIGKILL"); await item.exited; }
  children.clear(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const snapshot = (file: string) => { const db = new Database(file); try { return { version: db.pragma("user_version", { simple: true }), columns: (db.pragma("table_info(records)") as { name: string }[]).map(row => row.name), rows: db.prepare("SELECT id,data FROM records").all(), runs: db.prepare("SELECT * FROM migration_runs").all() }; } finally { db.close(); } };

describe("SQLite migration process boundaries", () => {
  it("recovers the complete old schema, JSON and version after termination inside a step", async () => {
    const { file, release } = fixture(), item = launch("crash", file, release); children.add(item);
    await item.waitFor("inside"); item.child.kill("SIGKILL"); await item.exited;
    expect(snapshot(file)).toEqual({ version: 1, columns: ["id", "data"], rows: [{ id: 1, data: '{"state":"old"}' }], runs: [] });
  }, 15000);
  it("recovers the complete new schema and data after termination following commit", async () => {
    const { file, release } = fixture(), item = launch("after-commit", file, release); children.add(item);
    await item.waitFor("committed"); item.child.kill("SIGKILL"); await item.exited;
    expect(snapshot(file)).toEqual({ version: 2, columns: ["id", "data", "extra"], rows: [{ id: 1, data: '{"state":"new"}' }], runs: [{ version: 2 }] });
  }, 15000);
  it("rechecks the version after a competing writer commits and applies each step once", async () => {
    const { file, release } = fixture(), first = launch("hold", file, release); children.add(first); await first.waitFor("inside");
    const second = launch("contender", file, release); children.add(second); await second.waitFor("attempt");
    writeFileSync(release, "continue");
    expect(await first.exited).toEqual({ code: 0, signal: null }); expect(await second.exited).toEqual({ code: 0, signal: null });
    expect(first.result()).toEqual({ version: 2, runs: 1 }); expect(second.result()).toEqual({ version: 2, runs: 1 });
    expect(snapshot(file).runs).toEqual([{ version: 2 }]);
  }, 15000);
});
