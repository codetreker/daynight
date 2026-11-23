import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { openControllerLifecycleStore, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { syncControllerImageHistory } from "../../../src/commands/controller/media/history-sync.js";
import { uploadStoppedControllerArchive } from "../../../src/commands/controller/archive-upload.js";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { archiveTestReceiver } from "./archive-test-transport.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const diskBytes = async (root: string): Promise<number> => {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    total += entry.isDirectory() ? await diskBytes(file) : (await stat(file)).size;
  }
  return total;
};

test("streams more than 128 MiB of online tools without charging or uploading them as Task body history", async () => {
  const started = performance.now(), metrics: Record<string, number | string> = {};
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/task-body-history"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-"));
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const journalPath = path.join(home, "journal.sqlite");
  let journal: ReturnType<typeof openControllerLifecycleStore> | undefined;
  try {
    await writeFile(ticket.credentialFile, JSON.stringify({ token: "stress-test-grant", expiresAt: new Date(Date.now() + 900000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
    journal = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true, historyPolicy: "task_body" });
    const resources = ["body-image", "tool-exclusive-image"].map(name => {
      const bytes = Buffer.from(name), resource = { resourceId: randomUUID(), name: `${name}.bin`, status: "available" as const, mediaType: "application/octet-stream", byteLength: String(bytes.length), sha256: digest(bytes), error: null };
      journal!.saveResource(resource, bytes); return resource;
    });
    const toolIds: string[] = [], text = "tool-exclusive-marker:" + "x".repeat(1048576), writeStart = performance.now();
    for (let index = 0; index < 130; index++) {
      const entryId = randomUUID(); toolIds.push(entryId);
      journal.projectTimeline({ entryId, revision: "1", kind: "tool_call", callId: `call-${index}`, name: "shell", input: `command ${index}`, output: [{ type: "text", text }, ...(index === 0 ? [{ type: "resource" as const, resourceId: resources[1]!.resourceId, label: "tool image" }] : [])], status: "completed", truncated: false });
      journal.acknowledgeEvents(journal.getLastSourceSequence());
      if (index % 25 === 24) console.log(JSON.stringify({ stress: "task-body-history", writtenEntries: index + 1 }));
    }
    metrics.toolInputBytes = Buffer.byteLength(text) * toolIds.length; metrics.writeMs = Math.round(performance.now() - writeStart);
    expect(metrics.toolInputBytes).toBeGreaterThan(128 * 1048576);
    journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "body answer" }, { type: "resource", resourceId: resources[0]!.resourceId, label: "body image" }] });
    journal.acknowledgeEvents(journal.getLastSourceSequence()); journal.close(); journal = undefined;
    metrics.diskBeforeBytes = await diskBytes(home); metrics.journalBeforeBytes = (await stat(journalPath)).size;
    expect(metrics.journalBeforeBytes).toBeGreaterThan(128 * 1048576);
    journal = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true });
    const readStart = performance.now();
    for (const entryId of toolIds) {
      const entry = journal.getTimelineEntry(entryId); expect(entry?.kind).toBe("tool_call");
      if (entry?.kind !== "tool_call" || entry.output[0]?.type !== "text") throw new Error("Missing online tool output");
      expect(digest(entry.output[0].text)).toBe(digest(text)); expect(entry.truncated).toBe(false);
    }
    metrics.onlineReadMs = Math.round(performance.now() - readStart);
    journal.recordRelayHistory("test-history");
    const fence = { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1", connectionEpoch: "1" };
    let activeBytes = Buffer.alloc(0);
    const historyRequest: typeof fetch = async (_input, init) => {
      const headers = { "Daynight-Task-Body-History-Version": "1" };
      expect(new Headers(init!.headers).get("Daynight-Task-Body-History-Version")).toBe("1");
      if (init!.method === "GET") return new Response(null, { status: 404, headers });
      const chunk = Buffer.from(init!.body as Uint8Array), requestHeaders = new Headers(init!.headers), url = new URL(String(_input));
      expect(Number(url.searchParams.get("offset"))).toBe(activeBytes.length); expect(chunk.length).toBeLessThanOrEqual(1048576);
      expect(requestHeaders.get("Daynight-Chunk-SHA256")).toBe(digest(chunk)); activeBytes = Buffer.concat([activeBytes, chunk]);
      const length = requestHeaders.get("Daynight-File-Byte-Length")!, complete = activeBytes.length === Number(length);
      if (complete) expect(digest(activeBytes)).toBe(requestHeaders.get("Daynight-File-SHA256"));
      return Response.json({ syncId: url.pathname.split("/").at(-1), state: complete ? "complete" : "receiving", acceptedOffset: String(activeBytes.length), byteLength: length, sha256: requestHeaders.get("Daynight-File-SHA256"), timelineRevision: complete ? "1" : null, error: null }, { headers });
    };
    const syncStart = performance.now();
    await syncControllerImageHistory({ journal, ticket, fence, currentFence: () => fence, request: historyRequest });
    metrics.activeSyncMs = Math.round(performance.now() - syncStart); metrics.activeHistoryBytes = activeBytes.length;
    expect(activeBytes.toString()).not.toContain("tool-exclusive");
    const sourceThrough = journal.getLastSourceSequence(); metrics.sourceThrough = sourceThrough;
    expect(JSON.parse(activeBytes.toString())).toMatchObject({ contentPolicy: "task_body", sourceThrough, entries: [expect.objectContaining({ kind: "assistant_message" })], resources: [resources[0]] });
    expect(journal.hasImageHistoryCheckpoint(sourceThrough)).toBe(true);
    journal.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() }); journal.close(); journal = undefined;
    if (process.platform === "win32") {
      const db = new Database(journalPath);
      try {
        const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
        db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...JSON.parse(row.snapshot), lifecycle: "stopping", nativeStopped: false, stoppedAt: null, controllerProcess: { pid: 2_000_000_000, parentPid: 1, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` } }));
      } finally { db.close(); }
      const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
      try { await recordStoppedControllerGeneration(journalPath, ticket, { jobLease: {} as ControllerJobLease }); } finally { confirm.mockRestore(); }
    }
    const bodies: string[] = [], receiver = archiveTestReceiver({ bodies, sourceThrough });
    let uploadBytes = 0;
    const request: typeof fetch = async (input, init) => {
      if (init?.body) uploadBytes += typeof init.body === "string" ? Buffer.byteLength(init.body) : (init.body as Uint8Array).byteLength;
      const response = await receiver.request(input, init); response.headers.set("Daynight-Task-Body-History-Version", "1"); return response;
    };
    const archiveStart = performance.now();
    expect(await uploadStoppedControllerArchive({ journalPath, ticket, serverToken: "test", request })).toMatchObject({ state: "ready", schemaVersion: 3 });
    metrics.archiveAndRetireMs = Math.round(performance.now() - archiveStart); metrics.archiveUploadBytes = uploadBytes;
    expect(JSON.parse(bodies[0]!)).toMatchObject({ contentPolicy: "task_body", resources: [{ resource: resources[0]!, blobId: expect.any(String) }] });
    expect(receiver.entries(bodies[0]!)).toEqual([expect.objectContaining({ kind: "assistant_message" })]);
    for (const bytes of receiver.files.values()) expect(bytes.toString()).not.toContain("tool-exclusive");
    const db = new Database(journalPath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM online_entries").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT CAST(last_acknowledged AS TEXT) AS ack FROM execution").get()).toEqual({ ack: sourceThrough });
      metrics.bodySqlBytes = (db.prepare("SELECT byte_length FROM timeline_totals").get() as { byte_length: number }).byte_length;
    } finally { db.close(); }
    const files = openResourceFiles(journalPath, ticket.sessionId); expect(files.resources.has(resources[0]!.resourceId)).toBe(true); expect(files.resources.has(resources[1]!.resourceId)).toBe(false);
    metrics.diskAfterRetireBytes = await diskBytes(home); metrics.journalAfterBytes = (await stat(journalPath)).size;
    expect(metrics.diskAfterRetireBytes).toBeLessThan(1048576); expect(uploadBytes + activeBytes.length).toBeLessThan(1048576);
  } finally {
    journal?.close(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true });
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    metrics.cleanedTaskBytes = 0; metrics.totalMs = Math.round(performance.now() - started);
    await writeFile(path.join(base, "measurements.json"), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify({ stress: "task-body-history", ...metrics }));
  }
}, 180000);
