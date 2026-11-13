import Database from "better-sqlite3";
import sharp from "sharp";
import { mkdtemp, mkdir, rm, unlink, stat, readFile, writeFile, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { uploadStoppedControllerArchive } from "../../../src/commands/controller/archive-upload.js";
import * as archives from "../../../src/commands/controller/archive-upload.js";
import * as resourceFiles from "../../../src/commands/controller/content/resource-files.js";
import * as sqliteAccess from "../../../src/platform/sqlite-access.js";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
import { archiveTestReceiver } from "./archive-test-transport.js";
import { currentSqliteVersion, upgradeSqlite } from "../../../src/platform/sqlite-format.js";
import { controllerJournalWriteOptions } from "../../../src/commands/controller/storage-preparation.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { parseTimelineEntry } from "../../../src/session/protocol.js";
const errorCauses = (error: unknown): Error[] => {
  const values: Error[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) values.push(cause);
  return values;
};
const roots: string[] = [], readers: Database.Database[] = [];
const pending = (file: string, sessionId: string) => {
  const db = new Database(file, { readonly: true }); readers.push(db);
  return openSessionContent(file, sessionId, db, { read: action => db.transaction(action).deferred(), assertWrite: () => { throw new Error("Read only."); } });
};
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); for (const db of readers.splice(0)) if (db.open) db.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const fixturePlatforms = process.platform === "win32" ? ["host"] : ["host", "win32"];
const selectFixturePlatform = (value: string): void => { if (value === "win32") Object.defineProperty(process, "platform", { ...platform, value: "win32" }); };
const completeFixtureStop = async (journalPath: string, ticket: ControllerLaunchTicket, stateDirectory: string): Promise<void> => {
  if (process.platform !== "win32") return;
  const db = new Database(journalPath);
  try {
    const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
    const snapshot = JSON.parse(row.snapshot);
    db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...snapshot, lifecycle: "stopping", nativeStopped: false, stoppedAt: null, controllerProcess: { pid: 2_000_000_000, parentPid: 1, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` } }));
  } finally { db.close(); }
  const jobLease = {} as ControllerJobLease;
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  try {
    const stopped = await recordStoppedControllerGeneration(journalPath, ticket, { stateDirectory, jobLease });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(stopped.controllerProcess, stopped.nativeProcesses, undefined, jobLease);
    expect(stopped.windowsJobStopProof).toMatchObject({ version: 1 });
  } finally { confirm.mockRestore(); }
};
const fixture = async ({ finalizeStop = true }: { finalizeStop?: boolean } = {}) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/archive-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: path.join(home, "removed-worktree"), nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed task", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const journalPath = path.join(home, "journal.sqlite");
  const store = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true });
  const entry = { entryId: randomUUID(), revision: "1", kind: "assistant_message" as const, content: [{ type: "text" as const, text: "durable answer" }] };
  store.projectTimeline(entry); const sourceThrough=store.getLastSourceSequence(); store.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() }); store.close();
  if (finalizeStop) await completeFixtureStop(journalPath, ticket, home);
  return { home, ticket, journalPath, entry, sourceThrough, completeStop: () => completeFixtureStop(journalPath, ticket, home) };
};
const migrate = (db: Database.Database, stateDirectory: string): void => {
  const permit = acquireControllerStoragePermit(db.name);
  try {
    const { format } = controllerJournalWriteOptions(db.name, permit, stateDirectory);
    db.transaction(() => upgradeSqlite(db, format)).immediate();
  } finally { permit.release(); }
};
const emptyStatus = { state: "unavailable", sha256: null, byteLength: null, errorCode: null };
test.each(fixturePlatforms)("retries confirmed archive busy responses with the same request until the upload completes (%s)", async fixturePlatform => {
  selectFixturePlatform(fixturePlatform);
  const f = await fixture(), bodies: string[] = [];
  const receiver = archiveTestReceiver({ bodies, sourceThrough: f.sourceThrough });
  const attempts = new Map<string, { body: unknown; count: number }>();
  const request: typeof fetch = async (input, init) => {
    const key = `${init?.method} ${input}`, previous = attempts.get(key);
    const body = typeof init?.body === "string" ? init.body : init?.body ? Buffer.from(init.body as Uint8Array) : undefined;
    if (!previous) {
      attempts.set(key, { body, count: 1 });
      return Response.json({ error: { code: "resource_busy", message: "Archive slot occupied." } }, { status: 429, headers: { "Retry-After": "0" } });
    }
    expect(body).toEqual(previous.body);
    previous.count++;
    return receiver.request(input, init);
  };
  expect((await uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).state).toBe("ready");
  expect(bodies).toHaveLength(1);
  expect([...attempts.keys()]).toEqual(expect.arrayContaining([
    expect.stringContaining("POST "), expect.stringContaining("/source-tail"), expect.stringContaining("/prepare"),
    expect.stringContaining("/seal"), expect.stringContaining("PUT "), expect.stringContaining("/content"),
  ]));
  expect([...attempts.values()].every(value => value.count >= 2)).toBe(true);
});

test.each([[429, "resource_busy", 9], [429, "rate_limited", 1], [503, "resource_busy", 1], [403, "forbidden", 1]] as const)(
  "bounds archive retries and preserves HTTP %s / %s", async (status, code, count) => {
    const f = await fixture();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code } }, { status, headers: { "Retry-After": "0" } }));
    await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toMatchObject({ status, code });
    expect(request).toHaveBeenCalledTimes(count);
  },
);

const archiveClock = () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  // Node's native AbortSignal clock is separate from the controllable JS timer clock.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Deadline exceeded.", "TimeoutError")), ms);
    return controller.signal;
  });
};

test.each([
  { retryAfter: null, random: 0, expectedMs: 500 },
  { retryAfter: "invalid", random: 0.99999, expectedMs: 5000 },
  { retryAfter: "7", random: 0, expectedMs: 7000 },
  { retryAfter: "Thu, 01 Jan 2026 00:00:09 GMT", random: 0, expectedMs: 9000 },
])("archive busy waits for Retry-After or bounded jitter: $retryAfter / $expectedMs", async ({ retryAfter, random, expectedMs }) => {
  const f = await fixture();
  archiveClock();
  vi.spyOn(Math, "random").mockReturnValue(random);
  const receiver = archiveTestReceiver({ bodies: [], sourceThrough: f.sourceThrough });
  let first = true;
  const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    if (!first) return receiver.request(input, init);
    first = false;
    return Response.json({ error: { code: "resource_busy" } }, { status: 429, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } });
  });
  const result = uploadStoppedControllerArchive({ ...f, serverToken: "test", request });
  const joined = Promise.allSettled([result]);
  try {
    await vi.advanceTimersByTimeAsync(expectedMs - 1);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).state).toBe("ready");
    expect(request.mock.calls.length).toBeGreaterThan(1);
  } finally { await vi.runAllTimersAsync(); await joined; }
});

test("archive busy keeps its error identity when the shared 60 second budget expires", async () => {
  const f = await fixture();
  archiveClock();
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: "resource_busy" } }, { status: 429, headers: { "Retry-After": "120" } }));
  const result = uploadStoppedControllerArchive({ ...f, serverToken: "test", request });
  const failed = expect(result).rejects.toMatchObject({ status: 429, code: "resource_busy" });
  const joined = Promise.allSettled([result, failed]);
  try {
    await vi.advanceTimersByTimeAsync(59_999);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(request).toHaveBeenCalledOnce();
  } finally { await vi.runAllTimersAsync(); await joined; }
});

test("cancelling an archive busy wait prevents another request", async () => {
  const f = await fixture(), controller = new AbortController();
  archiveClock();
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: "resource_busy" } }, { status: 429, headers: { "Retry-After": "5" } }));
  const result = uploadStoppedControllerArchive({ ...f, serverToken: "test", request, signal: controller.signal });
  const reason = new Error("Worker stopping.");
  const failed = expect(result).rejects.toBe(reason);
  const joined = Promise.allSettled([result, failed]);
  try {
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(reason);
    await failed;
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledOnce();
  } finally { controller.abort(reason); await vi.runAllTimersAsync(); await joined; }
});

test.each(["history", "content"])("exhausted %s busy retries retain the original error without a reconciliation request", async stage => {
  const f = await fixture(), receiver = archiveTestReceiver({ bodies: [], sourceThrough: f.sourceThrough });
  let busyAttempts = 0;
  const request: typeof fetch = async (input, init) => {
    if (init?.method === "PUT" && (stage === "history" ? String(input).includes("/prepare/history/") : String(input).endsWith("/content"))) {
      busyAttempts++;
      return Response.json({ error: { code: "resource_busy" } }, { status: 429, headers: { "Retry-After": "0" } });
    }
    if (busyAttempts === 9) throw new Error("An explicit busy response has no unknown result to reconcile.");
    return receiver.request(input, init);
  };
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toMatchObject({ status: 429, code: "resource_busy" });
  expect(busyAttempts).toBe(9);
});

test("archive requests share the same round deadline across upload stages", async () => {
  const f = await fixture(), receiver = archiveTestReceiver({ bodies: [], sourceThrough: f.sourceThrough });
  archiveClock();
  const refused = new Set<string>();
  const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (!refused.has(url) && (url.endsWith("/archive") || url.endsWith("/source-tail"))) {
      refused.add(url);
      return Response.json({ error: { code: "resource_busy" } }, { status: 429, headers: { "Retry-After": "40" } });
    }
    return receiver.request(input, init);
  });
  const result = uploadStoppedControllerArchive({ ...f, serverToken: "test", request });
  const failed = expect(result).rejects.toMatchObject({ status: 429, code: "resource_busy" });
  const joined = Promise.allSettled([result, failed]);
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    expect(request.mock.calls.map(([,init]) => init?.method)).toEqual(["GET", "GET", "POST"]);
  } finally { await vi.runAllTimersAsync(); await joined; }
});

test.each(["archive_incomplete", "projection_gap"] as const)("rejects %s before reading pending content and preserves source bytes", async code => {
  const f = await fixture(), db = new Database(f.journalPath);
  db.prepare("UPDATE execution SET archive_incomplete=?,projection_gap=?").run(code === "archive_incomplete" ? 1 : 0, code === "projection_gap" ? "Native history was lost." : null);
  db.prepare("UPDATE timeline_entries SET value=? WHERE id=?").run("unreadable SQL content", f.entry.entryId); db.close();
  const before = await readFile(f.journalPath), request = vi.fn<typeof fetch>();
  for (let i = 0; i < 3; i++) await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toMatchObject({ name: "ArchiveRepairRequiredError", code });
  expect(request).not.toHaveBeenCalled();
  expect(await readFile(f.journalPath)).toEqual(before);
  const current = new Database(f.journalPath, { readonly: true });
  try { expect(current.prepare("SELECT value FROM timeline_entries WHERE id=?").get(f.entry.entryId)).toEqual({ value: "unreadable SQL content" }); } finally { current.close(); }
});

test.each(["archive_incomplete", "projection_gap"] as const)("probes a stopped source without mutating its journal or pending inventory: %s", async code => {
  const f = await fixture(), db = new Database(f.journalPath);
  db.prepare("UPDATE execution SET archive_incomplete=?,projection_gap=?").run(code === "archive_incomplete" ? 1 : 0, code === "projection_gap" ? "Native history was lost." : null); db.close();
  const before = await readFile(f.journalPath);
  expect(await archives.probeStoppedControllerArchive(f)).toEqual({ kind: "blocked", code });
  expect(await readFile(f.journalPath)).toEqual(before);
  await expect(archives.probeStoppedControllerArchive({ ...f, ticket: { ...f.ticket, executionGeneration: "2" } })).rejects.toThrow("original stopped");
  const reason = new Error("probe cancelled");
  await expect(archives.probeStoppedControllerArchive({ ...f, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  const edit = new Database(f.journalPath); edit.exec("UPDATE execution SET archive_incomplete=0,projection_gap='Recovered pending timeline requires full relay resynchronization.'"); edit.close();
  expect(await archives.probeStoppedControllerArchive(f)).toEqual({ kind: "complete" });
});

test.each(["current", "legacy", "mismatch"] as const)("a repair probe admits only original receipt reconciliation: %s", async variant => {
  const f = await fixture(), db = new Database(f.journalPath);
  db.exec("UPDATE execution SET archive_incomplete=1,projection_gap=NULL"); db.close();
  const receipt = { state: "ready", sha256: "1".repeat(64), byteLength: "72", errorCode: null, ...(variant === "legacy" ? {} : { schemaVersion: 3, completeness: "complete" }) };
  const remote = variant === "legacy" ? { ...receipt, schemaVersion: 3, completeness: "complete", sha256: "2".repeat(64), byteLength: "96", migration: { migrationId: randomUUID(), sourceSha256: receipt.sha256, sourceByteLength: receipt.byteLength } } : { ...receipt, sha256: variant === "mismatch" ? "3".repeat(64) : receipt.sha256 };
  const receiptPath = `${f.journalPath}.archive-receipt-${f.ticket.executionGeneration}.json`;
  await writeFile(`${f.journalPath}.archive-receipt-2.json`, JSON.stringify(receipt));
  expect(await archives.probeStoppedControllerArchive(f)).toEqual({ kind: "blocked", code: "archive_incomplete" });
  await writeFile(receiptPath, JSON.stringify(receipt));
  await rm(`${f.journalPath}.pending-content`, { recursive: true });
  expect(await archives.probeStoppedControllerArchive(f)).toEqual({ kind: "attempt" });
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ archive: remote }));
  const result = uploadStoppedControllerArchive({ ...f, serverToken: "test", request });
  if (variant === "mismatch") { await expect(result).rejects.toThrow("differs"); expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt); }
  else expect(await result).toEqual(remote);
  expect(request.mock.calls.map(([,init]) => init?.method)).toEqual(["GET"]);
  const inspect = new Database(f.journalPath, { readonly: true });
  try { expect(inspect.prepare("SELECT archive_incomplete FROM execution").get()).toEqual({ archive_incomplete: 1 }); } finally { inspect.close(); }
});
test.each(["original", "source-hash", "source-length", "missing-relation"])("reconciles a confirmed legacy receipt only through its persisted migration: %s", async variant => {
  const f = await fixture();
  const receiptPath = `${f.journalPath}.archive-receipt-${f.ticket.executionGeneration}.json`;
  const receipt = { state: "ready", sha256: "1".repeat(64), byteLength: "72", errorCode: null };
  await writeFile(receiptPath, JSON.stringify(receipt));
  const migration = { migrationId: randomUUID(), sourceSha256: variant === "source-hash" ? "3".repeat(64) : receipt.sha256, sourceByteLength: variant === "source-length" ? "73" : receipt.byteLength };
  const current = { ...receipt, schemaVersion: 3, completeness: "complete", sha256: "2".repeat(64), byteLength: "96", ...(variant === "missing-relation" ? {} : { migration }) };
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ archive: current }));
  const result = uploadStoppedControllerArchive({ ...f, serverToken: "test", request });
  if (variant === "original") {
    expect(await result).toEqual(current);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(current);
    await rm(`${f.journalPath}.pending-content`, { recursive: true });
    expect(await uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).toEqual(current);
  } else {
    await expect(result).rejects.toThrow("Server archive differs");
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
  }
  expect(request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});
test("uploads a schema3 manifest and separately hashed timeline without a native resume", async () => {
 const f=await fixture(),bodies:string[]=[],calls:string[]=[];
 const receiver=archiveTestReceiver({bodies,sourceThrough:f.sourceThrough,onRequest:(method,path)=>calls.push(`${method} ${path}`)});
 const options={...f,serverToken:"test",request:receiver.request};
 expect((await uploadStoppedControllerArchive(options)).state).toBe("ready");
 const journal=new Database(f.journalPath,{readonly:true});try{const checkpoint=journal.prepare("SELECT value FROM image_runtime_state WHERE key='archive_history_checkpoint'").get() as {value:string};expect(JSON.parse(checkpoint.value)).toMatchObject({sourceThrough:f.sourceThrough,timelineRevision:"1"});expect(journal.prepare("SELECT CAST(last_acknowledged AS TEXT) AS ack FROM execution").get()).toEqual({ack:f.sourceThrough})}finally{journal.close()}
 const manifest=JSON.parse(bodies[0]!);expect(manifest.schemaVersion).toBe(3);expect(manifest).not.toHaveProperty("entries");expect(receiver.entries(bodies[0]!)).toEqual([{...f.entry,entrySeq:"1"}]);
 await rm(`${f.journalPath}.pending-content`,{recursive:true});
 const count=calls.length;await uploadStoppedControllerArchive(options);expect(calls.slice(count)).toEqual([expect.stringContaining("GET ")]);
});
test("a committed schema3 archive with a lost local receipt recovers through its unchanged durable intent", async () => {
  const f = await fixture(), bodies: string[] = [], calls: { method: string; path: string }[] = [];
  const receiver = archiveTestReceiver({ bodies, sourceThrough: f.sourceThrough, onRequest: (method, path) => calls.push({ method, path }) });
  const options = { ...f, serverToken: "test", request: receiver.request };
  const committed = await uploadStoppedControllerArchive(options);
  const receiptPath = `${f.journalPath}.archive-receipt-${f.ticket.executionGeneration}.json`;
  const intentPath = `${f.journalPath}.archive-intent-${f.ticket.executionGeneration}.json`;
  const intentBytes = await readFile(intentPath, "utf8"), intent = JSON.parse(intentBytes);
  const fileIds = [...receiver.files.keys()].sort(), manifest = bodies[0]!;
  expect(fileIds).toEqual([intent.history.fileId, intent.timeline.fileId].sort());
  expect(JSON.parse(manifest).timeline.fileId).toBe(intent.timeline.fileId);
  expect(committed.sha256).toBe(createHash("sha256").update(manifest).digest("hex"));
  await unlink(receiptPath);
  await expect(stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  const count = calls.length;
  expect(await uploadStoppedControllerArchive(options)).toEqual(committed);
  expect(calls[count]).toEqual({ method: "GET", path: expect.stringMatching(/\/archive$/) });
  expect(calls.slice(count).some(call => call.method === "PUT")).toBe(false);
  expect(await readFile(intentPath, "utf8")).toBe(intentBytes);
  expect([...receiver.files.keys()].sort()).toEqual(fileIds);
  expect(bodies).toEqual([manifest]);
  expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(committed);
});
test("an unknown stopped-source response retries the original durable batch before preparing an archive",async()=>{
 const f=await fixture(),bodies:string[]=[],batches:string[]=[];let fail=true;
 const receiver=archiveTestReceiver({bodies,sourceThrough:f.sourceThrough});
 const request:typeof fetch=async(input,init)=>{if(String(input).endsWith("/source-tail")){batches.push(String(init?.body));if(fail)throw new Error("Source response lost")}return receiver.request(input,init)};
 await expect(uploadStoppedControllerArchive({...f,serverToken:"test",request})).rejects.toThrow("Source response lost");
 expect(bodies).toEqual([]);const db=new Database(f.journalPath);try{expect(db.prepare("SELECT value FROM image_runtime_state WHERE key='stopped_source_tail'").get()).toBeDefined()}finally{db.close()}
 fail=false;await uploadStoppedControllerArchive({...f,serverToken:"test",request});expect(batches).toHaveLength(2);expect(batches[1]).toBe(batches[0]);
});
test("a stopped source floor ahead of acknowledgement cannot fabricate a complete tail",async()=>{
 const f=await fixture(),db=new Database(f.journalPath);try{db.exec("UPDATE execution SET source_floor=last_sequence")}finally{db.close()}
 const request=vi.fn<typeof fetch>().mockResolvedValue(Response.json({archive:emptyStatus}));
 await expect(uploadStoppedControllerArchive({...f,serverToken:"test",request})).rejects.toThrow("complete unacknowledged event tail");expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0]?.[1]?.method).toBe("GET");
});
test("a resumed archive rejects an expanded local intent instead of changing its file identities",async()=>{
 const f=await fixture(),bodies:string[]=[];let fail=true;
 const receiver=archiveTestReceiver({bodies,sourceThrough:f.sourceThrough,fail:()=>fail});
 await expect(uploadStoppedControllerArchive({...f,serverToken:"test",request:receiver.request})).rejects.toThrow("503");
 const intentPath=`${f.journalPath}.archive-intent-${f.ticket.executionGeneration}.json`,intent=JSON.parse(await readFile(intentPath,"utf8"));intent.extra="not original";await writeFile(intentPath,JSON.stringify(intent));fail=false;
 await expect(uploadStoppedControllerArchive({...f,serverToken:"test",request:receiver.request})).rejects.toThrow("cannot change identity");expect(bodies).toHaveLength(1);
});
test("a ready network response cannot publish a local receipt after stopped identity changes",async()=>{
 const f=await fixture(),bodies:string[]=[];
 const receiver=archiveTestReceiver({bodies,sourceThrough:f.sourceThrough,onManifest:body=>{
  const db=new Database(f.journalPath);try{const row=db.prepare("SELECT snapshot FROM execution").get() as {snapshot:string};const snapshot=JSON.parse(row.snapshot);snapshot.nativeSessionId="changed-after-network";db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify(snapshot))}finally{db.close()}
  return Response.json({archive:{state:"ready",schemaVersion:3,completeness:"complete",sha256:createHash("sha256").update(body).digest("hex"),byteLength:String(Buffer.byteLength(body)),errorCode:null}})
 }});
 await expect(uploadStoppedControllerArchive({...f,serverToken:"test",request:receiver.request})).rejects.toThrow("stopped controller evidence changed");
 await expect(stat(`${f.journalPath}.archive-receipt-${f.ticket.executionGeneration}.json`)).rejects.toMatchObject({code:"ENOENT"});
});
test("an unknown manifest response queries the same identity and retry preserves exact bytes", async()=>{
 const f=await fixture(),bodies:string[]=[];let fail=true;
 const receiver=archiveTestReceiver({bodies,sourceThrough:f.sourceThrough,fail:()=>fail});
 await expect(uploadStoppedControllerArchive({...f,serverToken:"test",request:receiver.request})).rejects.toThrow("503");
 expect(pending(f.journalPath,f.ticket.sessionId).timeline.totals().entryCount).toBe(1);
 // An unreferenced legacy candidate cannot change the frozen SQL upload.
 await mkdir(`${f.journalPath}.pending-content/entries`, { mode: 0o700 });
 await writeFile(path.join(`${f.journalPath}.pending-content/entries`, `${randomUUID()}.json`), "incomplete candidate");fail=false;
 await uploadStoppedControllerArchive({...f,serverToken:"test",request:receiver.request});expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);
});
test("a lost SQL row cannot become a ready empty archive", async () => {
  const f = await fixture(), db = new Database(f.journalPath);
  db.prepare("DELETE FROM timeline_entries WHERE id=?").run(f.entry.entryId); db.close();
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ archive: emptyStatus }));
  const failure = await uploadStoppedControllerArchive({ ...f, serverToken: "test", request }).then(() => null, (error: unknown) => error);
  expect(errorCauses(failure)).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("totals") })]));
  expect(request.mock.calls.every(call => call[1]?.method === "POST")).toBe(true);
});
test("legacy completed SQL history migrates atomically and is readable after worktree deletion", async () => {
  const f = await fixture(); const content = pending(f.journalPath, f.ticket.sessionId);
  const original = content.timeline.get(f.entry.entryId)!;
  const db = new Database(f.journalPath);
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name GLOB 'image_*' OR name GLOB 'input_*' OR name GLOB 'native_*')").all() as {name:string}[]) db.exec(`DROP TABLE ${row.name}`);
  db.exec("DROP TABLE outbox_totals; DROP TABLE timeline_entries; DROP TABLE timeline_totals; ALTER TABLE execution DROP COLUMN legacy_timeline_cleanup_pending; ALTER TABLE execution DROP COLUMN archive_incomplete; CREATE TABLE projection(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL); CREATE TABLE resources(id TEXT PRIMARY KEY,descriptor TEXT NOT NULL,content BLOB); PRAGMA user_version=5;");
  db.prepare("INSERT INTO projection(rowid,id,content_hash,revision,value) VALUES(1,?,?,1,?)").run(original.entryId, "unused", JSON.stringify(original));
  await rm(`${f.journalPath}.pending-content`, { recursive: true });
  migrate(db, f.home);
  const migrated = pending(f.journalPath, f.ticket.sessionId);
  expect(migrated.timeline.get(original.entryId)).toEqual(original);
  const outbox = db.prepare("SELECT value FROM outbox").all() as { value: string }[];
  expect(db.prepare("SELECT byte_length FROM outbox_totals WHERE id=1").get()).toEqual({ byte_length: outbox.reduce((sum, row) => sum + Buffer.byteLength(row.value, "utf8"), 0) });
  expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat));
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('projection','resources')").all()).toEqual([]);
  db.close();
  expect(pending(f.journalPath, f.ticket.sessionId).timeline.get(original.entryId)).toEqual(original);
});
test("failed legacy migration retains SQL originals and safely resumes an already written file", async () => {
  const f = await fixture(); const db = new Database(f.journalPath); const content = pending(f.journalPath, f.ticket.sessionId);
  const original = content.timeline.get(f.entry.entryId)!;
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name GLOB 'image_*' OR name GLOB 'input_*' OR name GLOB 'native_*')").all() as {name:string}[]) db.exec(`DROP TABLE ${row.name}`);
  db.exec("DROP TABLE outbox_totals; DROP TABLE timeline_entries; DROP TABLE timeline_totals; ALTER TABLE execution DROP COLUMN legacy_timeline_cleanup_pending; ALTER TABLE execution DROP COLUMN archive_incomplete; CREATE TABLE projection(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL); CREATE TABLE resources(id TEXT PRIMARY KEY,descriptor TEXT NOT NULL,content BLOB); PRAGMA user_version=5;");
  db.prepare("INSERT INTO projection(rowid,id,content_hash,revision,value) VALUES(1,?,?,1,?)").run(original.entryId, "unused", JSON.stringify(original));
  const originalExec=Database.prototype.exec;const fail=vi.spyOn(Database.prototype,"exec").mockImplementation(function(this:Database.Database,sql:string){if(this===db&&sql.includes("CREATE TABLE content_index"))throw new Error("Injected content schema failure");return originalExec.call(this,sql)});
  let migrationError: unknown;
  try { migrate(db, f.home); } catch (error) { migrationError = error; }
  fail.mockRestore();
  expect(errorCauses(migrationError)).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Injected content schema failure" })]));
  expect(db.pragma("user_version", { simple: true })).toBe(5);
  expect(db.prepare("SELECT count(*) AS n FROM projection").get()).toEqual({ n: 1 });
  migrate(db, f.home);
  expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); db.close();
});
test("an outbox rollback preserves the committed timeline in memory and after restart", async () => {
  const f = await fixture({ finalizeStop: false });
  let store = openControllerLifecycleStore(f.journalPath, f.ticket, { maxOutboxBytes: 256 });
  const next = { ...f.entry, content: [{ type: "text" as const, text: "x".repeat(1000) }] };
  expect(() => store.projectTimeline(next)).toThrow("capacity");
  expect(store.readTimeline({ historyEpoch: randomUUID(), direction: "tail", cursor: null, limit: 10 }).items[0]).toMatchObject({ content: f.entry.content, revision: "1", entrySeq: "1" });
  store.close();
  store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  expect(store.readTimeline({ historyEpoch: randomUUID(), direction: "tail", cursor: null, limit: 10 }).items[0]).toMatchObject({ content: f.entry.content, revision: "1", entrySeq: "1" });
  store.acknowledgeEvents(store.getLastSourceSequence());
  expect(store.drainProjectionGap()).toBeNull(); store.close();
});

test("a delivered relay gap remains a permanent incomplete-archive marker", async () => {
  const f = await fixture({ finalizeStop: false }); const store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  store.markProjectionGap("A native event could not be captured.");
  expect(store.drainProjectionGap()).not.toBeNull(); store.close(); await f.completeStop();
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ archive: emptyStatus }));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toThrow("unresolved projection gap");
  expect(request.mock.calls.every(call => call[1]?.method === "POST")).toBe(true);
});
test("archive migrates an original resource into the common blob model and rejects a mismatching receipt",async()=>{
 const f=await fixture({ finalizeStop: false }),store=openControllerLifecycleStore(f.journalPath,f.ticket,{contentOwnedLocally:true});
 const bytes=Buffer.from("binary artifact"),resource={resourceId:randomUUID(),name:"output.txt",status:"available" as const,mediaType:"text/plain",byteLength:String(bytes.length),sha256:createHash("sha256").update(bytes).digest("hex"),error:null};
 store.saveResource(resource,bytes);store.projectTimeline({...f.entry,content:[{type:"resource",resourceId:resource.resourceId,label:"artifact"}]});const through=store.getLastSourceSequence();store.close();await f.completeStop();
 const bodies:string[]=[];const receiver=archiveTestReceiver({bodies,sourceThrough:through,onManifest:body=>Response.json({archive:{state:"ready",schemaVersion:3,completeness:"complete",sha256:"0".repeat(64),byteLength:String(Buffer.byteLength(body)),errorCode:null}})});
 await expect(uploadStoppedControllerArchive({...f,serverToken:"test",request:receiver.request})).rejects.toThrow("matching integrity");
 const manifest=JSON.parse(bodies[0]!);expect(manifest.resources[0].resource).toEqual(resource);expect(manifest.resources[0].blobId).toBeTypeOf("string");expect(manifest.resources[0]).not.toHaveProperty("data");expect(receiver.files.get(manifest.resources[0].blobId)?.equals(bytes)).toBe(true);
 expect(pending(f.journalPath,f.ticket.sessionId).resourceFiles.resources.get(resource.resourceId)?.data).toBeNull();
});
test.each(fixturePlatforms)("stopped archival retains and retries an available zero-byte legacy resource (%s)", async fixturePlatform => {
  selectFixturePlatform(fixturePlatform);
  const f = await fixture({ finalizeStop: false }), store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  const bytes = Buffer.alloc(0), resource = { resourceId: randomUUID(), name: "empty.txt", status: "available" as const, mediaType: "text/plain", byteLength: "0", sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
  store.saveResource(resource, bytes);
  store.projectTimeline({ ...f.entry, content: [{ type: "resource", resourceId: resource.resourceId, label: "empty original" }] });
  const sourceThrough = store.getLastSourceSequence(); store.close(); await f.completeStop();
  const bodies: string[] = [], offsets: string[] = [];
  const receiver = archiveTestReceiver({ bodies, sourceThrough });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "PUT" && url.searchParams.get("purpose") === "resource") offsets.push(url.searchParams.get("offset")!);
    return receiver.request(input, init);
  };
  const options = { ...f, serverToken: "test", request };
  const receipt = await uploadStoppedControllerArchive(options);
  const manifest = JSON.parse(bodies[0]!);
  expect(manifest.resources).toEqual([{ resource, blobId: expect.any(String) }]);
  expect(receiver.files.get(manifest.resources[0].blobId)).toEqual(bytes);
  expect(receiver.entries(bodies[0]!)[0].content).toEqual([{ type: "resource", resourceId: resource.resourceId, label: "empty original" }]);
  expect(offsets).toEqual(["0"]);
  expect(await uploadStoppedControllerArchive(options)).toEqual(receipt);
  expect(bodies).toHaveLength(1);
});
test("an available resource cannot be published without retained original bytes",async()=>{
 const f=await fixture({ finalizeStop: false }),store=openControllerLifecycleStore(f.journalPath,f.ticket,{contentOwnedLocally:true});
 try { expect(()=>store.saveResource({resourceId:randomUUID(),name:"missing.txt",status:"available",mediaType:"text/plain",byteLength:"1",sha256:"0".repeat(64),error:null})).toThrow("incomplete"); }finally{store.close()}
});

// A long conversation must not rewrite a growing timeline manifest on every insert.
test("timeline growth keeps file inventory writes bounded while SQL detects deleted rows", async () => {
  const f = await fixture({ finalizeStop: false });
  const store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  const inventory = `${f.journalPath}.pending-content/index.json`;
  const before = await stat(inventory);
  for (let i = 0; i < 12; i++) store.projectTimeline({ ...f.entry, entryId: randomUUID() });
  const after = await stat(inventory);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  store.close();
  const db = new Database(f.journalPath);
  db.exec("DELETE FROM timeline_entries WHERE id=(SELECT id FROM timeline_entries ORDER BY entry_seq LIMIT 1 OFFSET 6)"); db.close();
  expect(() => openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true })).toThrow("totals");
});


test.each([0, 129])("all archive transport phases release local ownership with %i MiB retained metadata", async retainedMiB => {
  const f = await fixture();
  if (retainedMiB > 0) {
    const retained = await open(path.join(`${f.journalPath}.pending-content`, "retained.tmp"), "wx", 0o600);
    try { await retained.truncate(retainedMiB * 1048576); } finally { await retained.close(); }
  }
  const receiver = archiveTestReceiver({ bodies: [], sourceThrough: f.sourceThrough });
  let requests = 0;
  const request: typeof fetch = async (input, init) => {
    const permit = acquireControllerStoragePermit(f.journalPath);
    try { requests++; return await receiver.request(input, init); }
    finally { permit.release(); }
  };
  expect((await uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).state).toBe("ready");
  expect(requests).toBeGreaterThan(5);
});


test.each(["none", "transport", "close", "acquire", "descriptor", "verify", "read", "lease-close", "read-close", "response-loss"] as const)("resource transfers validate lazy leases after SQL closes and release them (failure: %s)", async failure => {
  const f = await fixture({ finalizeStop: false }), store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  const bytes = Buffer.from("frozen resource bytes"), resource = { resourceId: randomUUID(), status: "available" as const, name: "original.txt", mediaType: "text/plain", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
  store.saveResource(resource, bytes);
  store.projectTimeline({ ...f.entry, content: [{ type: "resource", resourceId: resource.resourceId, label: "original" }] });
  const sourceThrough = store.getLastSourceSequence(); store.close(); await f.completeStop();
  const connections = new Set<Database.Database>(), prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
    if (this.name === f.journalPath) connections.add(this);
    return prepare.call(this, sql);
  });
  const acquireFailure = new Error("Resource acquire failed"), readFailure = new Error("Resource read failed"), leaseCloseFailure = new Error("Resource close failed");
  const leases: { closed: boolean }[] = [], openFiles = resourceFiles.openResourceFiles;
  let validatedSnapshots = 0;
  vi.spyOn(resourceFiles, "openResourceFiles").mockImplementation((file, sessionId) => {
    expect([...connections].some(connection => connection.open && connection.inTransaction)).toBe(true);
    const files = openFiles(file, sessionId); validatedSnapshots++;
    return { ...files, get resources() { return files.resources; }, acquireResource: id => {
      expect([...connections].every(connection => !connection.open)).toBe(true);
      if (failure === "acquire") throw acquireFailure;
      const lease = files.acquireResource(id), state = { closed: false }; leases.push(state);
      return { ...lease, resource: failure === "descriptor" ? { ...lease.resource, name: "changed-descriptor.txt" } : lease.resource, read: (offset, limit) => {
        if (failure === "read" || failure === "read-close") throw readFailure;
        const block = lease.read(offset, limit);
        if (failure === "verify" && block.length > 0) block[0] = block[0]! ^ 1;
        return block;
      }, close: () => { lease.close(); state.closed = true; if (failure === "lease-close" || failure === "read-close") throw leaseCloseFailure; } };
    } };
  });
  const closeFailure = new Error("SQL close report lost"), close = sqliteAccess.closeSqliteDatabase;
  if (failure === "close") vi.spyOn(sqliteAccess, "closeSqliteDatabase").mockImplementation((db, options, outcome) => {
    close(db, options, outcome);
    if (db.name === f.journalPath && validatedSnapshots > 0) throw closeFailure;
  });
  const receiver = archiveTestReceiver({ bodies: [], sourceThrough });
  let requests = 0, resourceRetried = false;
  const request: typeof fetch = async (input, init) => {
    requests++;
    expect(connections.size).toBeGreaterThan(0);
    expect([...connections].every(connection => !connection.open)).toBe(true);
    const permit = acquireControllerStoragePermit(f.journalPath);
    try {
      await Promise.resolve();
      const url = new URL(String(input));
      if (failure === "transport" && url.pathname.includes("/files/")) throw new Error("Transport response lost");
      if (!resourceRetried && init?.method === "PUT" && url.searchParams.get("purpose") === "resource") {
        resourceRetried = true;
        if (failure === "none") return Response.json({ error: { code: "resource_busy" } }, { status: 429, headers: { "Retry-After": "0" } });
        if (failure === "response-loss") { await receiver.request(input, init); throw new Error("Resource response lost after commit"); }
      }
      return await receiver.request(input, init);
    } finally { permit.release(); }
  };
  const upload = uploadStoppedControllerArchive({ ...f, serverToken: "test", request });
  if (failure === "transport") await expect(upload).rejects.toThrow("Transport response lost");
  else if (failure === "close") {
    await expect(upload).rejects.toMatchObject({ kind: "cleanup-failed", connectionClosed: true, cause: closeFailure });
    expect(requests).toBe(0);
  } else if (failure === "acquire") await expect(upload).rejects.toBe(acquireFailure);
  else if (failure === "descriptor") await expect(upload).rejects.toThrow("original descriptor");
  else if (failure === "verify") await expect(upload).rejects.toThrow("resource content changed");
  else if (failure === "read") await expect(upload).rejects.toBe(readFailure);
  else if (failure === "lease-close") await expect(upload).rejects.toBe(leaseCloseFailure);
  else if (failure === "read-close") await expect(upload).rejects.toMatchObject({ cause: readFailure, errors: [readFailure, leaseCloseFailure] });
  else {
    expect((await upload).state).toBe("ready");
    expect(requests).toBeGreaterThan(5);
    expect([...receiver.files.values()].some(content => content.equals(bytes))).toBe(true);
    expect(resourceRetried).toBe(true);
  }
  expect(validatedSnapshots).toBeGreaterThan(0);
  expect(leases).toHaveLength(failure === "close" || failure === "acquire" ? 0 : 1);
  expect(leases.every(lease => lease.closed)).toBe(true);
});

test("multiple valid PNG resources archive with one controlled resource lease at a time", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgZGL+DwABFAEG9O6t0QAAAABJRU5ErkJggg==", "base64");
  expect(png.length).toBe(91);
  expect(await sharp(png).metadata()).toMatchObject({ format: "png", width: 1, height: 1 });
  expect(await sharp(png).raw().toBuffer()).toEqual(Buffer.from([1, 2, 3, 255]));
  const f = await fixture({ finalizeStop: false }), store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  const content = [];
  for (let index = 0; index < 3; index++) {
    const resourceId = randomUUID();
    store.saveResource({ resourceId, status: "available", name: "pixel.png", mediaType: "image/png", byteLength: String(png.length), sha256: createHash("sha256").update(png).digest("hex"), error: null }, png);
    content.push({ type: "resource" as const, resourceId, label: "pixel.png" });
  }
  store.projectTimeline({ ...f.entry, content });
  const sourceThrough = store.getLastSourceSequence(); store.close(); await f.completeStop();
  const openFiles = resourceFiles.openResourceFiles;
  let active = 0, peak = 0, acquired = 0;
  vi.spyOn(resourceFiles, "openResourceFiles").mockImplementation((file, sessionId) => {
    const files = openFiles(file, sessionId);
    return { ...files, get resources() { return files.resources; }, acquireResource: id => {
      const lease = files.acquireResource(id); acquired++; active++; peak = Math.max(peak, active);
      let closed = false;
      return { ...lease, close: () => { lease.close(); if (!closed) { active--; closed = true; } } };
    } };
  });
  const bodies: string[] = [], receiver = archiveTestReceiver({ bodies, sourceThrough });
  expect((await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver.request })).state).toBe("ready");
  expect(acquired).toBe(3);
  expect(peak).toBe(1);
  expect(active).toBe(0);
  expect([...receiver.files.values()].filter(bytes => bytes.equals(png))).toHaveLength(3);
  expect(receiver.entries(bodies[0]!)).toHaveLength(1);
}, 30000);

test("archive freeze validation rereads current SQL bodies after asynchronous status", async () => {
  const f = await fixture(), bodies: string[] = [], receiver = archiveTestReceiver({ bodies, sourceThrough: f.sourceThrough });
  let changed = false;
  const request: typeof fetch = async (input, init) => {
    if (!changed && init?.method === "GET") {
      changed = true;
      const db = new Database(f.journalPath), original = JSON.parse((db.prepare("SELECT value FROM timeline_entries WHERE id=?").get(f.entry.entryId) as { value: string }).value), replacement = parseTimelineEntry({ ...original, revision: "2", content: [{ type: "text", text: "changed after the freeze" }] }), value = JSON.stringify(replacement);
      try { db.transaction(() => {
        db.prepare("UPDATE timeline_entries SET revision=2,value=?,content_hash=?,byte_length=? WHERE id=?").run(value, controllerPayloadHash(replacement), Buffer.byteLength(value), f.entry.entryId);
        db.prepare("UPDATE timeline_totals SET byte_length=? WHERE id=1").run(Buffer.byteLength(value));
      }).immediate(); } finally { db.close(); }
    }
    return receiver.request(input, init);
  };
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toThrow("archive source changed during transfer");
  expect(bodies).toEqual([]);
  await expect(stat(`${f.journalPath}.archive-receipt-1.json`)).rejects.toMatchObject({ code: "ENOENT" });
});
