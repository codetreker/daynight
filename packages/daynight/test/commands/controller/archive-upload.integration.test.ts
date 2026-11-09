import Database from "better-sqlite3";
import { mkdtemp, mkdir, rm, readdir, unlink, stat, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { uploadStoppedControllerArchive } from "../../../src/commands/controller/archive-upload.js";
import { openPendingContent } from "../../../src/commands/controller/pending-content.js";
import { archiveTestReceiver } from "./archive-test-transport.js";
import { currentSqliteVersion, upgradeSqlite } from "../../../src/platform/sqlite-format.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/archive-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: path.join(home, "removed-worktree"), nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed task", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const journalPath = path.join(home, "journal.sqlite");
  const store = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true });
  const entry = { entryId: randomUUID(), revision: "1", kind: "assistant_message" as const, content: [{ type: "text" as const, text: "durable answer" }] };
  store.projectTimeline(entry); const sourceThrough=store.getLastSourceSequence(); store.patchSnapshot({ lifecycle: "stopped", nativeStopped: true }); store.close();
  return { home, ticket, journalPath, entry, sourceThrough };
};
const emptyStatus = { state: "unavailable", sha256: null, byteLength: null, errorCode: null };
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
 expect(openPendingContent(f.journalPath,f.ticket.sessionId).entries.size).toBe(1);fail=false;
 await uploadStoppedControllerArchive({...f,serverToken:"test",request:receiver.request});expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);
});
test("lost pending entry cannot become a ready empty archive", async () => {
  const f = await fixture(); const directory = `${f.journalPath}.pending-content/timeline`;
  await unlink(path.join(directory, (await readdir(directory))[0]!));
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ archive: emptyStatus }));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toThrow("incomplete");
  expect(request.mock.calls.every(call => call[1]?.method === "POST")).toBe(true);
});
test("legacy completed SQL history migrates atomically and is readable after worktree deletion", async () => {
  const f = await fixture(); const content = openPendingContent(f.journalPath, f.ticket.sessionId);
  const original = content.entries.get(f.entry.entryId)!;
  const db = new Database(f.journalPath);
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name GLOB 'image_*' OR name GLOB 'input_*')").all() as {name:string}[]) db.exec(`DROP TABLE ${row.name}`);
  db.exec("DROP TABLE content_index; ALTER TABLE execution DROP COLUMN archive_incomplete; CREATE TABLE projection(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL); CREATE TABLE resources(id TEXT PRIMARY KEY,descriptor TEXT NOT NULL,content BLOB); PRAGMA user_version=5;");
  db.prepare("INSERT INTO projection(rowid,id,content_hash,revision,value) VALUES(1,?,?,1,?)").run(original.entryId, "unused", JSON.stringify(original));
  await rm(`${f.journalPath}.pending-content`, { recursive: true });
  db.transaction(() => upgradeSqlite(db, controllerJournalFormat)).immediate();
  const migrated = openPendingContent(f.journalPath, f.ticket.sessionId);
  expect(migrated.entries.get(original.entryId)).toEqual(original);
  expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat));
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('projection','resources')").all()).toEqual([]);
  db.close();
  expect(openPendingContent(f.journalPath, f.ticket.sessionId).entries.get(original.entryId)).toEqual(original);
});
test("failed legacy migration retains SQL originals and safely resumes an already written file", async () => {
  const f = await fixture(); const db = new Database(f.journalPath); const content = openPendingContent(f.journalPath, f.ticket.sessionId);
  const original = content.entries.get(f.entry.entryId)!;
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name GLOB 'image_*' OR name GLOB 'input_*')").all() as {name:string}[]) db.exec(`DROP TABLE ${row.name}`);
  db.exec("DROP TABLE content_index; ALTER TABLE execution DROP COLUMN archive_incomplete; CREATE TABLE projection(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL); CREATE TABLE resources(id TEXT PRIMARY KEY,descriptor TEXT NOT NULL,content BLOB); PRAGMA user_version=5;");
  db.prepare("INSERT INTO projection(rowid,id,content_hash,revision,value) VALUES(1,?,?,1,?)").run(original.entryId, "unused", JSON.stringify(original));
  const originalExec=Database.prototype.exec;const fail=vi.spyOn(Database.prototype,"exec").mockImplementation(function(this:Database.Database,sql:string){if(this===db&&sql.includes("CREATE TABLE content_index"))throw new Error("Injected content schema failure");return originalExec.call(this,sql)});
  expect(() => db.transaction(() => upgradeSqlite(db, controllerJournalFormat)).immediate()).toThrow();fail.mockRestore();
  expect(db.pragma("user_version", { simple: true })).toBe(5);
  expect(db.prepare("SELECT count(*) AS n FROM projection").get()).toEqual({ n: 1 });
  db.transaction(() => upgradeSqlite(db, controllerJournalFormat)).immediate();
  expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); db.close();
});
test("file committed before an outbox rollback survives restart with relay resynchronization", async () => {
  const f = await fixture();
  let store = openControllerLifecycleStore(f.journalPath, f.ticket, { maxOutboxBytes: 256 });
  const next = { ...f.entry, content: [{ type: "text" as const, text: "x".repeat(1000) }] };
  expect(() => store.projectTimeline(next)).toThrow("capacity"); store.close();
  store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  expect(store.readTimeline({ historyEpoch: randomUUID(), direction: "tail", cursor: null, limit: 10 }).items[0]).toMatchObject({ content: next.content, revision: "2", entrySeq: "1" });
  store.acknowledgeEvents(store.getLastSourceSequence());
  expect(store.drainProjectionGap()).toMatchObject({ payload: { kind: "gap" } }); store.close();
});

test("a delivered relay gap remains a permanent incomplete-archive marker", async () => {
  const f = await fixture(); const store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  store.markProjectionGap("A native event could not be captured.");
  expect(store.drainProjectionGap()).not.toBeNull(); store.close();
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ archive: emptyStatus }));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toThrow("unresolved projection gap");
  expect(request.mock.calls.every(call => call[1]?.method === "POST")).toBe(true);
});
test("archive migrates an original resource into the common blob model and rejects a mismatching receipt",async()=>{
 const f=await fixture(),store=openControllerLifecycleStore(f.journalPath,f.ticket,{contentOwnedLocally:true});
 const bytes=Buffer.from("binary artifact"),resource={resourceId:randomUUID(),name:"output.txt",status:"available" as const,mediaType:"text/plain",byteLength:String(bytes.length),sha256:createHash("sha256").update(bytes).digest("hex"),error:null};
 store.saveResource(resource,bytes);store.projectTimeline({...f.entry,content:[{type:"resource",resourceId:resource.resourceId,label:"artifact"}]});const through=store.getLastSourceSequence();store.close();
 const bodies:string[]=[];const receiver=archiveTestReceiver({bodies,sourceThrough:through,onManifest:body=>Response.json({archive:{state:"ready",schemaVersion:3,completeness:"complete",sha256:"0".repeat(64),byteLength:String(Buffer.byteLength(body)),errorCode:null}})});
 await expect(uploadStoppedControllerArchive({...f,serverToken:"test",request:receiver.request})).rejects.toThrow("matching integrity");
 const manifest=JSON.parse(bodies[0]!);expect(manifest.resources[0].resource).toEqual(resource);expect(manifest.resources[0].blobId).toBeTypeOf("string");expect(manifest.resources[0]).not.toHaveProperty("data");expect(receiver.files.get(manifest.resources[0].blobId)?.equals(bytes)).toBe(true);
 expect(openPendingContent(f.journalPath,f.ticket.sessionId).resources.get(resource.resourceId)?.data).toBeNull();
});
test("an available resource cannot be published without retained original bytes",async()=>{
 const f=await fixture(),store=openControllerLifecycleStore(f.journalPath,f.ticket,{contentOwnedLocally:true});
 try { expect(()=>store.saveResource({resourceId:randomUUID(),name:"missing.txt",status:"available",mediaType:"text/plain",byteLength:"1",sha256:"0".repeat(64),error:null})).toThrow("incomplete"); }finally{store.close()}
});

// A long conversation must not rewrite a growing timeline manifest on every insert.
test("timeline growth keeps file inventory writes bounded while SQL detects deleted entries", async () => {
  const f = await fixture();
  const store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  const inventory = `${f.journalPath}.pending-content/index.json`;
  const before = await stat(inventory);
  for (let i = 0; i < 12; i++) store.projectTimeline({ ...f.entry, entryId: randomUUID() });
  const after = await stat(inventory);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  store.close();
  const files = await readdir(`${f.journalPath}.pending-content/timeline`);
  await unlink(path.join(`${f.journalPath}.pending-content/timeline`, files[6]!));
  expect(() => openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true })).toThrow("incomplete");
});
