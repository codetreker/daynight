import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { createMarkdownImageProjector } from "../../../src/commands/controller/markdown/projection.js";
import { MarkdownAnalysisError } from "../../../src/commands/controller/markdown/parser.js";
import { repairStoppedMarkdownProjections, type StoppedMarkdownImageResolver } from "../../../src/commands/controller/stopped-markdown-repair.js";
import { uploadStoppedControllerArchive } from "../../../src/commands/controller/archive-upload.js";
import { archiveTestReceiver } from "./archive-test-transport.js";
import { sessionArchiveReferences } from "../../../src/session/archive.js";
import type { TimelineEntry } from "../../../src/session/protocol.js";
import * as outbox from "../../../src/commands/controller/outbox-store.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async (text = "Original 中文 **answer** 🐈", stop = true, retainImage: boolean | "repeated" | "ambiguous" = false) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/stopped-markdown-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const journalPath = path.join(home, "journal.sqlite"), store = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true });
  const entryId = randomUUID(), projector = createMarkdownImageProjector();
  const prepared = projector.prepare({ entryId, revision: "1", kind: "assistant_message", content: [{ type: "text", text }] }, { parts: [{ inputIndex: 0, sourceKey: `${entryId}:body`, complete: true, truncated: false, format: "markdown", contextKey: "original" }] }, null);
  let failed = projector.markFailed(prepared.state);
  if (retainImage === true) {
    const complete = await projector.complete(prepared.state), image = complete.state.parts[0]!.current[0]!;
    const saved = await resolveImage(image, {} as never);
    store.saveResource(saved.resource!, saved.bytes);
    const updated = projector.updateImagePart(complete.state, image.occurrence.imageId, saved.part);
    failed = projector.markFailed({ ...updated.state, pending: true, parts: updated.state.parts.map(part => ({ ...part, status: "pending" })) });
  }
  if (retainImage === "repeated" || retainImage === "ambiguous") {
    const meta = { parts: [{ inputIndex: 0, sourceKey: `${entryId}:body`, complete: true, truncated: false, format: "markdown" as const, contextKey: "original" }] };
    const body = (text: string, revision: string) => ({ entryId, revision, kind: "assistant_message" as const, content: [{ type: "text" as const, text }] });
    let captured = await projector.complete(prepared.state);
    for (let cycle = 0; cycle < (retainImage === "ambiguous" ? 2 : 1); cycle++) {
      for (const [index, image] of captured.state.parts[0]!.current.entries()) {
        const bytes = index === 0 ? png : secondPng;
        const saved = await resolveImage(image, {} as never);
        store.saveResource({ ...saved.resource!, byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
        captured = projector.updateImagePart(captured.state, image.occurrence.imageId, saved.part);
      }
      const changed = await projector.complete(projector.prepare(body("temporary body", String(cycle * 2 + 2)), meta, captured.state).state);
      const returned = projector.prepare(body(text, String(cycle * 2 + 3)), meta, changed.state);
      if (cycle + 1 < (retainImage === "ambiguous" ? 2 : 1)) captured = await projector.complete(returned.state);
      else failed = await createMarkdownImageProjector({ parse: async () => { throw new Error("analysis unavailable after original text returned"); } }).complete(returned.state);
    }
  }
  store.publishMarkdownProjection(failed.state, failed.entry);
  store.patchSnapshot({ nativeSessionId: randomUUID(), ...(stop ? { lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() } : {}) }); store.close();
  if (stop && process.platform === "win32") {
    const db = new Database(journalPath);
    try {
      const snapshot = JSON.parse((db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }).snapshot);
      db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...snapshot, lifecycle: "stopping", nativeStopped: false, stoppedAt: null, controllerProcess: { pid: 2_000_000_000, parentPid: 1, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` } }));
    } finally { db.close(); }
    const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
    try { await recordStoppedControllerGeneration(journalPath, ticket, { stateDirectory: home, jobLease: {} as ControllerJobLease }); } finally { confirm.mockRestore(); }
  }
  const inspect = () => {
    const db = new Database(journalPath, { readonly: true });
    try {
      return {
        execution: db.prepare("SELECT snapshot,ticket_hash,owner_pid,CAST(last_sequence AS TEXT) AS through,CAST(last_acknowledged AS TEXT) AS ack FROM execution").get() as { snapshot: string; through: string; ack: string },
        entry: JSON.parse((db.prepare("SELECT value FROM timeline_entries WHERE id=?").get(entryId) as { value: string }).value) as TimelineEntry,
        state: JSON.parse((db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`markdown:projection:${entryId}`) as { value: string }).value),
        plan: db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`stopped_markdown_repair:${entryId}`) as { value: string } | undefined,
        outbox: db.prepare("SELECT value FROM outbox ORDER BY sequence").all(),
      };
    } finally { db.close(); }
  };
  return { home, journalPath, ticket, entryId, text, inspect };
};

test("repairs complete failed Markdown without images, retains original evidence and uploads the original stopped execution", async () => {
  const f = await fixture(), before = f.inspect();
  expect(() => sessionArchiveReferences([before.entry])).toThrow();
  expect(await repairStoppedMarkdownProjections(f)).toEqual({ repaired: [f.entryId], failures: [] });
  const after = f.inspect();
  expect(after.entry).toMatchObject({ entryId: f.entryId, entrySeq: before.entry.entrySeq, revision: "2", imageProjectionError: null, content: [{ type: "markdown", text: f.text, bindings: [] }] });
  expect(after.execution).toEqual({ ...before.execution, through: "2" });
  expect(JSON.parse(after.plan!.value)).toMatchObject({ state: "committed", originalState: before.state, originalEntry: before.entry });
  expect(after.outbox).toHaveLength(2);
  expect(await repairStoppedMarkdownProjections(f)).toEqual({ repaired: [], failures: [] });
  expect(f.inspect()).toEqual(after);
  const bodies: string[] = [], receiver = archiveTestReceiver({ bodies, sourceThrough: "2" });
  expect(await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver.request })).toMatchObject({ state: "ready", completeness: "complete" });
  expect(receiver.entries(bodies[0]!)).toEqual([after.entry]);
  expect(f.inspect().execution).toMatchObject({ ...before.execution, through: "2", ack: "2" });
});

test.each(["startup_timeout", "parse_timeout", "node_limit", "parse_failed"] as const)("a second analysis with %s preserves original bytes and reports the retained reason", async reason => {
  const f = await fixture(), before = f.inspect();
  const projector = createMarkdownImageProjector({ parse: async () => { throw reason === "parse_failed" ? new Error("unavailable parser") : new MarkdownAnalysisError(reason); } });
  expect(await repairStoppedMarkdownProjections({ ...f, projector })).toEqual({ repaired: [], failures: [{ entryId: f.entryId, code: `analysis_${reason}` }] });
  expect(f.inspect()).toEqual(before);
  const db = new Database(f.journalPath, { readonly: true });
  try {
    const diagnostic = JSON.parse((db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`stopped_markdown_failure:${f.entryId}`) as { value: string }).value);
    expect(diagnostic).toMatchObject({ code: `analysis_${reason}`, reasons: [{ reason }], originalStateHash: controllerPayloadHash(before.state), originalEntryHash: controllerPayloadHash(before.entry) });
  } finally { db.close(); }
});

test.each(["active", "claim", "manifest", "archive-intent"])("rejects %s before repairing any entry", async kind => {
  const f = await fixture(undefined, kind !== "active"), before = f.inspect();
  if (kind === "manifest") await unlink(`${f.journalPath}.pending-content/manifest.json`);
  if (kind === "archive-intent") await writeFile(`${f.journalPath}.archive-intent-1.json`, "{}");
  const ticket = kind === "claim" ? { ...f.ticket, claimId: randomUUID() } : f.ticket;
  await expect(repairStoppedMarkdownProjections({ ...f, ticket })).rejects.toThrow();
  expect(f.inspect()).toEqual(before);
});

test("refuses source mutation during asynchronous analysis without overwriting it", async () => {
  const f = await fixture(), before = f.inspect();
  const projector = createMarkdownImageProjector({ parse: async () => {
    const db = new Database(f.journalPath);
    try { db.prepare("UPDATE image_runtime_state SET value=? WHERE key=?").run(JSON.stringify({ ...before.state, token: randomUUID() }), `markdown:projection:${f.entryId}`); } finally { db.close(); }
    return [];
  } });
  expect(await repairStoppedMarkdownProjections({ ...f, projector })).toEqual({ repaired: [], failures: [{ entryId: f.entryId, code: "source_changed" }] });
  const after = f.inspect(); expect(after.entry).toEqual(before.entry); expect(after.execution).toEqual(before.execution); expect(after.state.token).not.toBe(before.state.token); expect(after.plan).toBeUndefined();
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const secondPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const resolveImage: StoppedMarkdownImageResolver = async source => ({
  part: { type: "image", imageId: source.occurrence.imageId, resourceId: source.occurrence.imageId, label: source.part.label },
  resource: { resourceId: source.occurrence.imageId, status: "available", name: "original.png", mediaType: "image/png", byteLength: String(png.length), sha256: createHash("sha256").update(png).digest("hex"), error: null }, bytes: png,
});

test("missing image retains the failed original and a retry reuses its prepared image identity, then archives actual bytes", async () => {
  const f = await fixture("before ![original](original.png) after"), before = f.inspect();
  expect(await repairStoppedMarkdownProjections(f)).toEqual({ repaired: [], failures: [{ entryId: f.entryId, code: "image_source_unavailable" }] });
  const pending = f.inspect(); expect(pending.entry).toEqual(before.entry); expect(pending.state).toEqual(before.state); expect(pending.outbox).toEqual(before.outbox);
  const imageId = JSON.parse(pending.plan!.value).parsedState.parts[0].current[0].occurrence.imageId;
  const resolver = vi.fn(resolveImage);
  expect(await repairStoppedMarkdownProjections({ ...f, resolveImage: resolver })).toEqual({ repaired: [f.entryId], failures: [] });
  expect(resolver.mock.calls[0]![0].occurrence.imageId).toBe(imageId);
  const after = f.inspect(); expect(after.entry).toMatchObject({ content: [{ text: f.text, bindings: [{ part: { type: "image", imageId } }] }] });
  const bodies: string[] = [], receiver = archiveTestReceiver({ bodies, sourceThrough: "2" });
  expect(await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver.request })).toMatchObject({ state: "ready", completeness: "complete" });
  const manifest = JSON.parse(bodies[0]!); expect(receiver.files.get(manifest.resources[0].blobId)).toEqual(png); expect(receiver.entries(bodies[0]!)).toEqual([after.entry]);
});

test("a previously captured image stays retained and can satisfy the same source without a new read", async () => {
  const f = await fixture("before ![original](https://example.test/original.png) after", true, true), before = f.inspect();
  const original = before.state.parts[0].retained[0], unexpectedRead = vi.fn<StoppedMarkdownImageResolver>().mockRejectedValue(new Error("external access forbidden"));
  expect(await repairStoppedMarkdownProjections({ ...f, resolveImage: unexpectedRead })).toEqual({ repaired: [f.entryId], failures: [] });
  expect(unexpectedRead).not.toHaveBeenCalled();
  const after = f.inspect(), part = after.state.parts[0];
  expect(part.retained).toEqual(before.state.parts[0].retained); expect(part.current[0].part.resourceId).toBe(original.part.resourceId);
  expect(part.current[0].occurrence.imageId).not.toBe(original.occurrence.imageId);
  expect(sessionArchiveReferences([after.entry]).resources).toEqual(new Set([original.part.resourceId]));
});

test("repeated destinations reuse the correct original occurrence bytes after the body returns", async () => {
  const f = await fixture("![original](original.png) between ![original](original.png)", true, "repeated"), before = f.inspect();
  const originals = before.state.parts[0].retained;
  expect(originals).toHaveLength(2);
  expect(originals[0].part.resourceId).not.toBe(originals[1].part.resourceId);
  const unexpectedRead = vi.fn<StoppedMarkdownImageResolver>().mockRejectedValue(new Error("original file changed"));
  expect(await repairStoppedMarkdownProjections({ ...f, resolveImage: unexpectedRead })).toEqual({ repaired: [f.entryId], failures: [] });
  expect(unexpectedRead).not.toHaveBeenCalled();
  const after = f.inspect();
  expect(after.state.parts[0].current.map((image: { part: { resourceId: string } }) => image.part.resourceId)).toEqual(originals.map((image: { part: { resourceId: string } }) => image.part.resourceId));
  expect(after.state.parts[0].retained).toEqual(originals);
  const bodies: string[] = [], receiver = archiveTestReceiver({ bodies, sourceThrough: "2" });
  expect(await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver.request })).toMatchObject({ state: "ready", completeness: "complete" });
  const manifest = JSON.parse(bodies[0]!);
  for (const [index, original] of originals.entries()) expect(receiver.files.get(manifest.resources.find((item: { resource: { resourceId: string } }) => item.resource.resourceId === original.part.resourceId).blobId)).toEqual(index === 0 ? png : secondPng);
  expect(receiver.entries(bodies[0]!)).toEqual([after.entry]);
}, 15_000);

test("multiple retained revision lineages for one range refuse repair without choosing old bytes", async () => {
  const f = await fixture("![original](original.png) between ![original](original.png)", true, "ambiguous"), before = f.inspect();
  expect(before.state.parts[0].retained).toHaveLength(4);
  const unexpectedRead = vi.fn<StoppedMarkdownImageResolver>().mockRejectedValue(new Error("ambiguous original"));
  expect(await repairStoppedMarkdownProjections({ ...f, resolveImage: unexpectedRead })).toEqual({ repaired: [], failures: [{ entryId: f.entryId, code: "image_identity_ambiguous" }] });
  expect(unexpectedRead).not.toHaveBeenCalled();
  const after = f.inspect();
  expect(after.entry).toEqual(before.entry); expect(after.state).toEqual(before.state); expect(after.outbox).toEqual(before.outbox); expect(after.execution).toEqual(before.execution);
}, 15_000);

test("interruption after durable analysis keeps the original and resumes the same plan", async () => {
  const f = await fixture("![image](original.png)"), before = f.inspect(), controller = new AbortController();
  await expect(repairStoppedMarkdownProjections({ ...f, signal: controller.signal, resolveImage: async source => { controller.abort(new Error("interrupted")); return resolveImage(source, {} as never); } })).rejects.toThrow("interrupted");
  const interrupted = f.inspect(); expect(interrupted.entry).toEqual(before.entry); expect(interrupted.plan).toBeDefined();
  expect(await repairStoppedMarkdownProjections({ ...f, resolveImage })).toEqual({ repaired: [f.entryId], failures: [] });
  expect(f.inspect().execution.through).toBe("2");
});

test("concurrent repair uses one committed source revision and never replaces the winner", async () => {
  const f = await fixture();
  let resume!: () => void; const blocked = new Promise<void>(resolve => { resume = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const slower = repairStoppedMarkdownProjections({ ...f, projector: createMarkdownImageProjector({ parse: async () => { entered(); await blocked; return []; } }) });
  await started;
  try { expect(await repairStoppedMarkdownProjections(f)).toEqual({ repaired: [f.entryId], failures: [] }); } finally { resume(); }
  expect(await slower).toEqual({ repaired: [], failures: [{ entryId: f.entryId, code: "source_changed" }] });
  expect(f.inspect().execution.through).toBe("2"); expect(f.inspect().entry.revision).toBe("2");
});

test("a failed SQL commit preserves original rows and reuses already published resource bytes after restart", async () => {
  const f = await fixture("![image](original.png)"), before = f.inspect(), open = outbox.openControllerOutbox;
  const injected = vi.spyOn(outbox, "openControllerOutbox").mockImplementation((db, context) => {
    const store = open(db, context);
    return { ...store, append(sequence, value) { store.append(sequence, value); throw new Error("injected after append"); } };
  });
  try { expect(await repairStoppedMarkdownProjections({ ...f, resolveImage })).toMatchObject({ repaired: [], failures: [{ code: "repair_failed" }] }); }
  finally { injected.mockRestore(); }
  const interrupted = f.inspect(); expect(interrupted.entry).toEqual(before.entry); expect(interrupted.state).toEqual(before.state); expect(interrupted.outbox).toEqual(before.outbox); expect(interrupted.execution).toEqual(before.execution);
  const unexpectedRead = vi.fn<StoppedMarkdownImageResolver>().mockRejectedValue(new Error("original source was removed"));
  expect(await repairStoppedMarkdownProjections({ ...f, resolveImage: unexpectedRead })).toEqual({ repaired: [f.entryId], failures: [] });
  expect(unexpectedRead).not.toHaveBeenCalled(); expect(f.inspect().outbox).toHaveLength(2);
});

test("revoked outer execution authorization prevents commit after analysis", async () => {
  const f = await fixture("![image](original.png)"), before = f.inspect(); let revoked = false;
  await expect(repairStoppedMarkdownProjections({ ...f, beforeWrite: async () => { if (revoked) throw new Error("authorization revoked"); }, resolveImage: async (source, context) => { revoked = true; return resolveImage(source, context); } })).rejects.toThrow("authorization revoked");
  const after = f.inspect(); expect(after.entry).toEqual(before.entry); expect(after.state).toEqual(before.state); expect(after.outbox).toEqual(before.outbox); expect(after.execution).toEqual(before.execution);
});

test.each(["missing", "corrupt"])("refuses a %s retained resource blob without removing the failed projection", async kind => {
  const f = await fixture("![image](original.png)"), before = f.inspect(), open = outbox.openControllerOutbox;
  const injected = vi.spyOn(outbox, "openControllerOutbox").mockImplementation((db, context) => {
    const store = open(db, context);
    return { ...store, append() { throw new Error("retain published bytes before SQL commit"); } };
  });
  try { await repairStoppedMarkdownProjections({ ...f, resolveImage }); } finally { injected.mockRestore(); }
  const imageId = JSON.parse(f.inspect().plan!.value).parsedState.parts[0].current[0].occurrence.imageId;
  const blob = path.join(`${f.journalPath}.pending-content`, "blobs", `${createHash("sha256").update(imageId).digest("hex")}.bin`);
  if (kind === "missing") await unlink(blob); else await writeFile(blob, Buffer.alloc(png.length));
  await expect(repairStoppedMarkdownProjections({ ...f, resolveImage })).rejects.toThrow();
  const after = f.inspect(); expect(after.entry).toEqual(before.entry); expect(after.state).toEqual(before.state); expect(after.outbox).toEqual(before.outbox); expect(after.execution).toEqual(before.execution);
});

test.each(["body", "entry", "destination", "retained"])("rejects a changed prepared %s even when its self-reported hash was recomputed", async field => {
  const f = await fixture("![image](original.png)"), before = f.inspect();
  await repairStoppedMarkdownProjections(f);
  const plan = JSON.parse(f.inspect().plan!.value), state = plan.parsedState;
  if (field === "body") state.input.content[0].text = "changed original body";
  if (field === "entry") { state.entryId = randomUUID(); state.input.entryId = state.entryId; }
  if (field === "destination") { state.parts[0].current[0].destination = "other.png"; state.parts[0].cache.occurrences[0].destination = "other.png"; }
  if (field === "retained") state.parts[0].retained.push(state.parts[0].current[0]);
  plan.analysisHash = controllerPayloadHash(state);
  const db = new Database(f.journalPath);
  try { db.prepare("UPDATE image_runtime_state SET value=? WHERE key=?").run(JSON.stringify(plan), `stopped_markdown_repair:${f.entryId}`); } finally { db.close(); }
  const resolver = vi.fn(resolveImage);
  expect(await repairStoppedMarkdownProjections({ ...f, resolveImage: resolver })).toEqual({ repaired: [], failures: [{ entryId: f.entryId, code: "repair_plan_changed" }] });
  expect(resolver).not.toHaveBeenCalled();
  const after = f.inspect(); expect(after.entry).toEqual(before.entry); expect(after.state).toEqual(before.state); expect(after.outbox).toEqual(before.outbox); expect(after.execution).toEqual(before.execution);
});
