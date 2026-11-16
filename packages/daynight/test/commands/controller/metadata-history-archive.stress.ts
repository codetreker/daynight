import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { syncControllerImageHistory } from "../../../src/commands/controller/media/history-sync.js";
import { uploadStoppedControllerArchive } from "../../../src/commands/controller/archive-upload.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { archiveTestReceiver } from "./archive-test-transport.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("history synchronization and stopped archive preserve their sources beyond the former metadata ceiling", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/metadata-history-archive"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeFile(ticket.credentialFile, JSON.stringify({ token: "controller-grant-only", expiresAt: new Date(Date.now() + 900000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
  const journalPath = path.join(home, "journal.sqlite"), options = { contentOwnedLocally: true };
  let journal = openControllerLifecycleStore(journalPath, ticket, options);
  const value = "x".repeat(1_048_000);
  for (let i = 0; i < 130; i++) journal.writeNativeImageState(`retained-${i}`, value);
  journal.close();
  expect((await stat(journalPath)).size).toBeGreaterThan(128 * 1048576);
  journal = openControllerLifecycleStore(journalPath, ticket, options);
  const entryId = randomUUID(), nextId = randomUUID();
  const fence = { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: ticket.executionGeneration, connectionEpoch: "1" };
  let historyBytes = Buffer.alloc(0), historyId = "";
  const historyRequest: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), id = url.pathname.split("/").filter(Boolean).at(-1) === "status" ? url.pathname.split("/").at(-2)! : url.pathname.split("/").at(-1)!;
    if (init!.method === "GET") return new Response(null, { status: 404 });
    const headers = new Headers(init!.headers), chunk = Buffer.from(init!.body as Uint8Array);
    expect(headers.get("Authorization")).toBe("Bearer controller-grant-only");
    expect(headers.get("Daynight-Chunk-SHA256")).toBe(createHash("sha256").update(chunk).digest("hex"));
    expect(Number(url.searchParams.get("offset"))).toBe(historyBytes.length);
    historyId = id; historyBytes = Buffer.concat([historyBytes, chunk]);
    const length = headers.get("Daynight-File-Byte-Length")!, hash = headers.get("Daynight-File-SHA256")!, complete = historyBytes.length === Number(length);
    if (complete) expect(createHash("sha256").update(historyBytes).digest("hex")).toBe(hash);
    return Response.json({ syncId: id, state: complete ? "complete" : "receiving", acceptedOffset: String(historyBytes.length), byteLength: length, sha256: hash, timelineRevision: complete ? "1" : null, error: null });
  };
  try {
    expect(journal.readNativeImageState("retained-129")).toBe(value);
    journal.recordRelayHistory("test-history");
    journal.projectTimeline({ entryId, revision: "1", kind: "assistant_message", content: [{ type: "text", text: "original history" }] });
    journal.acknowledgeEvents(journal.getLastSourceSequence());
    await syncControllerImageHistory({ journal, ticket, fence, currentFence: () => fence, request: historyRequest });
    expect(historyId).not.toBe("");
    expect(JSON.parse(historyBytes.toString()).entries).toEqual([expect.objectContaining({ entryId, content: [{ type: "text", text: "original history" }] })]);
    expect(journal.hasImageHistoryCheckpoint(journal.getLastSourceSequence())).toBe(true);
    journal.projectTimeline({ entryId: nextId, revision: "1", kind: "assistant_message", content: [{ type: "text", text: "stopped tail" }] });
    const sourceThrough = journal.getLastSourceSequence();
    journal.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() });
    journal.close();
    if (process.platform === "win32") {
      const db = new Database(journalPath);
      try {
        const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
        db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...JSON.parse(row.snapshot), lifecycle: "stopping", nativeStopped: false, stoppedAt: null, controllerProcess: { pid: 2_000_000_000, parentPid: 1, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` } }));
      } finally { db.close(); }
      const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
      try { await recordStoppedControllerGeneration(journalPath, ticket, { jobLease: {} as ControllerJobLease }); } finally { confirm.mockRestore(); }
    }
    const bodies: string[] = [], paths: string[] = [];
    const receiver = archiveTestReceiver({ bodies, sourceThrough, onRequest: (_method, requestPath) => paths.push(requestPath) });
    expect((await uploadStoppedControllerArchive({ journalPath, ticket, serverToken: "test", request: receiver.request })).state).toBe("ready");
    expect(paths.some(value => value.endsWith("/source-tail"))).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(receiver.entries(bodies[0]!)).toEqual([
      expect.objectContaining({ entryId, content: [{ type: "text", text: "original history" }] }),
      expect.objectContaining({ entryId: nextId, content: [{ type: "text", text: "stopped tail" }] }),
    ]);
    const db = new Database(journalPath, { readonly: true });
    try {
      expect((db.prepare("SELECT value FROM image_runtime_state WHERE key='native_provider:retained-129'").get() as { value: string }).value).toBe(JSON.stringify(value));
      expect(db.prepare("SELECT CAST(last_acknowledged AS TEXT) AS ack FROM execution").get()).toEqual({ ack: sourceThrough });
    } finally { db.close(); }
  } finally { journal.close(); }
}, 30000);
