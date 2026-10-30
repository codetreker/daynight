import Database from "better-sqlite3";
import { mkdtemp, mkdir, rm, readdir, unlink, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { uploadStoppedControllerArchive } from "../../../src/commands/controller/archive-upload.js";
import { openPendingContent, migratePendingContent } from "../../../src/commands/controller/pending-content.js";
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
  store.projectTimeline(entry); store.patchSnapshot({ lifecycle: "stopped", nativeStopped: true }); store.close();
  return { home, ticket, journalPath, entry };
};
const emptyStatus = { state: "unavailable", sha256: null, byteLength: null, errorCode: null };
test("uploads normalized stopped history without a worktree or native resume and caches a verified receipt", async () => {
  const f = await fixture(); const calls: string[] = [];
  const request: typeof fetch = async (_url, options) => {
    calls.push(options!.method!);
    expect((options!.headers as Record<string,string>).Authorization).toBe("Bearer test");
    if (options?.method === "PUT") {
      const body = String(options.body), parsed = JSON.parse(body);
      expect(parsed.entries[0]).toMatchObject({ content: f.entry.content, entrySeq: "1", revision: "1" });
      return Response.json({ archive: { state: "ready", sha256: createHash("sha256").update(body).digest("hex"), byteLength: String(Buffer.byteLength(body)), errorCode: null } });
    }
    return Response.json({ archive: emptyStatus });
  };
  const options = { ...f, serverToken: "test", request };
  expect((await uploadStoppedControllerArchive(options)).state).toBe("ready");
  expect(calls).toEqual(["GET", "POST", "PUT"]);
  await rm(`${f.journalPath}.pending-content`, { recursive: true });
  const status = JSON.parse(await (await import("node:fs/promises")).readFile(`${f.journalPath}.archive-receipt-1.json`, "utf8"));
  const recheck: typeof fetch = async (_url, init) => { calls.push(init!.method!); return Response.json({ archive: status }); };
  await uploadStoppedControllerArchive({ ...options, request: recheck }); expect(calls).toEqual(["GET", "POST", "PUT", "GET"]);
});
test("upload failure preserves full source and retry sends identical bytes", async () => {
  const f = await fixture(); const bodies: string[] = []; let fail = true;
  const request: typeof fetch = async (_url, options) => {
    if (options?.method === "PUT") {
      const body = String(options.body); bodies.push(body);
      if (fail) return new Response(null, { status: 503 });
      return Response.json({ archive: { state: "ready", sha256: createHash("sha256").update(body).digest("hex"), byteLength: String(Buffer.byteLength(body)), errorCode: null } });
    }
    return Response.json({ archive: emptyStatus });
  };
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toThrow("503");
  expect(openPendingContent(f.journalPath, f.ticket.sessionId).entries.size).toBe(1);
  fail = false; await uploadStoppedControllerArchive({ ...f, serverToken: "test", request });
  expect(bodies[0]).toEqual(bodies[1]);
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
  db.exec("DROP TABLE content_index; ALTER TABLE execution DROP COLUMN archive_incomplete; CREATE TABLE projection(id TEXT PRIMARY KEY,content_hash TEXT,revision INTEGER,value TEXT); CREATE TABLE resources(id TEXT PRIMARY KEY,descriptor TEXT,content BLOB); PRAGMA user_version=5;");
  db.prepare("INSERT INTO projection(rowid,id,content_hash,revision,value) VALUES(1,?,?,1,?)").run(original.entryId, "unused", JSON.stringify(original));
  await rm(`${f.journalPath}.pending-content`, { recursive: true });
  const migrated = openPendingContent(f.journalPath, f.ticket.sessionId); migratePendingContent(db, migrated);
  expect(migrated.entries.get(original.entryId)).toEqual(original);
  expect(db.pragma("user_version", { simple: true })).toBe(6);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('projection','resources')").all()).toEqual([]);
  db.close();
  expect(openPendingContent(f.journalPath, f.ticket.sessionId).entries.get(original.entryId)).toEqual(original);
});
test("failed legacy migration retains SQL originals and safely resumes an already written file", async () => {
  const f = await fixture(); const db = new Database(f.journalPath); const content = openPendingContent(f.journalPath, f.ticket.sessionId);
  const original = content.entries.get(f.entry.entryId)!;
  db.exec("DROP TABLE content_index; ALTER TABLE execution DROP COLUMN archive_incomplete; CREATE TABLE projection(id TEXT PRIMARY KEY,content_hash TEXT,revision INTEGER,value TEXT); CREATE TABLE resources(id TEXT PRIMARY KEY,descriptor TEXT,content BLOB); PRAGMA user_version=5;");
  db.prepare("INSERT INTO projection(rowid,id,content_hash,revision,value) VALUES(1,?,?,1,?)").run(original.entryId, "unused", JSON.stringify(original));
  db.prepare("INSERT INTO resources VALUES(?,?,NULL)").run(randomUUID(), "{}");
  expect(() => migratePendingContent(db, content)).toThrow();
  expect(db.pragma("user_version", { simple: true })).toBe(5);
  expect(db.prepare("SELECT count(*) AS n FROM projection").get()).toEqual({ n: 1 });
  db.exec("DELETE FROM resources"); migratePendingContent(db, content);
  expect(db.pragma("user_version", { simple: true })).toBe(6); db.close();
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
test("archive embeds verified resource bytes and rejects a mismatching server receipt", async () => {
  const f = await fixture(); const store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  const bytes = Buffer.from("binary artifact"), resource = { resourceId: randomUUID(), name: "output.txt", status: "available" as const, mediaType: "text/plain", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
  store.saveResource(resource, bytes); store.close();
  let body = "";
  const request: typeof fetch = async (_url, init) => {
    if (init?.method === "PUT") {
      body = String(init.body);
      expect(JSON.parse(body).resources).toEqual([{ resource, data: bytes.toString("base64") }]);
      return Response.json({ archive: { state: "ready", sha256: "0".repeat(64), byteLength: String(Buffer.byteLength(body)), errorCode: null } });
    }
    return Response.json({ archive: emptyStatus });
  };
  await expect(uploadStoppedControllerArchive({ ...f, request, serverToken: "test" })).rejects.toThrow("matching integrity");
  expect(body).not.toBe(""); expect(openPendingContent(f.journalPath, f.ticket.sessionId).resources.get(resource.resourceId)?.data).toBe(bytes.toString("base64"));
});
test("an available resource without retained bytes cannot produce a ready archive", async () => {
  const f = await fixture(); const store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  store.saveResource({ resourceId: randomUUID(), name: "missing.txt", status: "available", mediaType: "text/plain", byteLength: "1", sha256: "0".repeat(64), error: null }); store.close();
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ archive: emptyStatus }));
  await expect(uploadStoppedControllerArchive({ ...f, request, serverToken: "test" })).rejects.toThrow("Invalid Daynight session archive");
  expect(request.mock.calls.map(call => call[1]?.method)).toEqual(["POST"]);
});

// A long conversation must not rewrite a growing timeline manifest on every insert.
test("timeline growth keeps file inventory writes bounded while SQL detects deleted entries", async () => {
  const f = await fixture();
  const store = openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true });
  const inventory = `${f.journalPath}.pending-content/index.json`;
  const before = await stat(inventory);
  for (let i = 0; i < 100; i++) store.projectTimeline({ ...f.entry, entryId: randomUUID() });
  const after = await stat(inventory);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  store.close();
  const files = await readdir(`${f.journalPath}.pending-content/timeline`);
  await unlink(path.join(`${f.journalPath}.pending-content/timeline`, files[50]!));
  expect(() => openControllerLifecycleStore(f.journalPath, f.ticket, { contentOwnedLocally: true })).toThrow("incomplete");
});
