import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import Database from "better-sqlite3";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { validateImageFile } from "../../../src/commands/controller/media/image-validation.js";
import type { ImageDecoder } from "../../../src/commands/controller/media/image-decoder.js";
import type { SessionCommand } from "../../../src/session/protocol.js";
import type { ImageUploadSpec } from "../../../src/session/image-values.js";
const faults = vi.hoisted(() => ({ partialWrite: false, freeBytes: null as bigint | null }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeSync: (...args: unknown[]) => {
    if (faults.partialWrite) {
      faults.partialWrite = false;
      fs.writeSync(args[0] as number, args[1] as Uint8Array, 0, 3, args[4] as number);
      throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    }
    return Reflect.apply(fs.writeSync, fs, args);
  }, statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
    const value = fs.statfsSync(...args);
    return faults.freeBytes === null ? value : { ...value, bavail: faults.freeBytes / BigInt(value.bsize) };
  } };
});
const roots: string[] = [];
afterEach(async () => { faults.partialWrite = false; faults.freeBytes = null; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async (imageDecoder: ImageDecoder = validateImageFile) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-preparation-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "i-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const bytes = await sharp({ create: { width: 23, height: 19, channels: 4, background: "blue" } }).png().toBuffer();
  const spec: ImageUploadSpec = { uploadId: randomUUID(), imageId: randomUUID(), target: { serverOrigin: ticket.serverOrigin, actorUserId: ticket.userId!, fence: { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1" }, expectedNativeSessionId: "native" }, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") };
  const file = path.join(home, "journal.sqlite"), options = { imageDecoder };
  const store = openControllerLifecycleStore(file, ticket, options); store.patchSnapshot({ nativeSessionId: "native" });
  return { file, home, ticket, bytes, spec, options, store };
};
const registerSource = (f: Awaited<ReturnType<typeof fixture>>) => {
  const entryId = randomUUID(), imageId = randomUUID();
  f.store.projectTimeline({ entryId, kind: "assistant_message", revision: "1", content: [{ type: "text", text: "image source" }] });
  const occurrence = { imageId, entryId, container: "content" as const, partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "source" };
  f.store.registerImageOccurrence(occurrence, null); f.store.acknowledgeEvents(f.store.getLastSourceSequence());
  const request = { captureId: randomUUID(), attemptId: randomUUID(), occurrence, nativeSource: null, locator: { kind: "local" as const, path: path.join(f.home, "image.png"), contextId: randomUUID() } };
  f.store.registerImageCaptureRequest(request); return request;
};

test("native staging, reserved Markdown staging and upload completion share one decoder without losing images", async () => {
  let entered!: () => void, finish!: () => void, active = 0, peak = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  const calls: string[] = [];
  const f = await fixture(async (request, signal) => {
    calls.push(request.inputPath); active++; peak = Math.max(peak, active);
    try { if (calls.length === 1) { entered(); await gate; } signal?.throwIfAborted(); return await validateImageFile(request); }
    finally { active--; }
  });
  const media = f.store.media(), native = registerSource(f), markdown = registerSource(f);
  const { writeFile } = await import("node:fs/promises");
  const inputPath = path.join(f.home, "native.png"); await writeFile(inputPath, f.bytes, { mode: 0o400 });
  const source = media.reserveCaptureSource(markdown.captureId, markdown.attemptId);
  await source.runWriter(filename => appendFile(filename, f.bytes));
  await media.prepare(f.spec); await media.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") });
  const stage = (request: typeof native, filename: string) => media.stageCapture({ captureId: request.captureId, attemptId: request.attemptId, imageId: request.occurrence.imageId, inputPath: filename, byteLength: f.spec.byteLength, sha256: f.spec.sha256 });
  const nativeWork = stage(native, inputPath);
  const pending: Promise<unknown>[] = [nativeWork];
  try {
    await started;
    const markdownWork = stage(markdown, source.outputPath), uploadWork = media.complete(f.spec);
    pending.push(markdownWork, uploadWork);
    // Observe both outcomes immediately, including a refusal before the gate opens.
    const outcomes = Promise.allSettled(pending);
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    finish();
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: expect.objectContaining({ sha256: f.spec.sha256 }) },
      { status: "fulfilled", value: expect.objectContaining({ sha256: f.spec.sha256 }) },
      { status: "fulfilled", value: expect.objectContaining({ state: "validated" }) },
    ]);
    expect(peak).toBe(1); expect(calls).toHaveLength(3);
    await source.release();
    expect(await media.readCapture({ captureId: markdown.captureId, attemptId: markdown.attemptId, sha256: f.spec.sha256, byteLength: f.spec.byteLength, offset: "0", limit: 524288 }, () => ({ verify() {}, close() {} }))).toMatchObject({ data: f.bytes.toString("base64") });
    expect(await media.readPrepared({ preparationId: f.spec.uploadId, offset: "0", limit: 524288 })).toMatchObject({ data: f.bytes.toString("base64") });
  } finally { finish(); await Promise.allSettled(pending); await media.close(); f.store.close(); }
});

test("release removes a queued upload and stop joins the active decoder before closing media", async () => {
  let entered!: () => void, finish!: () => void, calls = 0, aborted = false;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(async (request, signal) => {
    calls++; signal?.addEventListener("abort", () => { aborted = true; }, { once: true }); entered(); await gate;
    signal?.throwIfAborted(); return validateImageFile(request);
  });
  const media = f.store.media(), requests = [registerSource(f), registerSource(f)];
  const sources = requests.map(request => media.reserveCaptureSource(request.captureId, request.attemptId));
  await Promise.all(sources.map(source => source.runWriter(filename => appendFile(filename, f.bytes))));
  await media.prepare(f.spec); await media.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") });
  const stage = (index: number) => media.stageCapture({ captureId: requests[index]!.captureId, attemptId: requests[index]!.attemptId, imageId: requests[index]!.occurrence.imageId, inputPath: sources[index]!.outputPath, byteLength: f.spec.byteLength, sha256: f.spec.sha256 });
  const active = stage(0), pending: Promise<unknown>[] = [active];
  let stopping: Promise<void> | undefined;
  try {
    await started;
    const upload = media.complete(f.spec), queued = stage(1); pending.push(upload, queued);
    const outcomes = Promise.allSettled(pending);
    await expect(media.release({ uploadId: f.spec.uploadId })).resolves.toMatchObject({ state: "released" });
    expect(await upload).toMatchObject({ state: "failed" });
    let closed = false;
    stopping = media.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(aborted).toBe(true); expect(closed).toBe(false); expect(calls).toBe(1);
    expect(await readFile(sources[0]!.outputPath)).toEqual(f.bytes);
    finish(); await stopping;
    expect(await outcomes).toEqual([
      { status: "rejected", reason: expect.any(Error) },
      { status: "fulfilled", value: expect.objectContaining({ state: "failed" }) },
      { status: "rejected", reason: expect.objectContaining({ message: "Controller media stopped." }) },
    ]);
    expect(calls).toBe(1);
  } finally { finish(); await Promise.allSettled(pending); await stopping; await media.close(); f.store.close(); }
});

test("queued capture checks the current attempt before copying or decoding its source", async () => {
  let entered!: () => void, finish!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(async (request, signal) => { calls++; entered(); await gate; signal?.throwIfAborted(); return validateImageFile(request); });
  const media = f.store.media(), request = registerSource(f), source = media.reserveCaptureSource(request.captureId, request.attemptId);
  await source.runWriter(filename => appendFile(filename, f.bytes));
  await media.prepare(f.spec); await media.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") });
  const active = media.complete(f.spec);
  let pending: Promise<unknown> | undefined;
  try {
    await started;
    pending = media.stageCapture({ captureId: request.captureId, attemptId: request.attemptId, imageId: request.occurrence.imageId, inputPath: source.outputPath, byteLength: f.spec.byteLength, sha256: f.spec.sha256 });
    const refusal = expect(pending).rejects.toThrow("attempt conflict");
    f.store.retryImageCaptureRequest(request.captureId, randomUUID());
    // A read here would fail differently; stale queued work must stop at identity.
    await rm(source.outputPath);
    finish(); await active; await refusal;
    expect(calls).toBe(1);
    await source.release();
  } finally { finish(); await Promise.allSettled([active, ...(pending ? [pending] : [])]); await media.close(); f.store.close(); }
});

test("durable source release returns both shared slots after a free-space failure", async () => {
  const f = await fixture(), media = f.store.media(), requests = [registerSource(f), registerSource(f)];
  const leases = requests.map(request => media.reserveCaptureSource(request.captureId, request.attemptId));
  const db = new Database(f.file, { readonly: true });
  let capture: ReturnType<typeof media.reserveCaptureSource> | undefined;
  const blocks: { close(): void }[] = [];
  try {
    expect(media.tryAcquireMediaBlock()).toBeNull();
    faults.freeBytes = 0n;
    for (const lease of leases) await expect(lease.release()).rejects.toThrow("free-space budget exceeded");
    for (const request of requests) {
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`capture-source:${request.captureId}:${request.attemptId}`) as { value: string };
      expect(JSON.parse(row.value)).toMatchObject({ released: true });
    }
    faults.freeBytes = null;
    const uploadBlock = media.tryAcquireMediaBlock(), readBlock = media.tryAcquireMediaBlock();
    if (uploadBlock) blocks.push(uploadBlock); if (readBlock) blocks.push(readBlock);
    expect(uploadBlock).not.toBeNull(); expect(readBlock).not.toBeNull();
    await media.prepare(f.spec);
    expect(await media.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") })).toMatchObject({ acceptedOffset: f.spec.byteLength });
    expect(await media.complete({ uploadId: f.spec.uploadId, byteLength: f.spec.byteLength, sha256: f.spec.sha256 })).toMatchObject({ state: "validated" });
    expect(await media.readPrepared({ preparationId: f.spec.uploadId, offset: "0", limit: 524288 })).toMatchObject({ data: f.bytes.toString("base64"), eof: true });
    for (const lease of leases) await lease.release();
    for (const request of requests) await media.releaseCaptureSource(request.captureId, request.attemptId);
    expect(media.tryAcquireMediaBlock()).toBeNull();
    blocks.splice(0).forEach(block => block.close());
    const request = registerSource(f); capture = media.reserveCaptureSource(request.captureId, request.attemptId);
    await capture.runWriter(filename => appendFile(filename, f.bytes));
    const validated = await media.stageCapture({ captureId: request.captureId, attemptId: request.attemptId, imageId: request.occurrence.imageId, inputPath: capture.outputPath, byteLength: f.spec.byteLength, sha256: f.spec.sha256 });
    await capture.release();
    expect(await media.readCapture({ captureId: request.captureId, attemptId: request.attemptId, ...validated, offset: "0", limit: 524288 }, () => ({ verify() {}, close() {} }))).toMatchObject({ data: f.bytes.toString("base64"), eof: true });
    await media.close(); await media.close();
  } finally { faults.freeBytes = null; blocks.forEach(block => block.close()); db.close(); await media.close(); f.store.close(); }
});

test.each(["writer", "stage"] as const)("source release keeps its shared slot until the %s joins despite a later budget failure", async phase => {
  let finish!: () => void, entered!: () => void, joined = false, aborted = false;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(async request => { entered(); await gate; const result = await validateImageFile(request); joined = true; return result; });
  const media = f.store.media(), request = registerSource(f), source = media.reserveCaptureSource(request.captureId, request.attemptId), transfer = media.tryAcquireMediaBlock()!;
  let work: Promise<unknown> | undefined, releasing: Promise<unknown> | undefined;
  try {
    const writer = source.runWriter(async (filename, signal) => {
      await appendFile(filename, f.bytes);
      if (phase === "writer") { signal.addEventListener("abort", () => { aborted = true; }, { once: true }); entered(); await gate; joined = true; }
    });
    if (phase === "writer") work = writer;
    else {
      await writer;
      work = media.stageCapture({ captureId: request.captureId, attemptId: request.attemptId, imageId: request.occurrence.imageId, inputPath: source.outputPath, byteLength: f.spec.byteLength, sha256: f.spec.sha256 });
    }
    await started;
    let settled = false;
    releasing = source.release().then(() => { settled = true; }, error => { settled = true; return error; });
    faults.freeBytes = 0n;
    expect(await readFile(source.outputPath)).toEqual(f.bytes);
    expect(joined).toBe(false); expect(settled).toBe(false); expect(media.tryAcquireMediaBlock()).toBeNull();
    if (phase === "writer") expect(aborted).toBe(true);
    finish(); await work;
    expect(await releasing).toEqual(expect.objectContaining({ message: "Controller media storage free-space budget exceeded." }));
    expect(joined).toBe(true);
    await expect(stat(source.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    faults.freeBytes = null;
    const available = media.tryAcquireMediaBlock(); expect(available).not.toBeNull(); available!.close();
    if (phase === "stage") expect(await media.readCapture({ captureId: request.captureId, attemptId: request.attemptId, byteLength: f.spec.byteLength, sha256: f.spec.sha256, offset: "0", limit: 524288 }, () => ({ verify() {}, close() {} }))).toMatchObject({ data: f.bytes.toString("base64") });
  } finally { finish(); faults.freeBytes = null; await Promise.allSettled([work, releasing]); transfer.close(); await media.close(); f.store.close(); }
});

test("source release retains its shared slot until the released marker is durably saved", async () => {
  const f = await fixture(), media = f.store.media(), request = registerSource(f), source = media.reserveCaptureSource(request.captureId, request.attemptId);
  const transfer = media.tryAcquireMediaBlock()!, db = new Database(f.file), key = `capture-source:${request.captureId}:${request.attemptId}`;
  db.exec("CREATE TRIGGER reject_source_release BEFORE INSERT ON image_runtime_state WHEN NEW.key LIKE 'capture-source:%' AND json_extract(NEW.value,'$.released')=1 BEGIN SELECT RAISE(FAIL, 'source release save failed'); END");
  try {
    await expect(source.release()).rejects.toThrow("source release save failed");
    expect(JSON.parse((db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string }).value)).toMatchObject({ released: false });
    expect(media.tryAcquireMediaBlock()).toBeNull();
    db.exec("DROP TRIGGER reject_source_release");
    await source.release();
    const available = media.tryAcquireMediaBlock(); expect(available).not.toBeNull();
    try { await source.release(); await media.releaseCaptureSource(request.captureId, request.attemptId); expect(media.tryAcquireMediaBlock()).toBeNull(); }
    finally { available!.close(); }
  } finally { db.close(); transfer.close(); await media.close(); await media.close(); f.store.close(); }
});
test("preparation persists exact chunk receipts, fully decodes, and does not publish service availability", async () => {
  const f = await fixture(); const media = f.store.media();
  try {
    expect(await media.prepare(f.spec)).toMatchObject({ state: "receiving", acceptedOffset: "0", validated: null });
    const chunk = { uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") };
    expect(await media.write(chunk)).toMatchObject({ acceptedOffset: f.spec.byteLength });
    expect(await media.write(chunk)).toMatchObject({ acceptedOffset: f.spec.byteLength });
    await expect(media.write({ ...chunk, data: Buffer.from("different").toString("base64") })).rejects.toThrow();
    const complete = await media.complete({ uploadId: f.spec.uploadId, byteLength: f.spec.byteLength, sha256: f.spec.sha256 });
    expect(complete).toMatchObject({ state: "validated", validated: { width: 23, height: 19, frameCount: 1, sha256: f.spec.sha256 } });
    expect(complete).not.toHaveProperty("resource");
    expect(await media.readPrepared({ preparationId: f.spec.uploadId, offset: "0", limit: 524288 })).toMatchObject({ data: f.bytes.toString("base64"), eof: true });
    await expect(media.prepare({ ...f.spec, name: "changed.png" })).rejects.toThrow("conflict");
  } finally { await media.close(); f.store.close(); }
});
test("restart discards only an uncommitted file suffix and preserves the original preparation identity", async () => {
  const f = await fixture(); const media = f.store.media();
  await media.prepare(f.spec); await media.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") });
  const filename = media.preparationPath(f.spec.uploadId); await media.close(); f.store.close();
  await appendFile(filename, Buffer.from("uncommitted suffix"));
  const store = openControllerLifecycleStore(f.file, f.ticket, f.options); const recovered = store.media();
  try {
    expect(await recovered.status({ uploadId: f.spec.uploadId })).toMatchObject({ acceptedOffset: f.spec.byteLength, state: "receiving" });
    expect(await readFile(filename)).toEqual(f.bytes);
    expect(await recovered.release({ uploadId: f.spec.uploadId })).toMatchObject({ state: "released" });
    await expect(readFile(filename)).rejects.toThrow();
  } finally { await recovered.close(); store.close(); }
});
test("the second unavailable input prevents every native call and releases all acquired read leases", async () => {
  const f = await fixture(); const media = f.store.media();
  try {
    await media.prepare(f.spec); await media.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") });
    await media.complete({ uploadId: f.spec.uploadId, byteLength: f.spec.byteLength, sha256: f.spec.sha256 });
    let calls = 0;
    const image = { type: "image" as const, imageId: f.spec.imageId, uploadId: f.spec.uploadId, resourceId: randomUUID(), byteLength: f.spec.byteLength, sha256: f.spec.sha256 };
    const input = { content: [image, { ...image, imageId: randomUUID(), uploadId: randomUUID(), resourceId: randomUUID() }], expectedTurnId: null, target: f.spec.target, expectedImageCapabilityRevision: "1", draftId: randomUUID(), draftRevision: "1" };
    const command = { protocol: "daynight.session.v1", contentRevision: 2, requestId: randomUUID(), operationId: randomUUID(), sessionId: f.ticket.sessionId, claimId: f.ticket.claimId, executionGeneration: f.ticket.executionGeneration, kind: "send_message", payload: input } as SessionCommand;
    f.store.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: input, intent: command });
    await expect((async () => { const lease = await media.acquireInput(input, command.operationId); try { calls++; } finally { lease.close(); } })()).rejects.toThrow("preparation");
    f.store.recordOperation(command.operationId, "rejected");
    expect(calls).toBe(0);
    expect(await media.release({ uploadId: f.spec.uploadId })).toMatchObject({ state: "released" });
  } finally { await media.close(); f.store.close(); }
});

test("capture staging waits for the original occurrence ACK and keeps immutable private bytes across restart", async () => {
  const f = await fixture(); const media = f.store.media(); const captureId = randomUUID(), attemptId = randomUUID(), imageId = randomUUID(), entryId = randomUUID();
  const inputPath = path.join(f.home, "capture.png");
  const { writeFile } = await import("node:fs/promises"); await writeFile(inputPath, f.bytes, { mode: 0o400 });
  const input = { captureId, attemptId, imageId, inputPath, byteLength: f.spec.byteLength, sha256: f.spec.sha256 };
  try {
    f.store.projectTimeline({ entryId, kind: "assistant_message", revision: "1", content: [{ type: "text", text: "image" }] });
    const occurrence = { imageId, entryId, container: "content" as const, partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "provider-part" };
    expect(f.store.registerImageOccurrence(occurrence, null).acknowledged).toBe(false);
    const request = { captureId, attemptId, occurrence, nativeSource: null, locator: { kind: "local" as const, path: inputPath, contextId: randomUUID() } };
    expect(() => f.store.registerImageCaptureRequest(request)).toThrow("acknowledged");
    await expect(media.stageCapture(input)).rejects.toThrow("registered original request");
    f.store.acknowledgeEvents(f.store.getLastSourceSequence());
    f.store.registerImageCaptureRequest(request);
    expect(await media.stageCapture(input)).toMatchObject({ width: 23, height: 19, sha256: f.spec.sha256 });
    await (await import("node:fs/promises")).chmod(inputPath, 0o600); await writeFile(inputPath, Buffer.from("changed"));
    expect(await media.readCapture({ captureId, attemptId, sha256: input.sha256, byteLength: input.byteLength, offset: "0", limit: 524288 }, () => ({ verify() {}, close() {} }))).toMatchObject({ preparationId: attemptId, data: f.bytes.toString("base64"), eof: true });
    await media.close(); f.store.close();
    const reopened = openControllerLifecycleStore(f.file, f.ticket, f.options); const saved = reopened.media();
    try { expect(await saved.readCapture({ captureId, attemptId, sha256: input.sha256, byteLength: input.byteLength, offset: "0", limit: 524288 }, () => ({ verify() {}, close() {} }))).toMatchObject({ data: f.bytes.toString("base64") }); }
    finally { await saved.close(); reopened.close(); }
  } finally { await f.store.stopMedia(); f.store.close(); }
});

test("release cancels and joins a decoder before removing its private original", async () => {
  const f = await fixture(); await f.store.stopMedia(); f.store.close();
  let entered!: () => void, finish!: () => void, aborted = false; const started = new Promise<void>(resolve => { entered = resolve; });
  const decoder = async (_request: unknown, signal?: AbortSignal) => { entered(); await new Promise<void>(resolve => { finish = resolve; signal?.addEventListener("abort", () => { aborted = true; }, { once: true }); }); throw Error("decoder stopped"); };
  const store = openControllerLifecycleStore(f.file, f.ticket, { imageDecoder: decoder }); const media = store.media();
  try {
    await media.prepare(f.spec); await media.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") });
    const pending = media.complete({ uploadId: f.spec.uploadId, byteLength: f.spec.byteLength, sha256: f.spec.sha256 }); await started;
    let released = false; const release = media.release({ uploadId: f.spec.uploadId }).then(result => { released = true; return result; });
    await new Promise(resolve => setImmediate(resolve)); expect(aborted).toBe(true); expect(released).toBe(false);
    expect(await readFile(media.preparationPath(f.spec.uploadId))).toEqual(f.bytes);
    finish(); await pending; expect(await release).toMatchObject({ state: "released" });
  } finally { await media.close(); store.close(); }
});

test("undispatched leases can be reacquired but unknown native and resume pins survive close and restart", async () => {
  const decoder = vi.fn(validateImageFile);
  const f = await fixture(decoder); const media = f.store.media();
  await media.prepare(f.spec); await media.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") });
  await media.complete({ uploadId: f.spec.uploadId, byteLength: f.spec.byteLength, sha256: f.spec.sha256 });
  const resourceId = randomUUID(); const input = { content: [{ type: "image" as const, imageId: f.spec.imageId, uploadId: f.spec.uploadId, resourceId, sha256: f.spec.sha256, byteLength: f.spec.byteLength }], expectedTurnId: null, target: f.spec.target, expectedImageCapabilityRevision: "1", draftId: randomUUID(), draftRevision: "1" };
  const command = { protocol: "daynight.session.v1", contentRevision: 2, requestId: randomUUID(), operationId: randomUUID(), sessionId: f.ticket.sessionId, claimId: f.ticket.claimId, executionGeneration: f.ticket.executionGeneration, kind: "send_message", payload: input } as SessionCommand;
  f.store.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: input, intent: command });
  try {
    const first = await media.acquireInput(input, command.operationId); const firstImage = first.input.content.find(part => part.type === "image")!;
    expect(firstImage.validated).toEqual({ mediaType: "image/png", byteLength: f.spec.byteLength, sha256: f.spec.sha256, width: 23, height: 19, frameCount: 1 });
    expect(Object.isFrozen(firstImage.validated)).toBe(true);
    first.verify();
    await expect(media.acquireInput(input, command.operationId)).rejects.toThrow("already has");
    first.close(); await expect(readFile(firstImage.localPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(media.read({ resourceId, offset: "0", limit: 524288 })).rejects.toThrow("unavailable");
    const second = await media.acquireInput(input, command.operationId); const retained = second.input.content.find(part => part.type === "image")!;
    expect(retained.validated).toEqual(firstImage.validated);
    second.verify();
    expect(decoder).toHaveBeenCalledOnce();
    const original = path.join(`${f.file}.pending-content`, "blobs", `${createHash("sha256").update(resourceId).digest("hex")}.bin`);
    const [originalStat, nativeStat] = await Promise.all([stat(original), stat(retained.localPath)]);
    expect([nativeStat.dev, nativeStat.ino]).toEqual([originalStat.dev, originalStat.ino]);
    f.store.markDispatching(command.operationId); second.retain(); f.store.recordOperation(command.operationId, "unknown"); second.close();
    await media.close(); f.store.close(); expect(await readFile(retained.localPath)).toEqual(f.bytes);
    const reopened = openControllerLifecycleStore(f.file, f.ticket, f.options); const recovered = reopened.media();
    try {
      await expect(recovered.acquireInput(input, command.operationId)).rejects.toThrow("undispatched original");
      await expect(recovered.release({ uploadId: f.spec.uploadId })).rejects.toThrow("in_use");
      expect(await recovered.read({ resourceId, offset: "0", limit: 524288 })).toMatchObject({ data: f.bytes.toString("base64") });
      expect(await readFile(retained.localPath)).toEqual(f.bytes);
    } finally { await recovered.close(); reopened.close(); }
  } finally { await f.store.stopMedia(); f.store.close(); }
});

test("ENOSPC retains the confirmed offset and restart removes only the uncommitted partial write", async () => {
  const f = await fixture(); const media = f.store.media();
  await media.prepare(f.spec);
  const filename = media.preparationPath(f.spec.uploadId);
  faults.partialWrite = true;
  await expect(media.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") })).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await media.status({ uploadId: f.spec.uploadId })).toMatchObject({ state: "receiving", acceptedOffset: "0" });
  expect(await readFile(filename)).toEqual(f.bytes.subarray(0, 3));
  await media.close(); f.store.close();
  const reopened = openControllerLifecycleStore(f.file, f.ticket, f.options); const recovered = reopened.media();
  try {
    expect(await readFile(filename)).toHaveLength(0);
    expect(await recovered.write({ uploadId: f.spec.uploadId, offset: "0", sha256: f.spec.sha256, data: f.bytes.toString("base64") })).toMatchObject({ acceptedOffset: f.spec.byteLength });
    expect(await recovered.complete({ uploadId: f.spec.uploadId, byteLength: f.spec.byteLength, sha256: f.spec.sha256 })).toMatchObject({ state: "validated" });
  } finally { await recovered.close(); reopened.close(); }
});
