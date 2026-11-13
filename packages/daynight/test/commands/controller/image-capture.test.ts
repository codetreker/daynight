import { afterEach, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { createControllerCaptureBridge } from "../../../src/commands/controller/media/capture.js";
import { ImageCaptureNotDispatchedError } from "../../../src/commands/controller/media/capture-error.js";
import { ImageHistorySyncFailedError } from "../../../src/commands/controller/media/history-sync.js";
import { createMarkdownCaptureCoordinator } from "../../../src/commands/controller/markdown/coordinator.js";
import { validateImageFile } from "../../../src/commands/controller/media/image-validation.js";
import type { NativeProvider } from "../../../src/commands/controller/providers/types.js";
import type { ImageCaptureReceipt, ImageCaptureRequest } from "../../../src/session/image-values.js";
import type { createControllerRelay } from "../../../src/commands/controller/relay.js";
const disk = vi.hoisted(() => ({ freeBytes: null as bigint | null }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
    const value = fs.statfsSync(...args);
    return disk.freeBytes === null ? value : { ...value, bavail: disk.freeBytes / BigInt(value.bsize) };
  } };
});
const policy = () => ({ verify() {}, close() {} });
const roots: string[] = [];
afterEach(async () => { disk.freeBytes = null; await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-capture-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "c-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const file = path.join(home, "journal.sqlite"), options = { imageDecoder: validateImageFile };
  const journal = openControllerLifecycleStore(file, ticket, options); journal.patchSnapshot({ nativeSessionId: "native" });
  const entryId = randomUUID(), imageId = randomUUID();
  journal.projectTimeline({ entryId, kind: "assistant_message", revision: "1", content: [{ type: "text", text: "original occurrence" }] });
  const occurrence = { imageId, entryId, container: "content" as const, partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-native-part" };
  journal.registerImageOccurrence(occurrence, null); journal.acknowledgeEvents(journal.getLastSourceSequence());
  const request: ImageCaptureRequest = { captureId: randomUUID(), attemptId: randomUUID(), occurrence, nativeSource: null, locator: { kind: "local", path: "/original/unchanged.png", contextId: randomUUID() } };
  const resourceId = randomUUID();
  const receipt = (patch: Partial<ImageCaptureReceipt> = {}): ImageCaptureReceipt => ({ captureId: request.captureId, attemptId: request.attemptId, revision: "1", occurrence, state: "reserved", resourceId, resource: null, error: null, ...patch });
  const source = async (color: string) => {
    const bytes = await sharp({ create: { width: 23, height: 19, channels: 4, background: color } }).png().toBuffer(), inputPath = path.join(home, `${randomUUID()}.png`);
    await writeFile(inputPath, bytes, { mode: 0o400 });
    return { inputPath, byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  };
  return { home, file, ticket, options, journal, request, receipt, source };
};
const bridge = (journal: ReturnType<typeof openControllerLifecycleStore>, capture: ReturnType<typeof createControllerRelay>["capture"], provider: NativeProvider | null = null) => createControllerCaptureBridge({ journal, capture, beforeCapture: async () => {}, provider: () => provider, writable: () => true });

test("direct submission freezes the original business before dispatch and reuses sealed bytes after reopen", async () => {
  const f = await fixture(), source = await f.source("blue"), lost = new Error("Submit receipt was lost");
  const capture = vi.fn<ReturnType<typeof createControllerRelay>["capture"]>().mockRejectedValue(lost);
  const consumer = bridge(f.journal, capture);
  await consumer.providerOptions.prepareImageCapture!(f.request);
  const validated = await consumer.providerOptions.stageImageCapture!({ ...source, captureId: f.request.captureId, attemptId: f.request.attemptId, imageId: f.request.occurrence.imageId });
  const submission = { request: f.request, attemptId: f.request.attemptId, outcome: { kind: "validated" as const, validated } };
  try {
    expect(capture).not.toHaveBeenCalled();
    await expect(consumer.providerOptions.submitImageCapture!(submission)).rejects.toBe(lost);
    expect(capture).toHaveBeenCalledExactlyOnceWith("submit", submission);
  } finally { await f.journal.stopMedia(); f.journal.close(); }
  await rm(source.inputPath);
  const journal = openControllerLifecycleStore(f.file, f.ticket, f.options);
  const replay = vi.fn<ReturnType<typeof createControllerRelay>["capture"]>().mockResolvedValue(f.receipt({ state: "copying" }));
  try {
    await expect(bridge(journal, replay).providerOptions.submitImageCapture!(submission)).resolves.toMatchObject({ state: "copying" });
    expect(replay).toHaveBeenCalledExactlyOnceWith("submit", submission);
    const bytes = await journal.media().readCapture({ captureId: f.request.captureId, attemptId: f.request.attemptId, sha256: validated.sha256, byteLength: validated.byteLength, offset: "0", limit: 524288 }, policy);
    expect(bytes.data).toBe(source.bytes.toString("base64"));
    await expect(bridge(journal, replay).providerOptions.submitImageCapture!({ ...submission, outcome: { kind: "failed", error: { code: "changed", message: "Changed outcome" } } })).rejects.toThrow("frozen outcome");
    expect(replay).toHaveBeenCalledOnce();
  } finally { await journal.stopMedia(); journal.close(); }
});

test.each(["missing", "corrupt"] as const)("direct replay refuses %s sealed files while retaining the frozen identity", async kind => {
  const f = await fixture(), source = await f.source("blue"), capture = vi.fn<ReturnType<typeof createControllerRelay>["capture"]>().mockRejectedValue(new Error("Original receipt lost"));
  const consumer = bridge(f.journal, capture);
  try {
    await consumer.providerOptions.prepareImageCapture!(f.request);
    const validated = await consumer.providerOptions.stageImageCapture!({ ...source, captureId: f.request.captureId, attemptId: f.request.attemptId, imageId: f.request.occurrence.imageId });
    const submission = { request: f.request, attemptId: f.request.attemptId, outcome: { kind: "validated" as const, validated } };
    await expect(consumer.providerOptions.submitImageCapture!(submission)).rejects.toThrow("receipt lost");
    const db = new Database(f.file, { readonly: true });
    let filename: string;
    try { filename = (db.prepare("SELECT filename FROM image_captures WHERE capture_id=?").get(`${f.request.captureId}:${f.request.attemptId}`) as { filename: string }).filename; } finally { db.close(); }
    const sealed = path.join(`${f.file}.media-staging`, filename);
    await chmod(sealed, 0o600);
    if (kind === "missing") await rm(sealed); else await writeFile(sealed, Buffer.alloc(source.bytes.length));
    await rm(source.inputPath);
    expect(f.journal.media().captureStatus(f.request.captureId, f.request.attemptId)).toEqual(validated);
    await expect(consumer.providerOptions.submitImageCapture!(submission)).rejects.toThrow(kind === "missing" ? "ENOENT" : "digest differs");
    expect(capture).toHaveBeenCalledOnce();
    expect(f.journal.freezeImageCaptureSubmission(submission)).toEqual(submission);
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});

test("history synchronization failures cannot be mistaken for an unknown capture dispatch", async () => {
  const f = await fixture(), lost = new Error("History response lost");
  const beforeCapture = vi.fn().mockRejectedValueOnce(lost).mockResolvedValueOnce(undefined);
  const capture = vi.fn(async () => f.receipt());
  const consumer = createControllerCaptureBridge({ journal: f.journal, capture, beforeCapture, provider: () => null, writable: () => true });
  try {
    const failure = await consumer.providerOptions.registerImageCapture!(f.request).catch(error => error);
    expect(failure).toBeInstanceOf(ImageCaptureNotDispatchedError);
    expect(failure.cause).toBe(lost); expect(capture).not.toHaveBeenCalled();
    expect(f.journal.getImageCaptureRequest(f.request.captureId)).toEqual(f.request);
    expect(await consumer.providerOptions.registerImageCapture!(f.request)).toEqual(f.receipt());
    expect(capture).toHaveBeenCalledExactlyOnceWith("register", f.request);
    const refused = new ImageHistorySyncFailedError({ code: "quota_exceeded", message: "History capacity exhausted." });
    beforeCapture.mockRejectedValueOnce(refused);
    await expect(consumer.providerOptions.registerImageCapture!(f.request)).rejects.toMatchObject({ name: "ImageCapturePrerequisiteError", code: "quota_exceeded", message: "History capacity exhausted." });
    expect(capture).toHaveBeenCalledOnce();
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});

test("an unknown register survives reopen and observes only the original capture identity", async () => {
  const f = await fixture(), calls: unknown[] = [];
  const capture: ReturnType<typeof createControllerRelay>["capture"] = async (action, body) => { calls.push({ action, body }); throw new Error("Lost committed register receipt"); };
  try { await expect(bridge(f.journal, capture).providerOptions.registerImageCapture!(f.request)).rejects.toThrow("Lost committed"); }
  finally { f.journal.close(); }
  const journal = openControllerLifecycleStore(f.file, f.ticket, f.options);
  try {
    expect(journal.getImageCaptureRequest(f.request.captureId)).toEqual(f.request);
    const query: ReturnType<typeof createControllerRelay>["capture"] = async (action, body) => { calls.push({ action, body }); return f.receipt(); };
    expect(await bridge(journal, query).providerOptions.queryImageCapture!(f.request.captureId)).toEqual(f.receipt());
    expect(calls).toEqual([{ action: "register", body: f.request }, { action: "query", body: { captureId: f.request.captureId } }]);
    expect(() => journal.registerImageCaptureRequest({ ...f.request, locator: { ...f.request.locator, path: "/changed" } as ImageCaptureRequest["locator"] })).toThrow("conflict");
  } finally { journal.close(); }
});

test.each(["local", "external"] as const)("provider %s retries preserve the original locator, isolate attempt bytes and reuse a frozen successful attempt", async kind => {
  const f = await fixture(), original = await f.source("blue"), replacement = await f.source("red"), attemptId = randomUUID();
  if (kind === "external") f.request = { ...f.request, locator: { kind, url: "https://images.example/original.png" } };
  let current = f.receipt(); const calls: unknown[] = [];
  const capture: ReturnType<typeof createControllerRelay>["capture"] = async (action, body) => { calls.push({ action, body }); return current; };
  const release = vi.fn(), resolver = vi.fn(async () => ({ ...replacement, release })), send = vi.fn();
  const provider = { retryImageCapture: resolver, send } as unknown as NativeProvider;
  const consumer = bridge(f.journal, capture, provider);
  try {
    await consumer.providerOptions.registerImageCapture!(f.request);
    const first = await consumer.providerOptions.stageImageCapture!({ ...original, captureId: f.request.captureId, attemptId: f.request.attemptId, imageId: f.request.occurrence.imageId });
    current = f.receipt({ revision: "2", state: "failed", resourceId: null, error: { code: "decode_failed", message: "Original copy failed" } });
    await consumer.providerOptions.failImageCapture!(f.request.captureId, f.request.attemptId, current.error!);
    const validated = await consumer.retry({ captureId: f.request.captureId, attemptId }, new AbortController().signal);
    expect(resolver).toHaveBeenCalledWith({ ...f.request, attemptId }, expect.any(AbortSignal));
    expect(validated.sha256).not.toBe(first.sha256);
    expect(await consumer.retry({ captureId: f.request.captureId, attemptId }, new AbortController().signal)).toEqual(validated);
    expect(resolver).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
    await expect(consumer.providerOptions.commitImageCapture!(f.request.captureId, f.request.attemptId, first)).rejects.toThrow("attempt conflict");
    await expect(f.journal.media().readCapture({ captureId: f.request.captureId, attemptId: f.request.attemptId, sha256: first.sha256, byteLength: first.byteLength, offset: "0", limit: 524288 })).rejects.toThrow("attempt conflict");
    expect(await f.journal.media().readCapture({ captureId: f.request.captureId, attemptId, sha256: validated.sha256, byteLength: validated.byteLength, offset: "0", limit: 524288 }, policy)).toMatchObject({ preparationId: attemptId, data: replacement.bytes.toString("base64"), eof: true });
    current = f.receipt({ attemptId, revision: "3", state: "copying" });
    expect(await consumer.providerOptions.commitImageCapture!(f.request.captureId, attemptId, validated)).toEqual(current);
    expect(calls.at(-1)).toEqual({ action: "commit", body: { captureId: f.request.captureId, attemptId, validated } });
    expect(() => f.journal.observeImageCaptureReceipt(f.receipt({ attemptId, revision: "2" }))).toThrow("revision conflict");
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});

test("an unavailable resolver or cancelled source never starts native input or stages new bytes", async () => {
  const f = await fixture(), source = await f.source("blue"), capture: ReturnType<typeof createControllerRelay>["capture"] = async () => f.receipt();
  try {
    await bridge(f.journal, capture).providerOptions.registerImageCapture!(f.request);
    await expect(bridge(f.journal, capture).retry({ captureId: f.request.captureId, attemptId: randomUUID() }, new AbortController().signal)).rejects.toThrow("component_unsupported");
    const abort = new AbortController(), send = vi.fn(), release = vi.fn(), resolver = vi.fn(async () => { abort.abort(); return { ...source, release }; });
    const attemptId = randomUUID(), consumer = bridge(f.journal, capture, { retryImageCapture: resolver, send } as unknown as NativeProvider);
    await expect(consumer.retry({ captureId: f.request.captureId, attemptId }, abort.signal)).rejects.toThrow();
    expect(f.journal.media().captureStatus(f.request.captureId, attemptId)).toBeNull(); expect(send).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});

test("Markdown retry uses its source coordinator without requiring a native image provider", async () => {
  const f = await fixture(), source = await f.source("blue");
  const resolver = vi.fn(async (request: ImageCaptureRequest) => f.journal.media().stageCapture({ ...source, captureId: request.captureId, attemptId: request.attemptId, imageId: request.occurrence.imageId }));
  const consumer = createControllerCaptureBridge({ journal: f.journal, capture: async () => f.receipt(), beforeCapture: async () => {}, provider: () => null, writable: () => true, retrySource: resolver });
  try {
    await consumer.providerOptions.registerImageCapture!(f.request);
    const attemptId = randomUUID(), signal = new AbortController().signal;
    const result = await consumer.retry({ captureId: f.request.captureId, attemptId }, signal);
    expect(result.sha256).toBe(source.sha256);
    expect(resolver).toHaveBeenCalledWith({ ...f.request, attemptId }, signal);
    expect(await consumer.retry({ captureId: f.request.captureId, attemptId }, signal)).toEqual(result);
    expect(resolver).toHaveBeenCalledTimes(2);
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});

const stagedMarkdownRetry = async (kind: "local" | "external", admitted: boolean) => {
  const f = await fixture(), source = await f.source("blue");
  const destination = kind === "local" ? source.inputPath : "https://images.example/original.png";
  const text = `![original](${destination})`, partId = randomUUID();
  const occurrence = { imageId: randomUUID(), entryId: randomUUID(), container: "content" as const, partId, sourceRevision: "1", sourceTextSha256: createHash("sha256").update(text).digest("hex"), callId: null, sourceKey: `${partId}:1:0` };
  f.journal.projectTimeline({ entryId: occurrence.entryId, revision: "1", kind: "assistant_message", imageProjectionError: null, content: [{ type: "markdown", text, partId, revision: "1", textSha256: occurrence.sourceTextSha256, complete: true, truncated: false, bindings: [{ imageId: occurrence.imageId, start: 0, end: text.length, part: { type: "image_unavailable", imageId: occurrence.imageId, label: "original", error: { code: "source_unavailable", message: "Not captured" } } }], retainedImages: [] }] });
  const sourceRead = vi.fn(() => { throw new Error("An immutable stage must not reopen its source."); });
  const create = (journal: ReturnType<typeof openControllerLifecycleStore>) => {
    let coordinator!: ReturnType<typeof createMarkdownCaptureCoordinator>;
    const consumer = createControllerCaptureBridge({ journal, capture: async () => { throw new Error("A cached retry must not send a capture command."); }, beforeCapture: async () => {}, provider: () => ({ retryImageCapture: sourceRead }) as unknown as NativeProvider, writable: () => true, retrySource: (request, signal) => coordinator.retry(request, signal) });
    coordinator = createMarkdownCaptureCoordinator({ ticket: f.ticket, journal, bridge: consumer.providerOptions, writable: () => true, fence: () => "test-fence", nativeReadPolicy: () => ({ nativeSessionId: journal.getSnapshot().nativeSessionId!, cwd: f.ticket.cwd, revision: "verified-policy", verify: sourceRead, authorizeCheckpoint: sourceRead }), acquireExternalPolicy: sourceRead, onReceipt() {} });
    return { consumer, coordinator };
  };
  const initial = create(f.journal);
  initial.coordinator.enqueue(occurrence, destination, initial.coordinator.contextFor(occurrence));
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  const record = initial.coordinator.get(occurrence.imageId)!;
  f.journal.registerImageCaptureRequest(record.request!);
  f.journal.observeImageCaptureReceipt({ captureId: record.request!.captureId, attemptId: record.request!.attemptId, revision: "1", occurrence, state: "failed", resourceId: null, resource: null, error: { code: "source_unavailable", message: "Original attempt failed" } });
  const request = f.journal.retryImageCaptureRequest(record.request!.captureId, randomUUID());
  const validated = await f.journal.media().stageCapture({ ...source, captureId: request.captureId, attemptId: request.attemptId, imageId: occurrence.imageId });
  // Persist the boundary after staging bytes, before publishing their admission.
  f.journal.markdownStore.put("source", occurrence.imageId, { ...record, request, started: true, phase: admitted ? "validated" : "reading", sourceAdmission: admitted ? { attemptId: request.attemptId, policyRevision: kind === "local" ? "verified-policy" : null, sourceProofSha256: kind === "local" ? "a".repeat(64) : null, validated } : null });
  await initial.coordinator.stop(); await f.journal.stopMedia(); f.journal.close();
  await rm(source.inputPath);
  const journal = openControllerLifecycleStore(f.file, f.ticket, f.options), current = create(journal);
  return { ...current, journal, request, validated, source, sourceRead, close: async () => { await current.coordinator.stop(); await journal.stopMedia(); journal.close(); } };
};

test.each(["local", "external"] as const)("cached %s retry rejects a persisted stage without source admission after reopen", async kind => {
  const f = await stagedMarkdownRetry(kind, false);
  try {
    expect(f.journal.media().captureStatus(f.request.captureId, f.request.attemptId)).toEqual(f.validated);
    await expect(f.consumer.retry(f.request, new AbortController().signal)).rejects.toMatchObject({ code: "source_unavailable" });
    expect(f.journal.assertImageCaptureAttempt(f.request.captureId, f.request.attemptId)).toEqual(f.request);
    expect(f.coordinator.get(f.request.occurrence.imageId)).toMatchObject({ request: f.request, started: true, phase: "reading", sourceAdmission: null });
    expect(() => f.coordinator.acquireReadPolicy(f.request)).toThrow("policy_restricted");
    expect(f.sourceRead).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test.each(["local", "external"] as const)("cached %s retry reuses an admitted immutable stage after source deletion and reopen", async kind => {
  const f = await stagedMarkdownRetry(kind, true);
  try {
    for (let attempt = 0; attempt < 2; attempt++) expect(await f.consumer.retry(f.request, new AbortController().signal)).toEqual(f.validated);
    expect(f.journal.assertImageCaptureAttempt(f.request.captureId, f.request.attemptId)).toEqual(f.request);
    expect(await f.journal.media().readCapture({ captureId: f.request.captureId, attemptId: f.request.attemptId, sha256: f.validated.sha256, byteLength: f.validated.byteLength, offset: "0", limit: 524288 }, f.coordinator.acquireReadPolicy)).toMatchObject({ preparationId: f.request.attemptId, data: f.source.bytes.toString("base64"), eof: true });
    expect(f.sourceRead).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test.each(["local", "external"] as const)("cached %s retries share admission work and clear it after cancellation", async kind => {
  const f = await stagedMarkdownRetry(kind, true), released = Promise.withResolvers<void>();
  const resolver = vi.fn(async (request: ImageCaptureRequest, signal: AbortSignal) => {
    await released.promise; signal.throwIfAborted();
    return f.coordinator.retry(request, signal);
  });
  const consumer = createControllerCaptureBridge({ journal: f.journal, capture: async () => { throw new Error("Unexpected capture command."); }, beforeCapture: async () => {}, provider: () => null, writable: () => true, retrySource: resolver });
  const abort = new AbortController(), reason = new Error("Retry cancelled.");
  const first = consumer.retry(f.request, abort.signal), second = consumer.retry(f.request, abort.signal);
  const outcomes = Promise.allSettled([first, second]);
  try {
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
    abort.abort(reason); released.resolve();
    expect(await outcomes).toEqual([{ status: "rejected", reason }, { status: "rejected", reason }]);
    expect(await consumer.retry(f.request, new AbortController().signal)).toEqual(f.validated);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(f.journal.assertImageCaptureAttempt(f.request.captureId, f.request.attemptId)).toEqual(f.request);
    expect(f.journal.media().captureStatus(f.request.captureId, f.request.attemptId)).toEqual(f.validated);
    expect(f.sourceRead).not.toHaveBeenCalled();
  } finally { released.resolve(); await outcomes; await f.close(); }
});

test.each(["local", "external"] as const)("cached %s retries check cancellation and write access before admission", async kind => {
  const f = await stagedMarkdownRetry(kind, true), resolver = vi.fn(f.coordinator.retry);
  let writable = true;
  const consumer = createControllerCaptureBridge({ journal: f.journal, capture: async () => { throw new Error("Unexpected capture command."); }, beforeCapture: async () => {}, provider: () => null, writable: () => writable, retrySource: resolver });
  try {
    const abort = new AbortController(), reason = new Error("Retry cancelled before admission."); abort.abort(reason);
    await expect(consumer.retry(f.request, abort.signal)).rejects.toBe(reason);
    writable = false;
    await expect(consumer.retry(f.request, new AbortController().signal)).rejects.toThrow("target_changed");
    expect(resolver).not.toHaveBeenCalled();
    expect(f.journal.assertImageCaptureAttempt(f.request.captureId, f.request.attemptId)).toEqual(f.request);
    expect(f.sourceRead).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("query reconciles a service retry whose request was lost without reviving an earlier attempt", async () => {
  const f = await fixture(); let current = f.receipt();
  const capture: ReturnType<typeof createControllerRelay>["capture"] = async () => current;
  const consumer = bridge(f.journal, capture);
  try {
    await consumer.providerOptions.registerImageCapture!(f.request);
    const attemptId = randomUUID();
    current = f.receipt({ attemptId, revision: "3", state: "failed", resourceId: null, error: { code: "component_unsupported", message: "Source resolver unavailable" } });
    expect(await consumer.providerOptions.queryImageCapture!(f.request.captureId)).toEqual(current);
    expect(f.journal.assertImageCaptureAttempt(f.request.captureId, attemptId)).toMatchObject({ locator: f.request.locator });
    await expect(consumer.providerOptions.commitImageCapture!(f.request.captureId, f.request.attemptId, { mediaType: "image/png", byteLength: "1", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 })).rejects.toThrow("attempt conflict");
    current = f.receipt({ revision: "4" });
    await expect(consumer.providerOptions.queryImageCapture!(f.request.captureId)).rejects.toThrow("attempt conflict");
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});


test("a delayed old query cannot cancel the current attempt source writer", async () => {
  const f = await fixture(), query = Promise.withResolvers<ImageCaptureReceipt>();
  const consumer = bridge(f.journal, async () => query.promise);
  f.journal.registerImageCaptureRequest(f.request);
  f.journal.observeImageCaptureReceipt(f.receipt({ state: "failed", resourceId: null, error: { code: "decode_failed", message: "Previous source failed" } }));
  const oldQuery = consumer.providerOptions.queryImageCapture!(f.request.captureId), result = oldQuery.catch(error => error);
  const attemptId = randomUUID(); f.journal.retryImageCaptureRequest(f.request.captureId, attemptId);
  const lease = f.journal.media().reserveCaptureSource(f.request.captureId, attemptId), started = Promise.withResolvers<AbortSignal>(), finish = Promise.withResolvers<void>();
  const writer = lease.runWriter(async (_filename, signal) => { started.resolve(signal); await finish.promise; });
  const signal = await started.promise;
  try {
    query.resolve(f.receipt({ state: "failed", resourceId: null, error: { code: "decode_failed", message: "Previous source failed" } }));
    expect(await result).toMatchObject({ message: "Image capture receipt attempt conflict." });
    expect(signal.aborted).toBe(false);
    expect(f.journal.getImageCaptureAttempt(f.request.captureId)).toBe(attemptId);
  } finally { finish.resolve(); await writer; await lease.release(); await f.journal.stopMedia(); f.journal.close(); }
});

test("source IO reserves both complete copies durably and never reopens an interrupted source", async () => {
  const f = await fixture();
  f.journal.registerImageCaptureRequest(f.request);
  const media = f.journal.media(), lease = media.reserveCaptureSource(f.request.captureId, f.request.attemptId);
  expect((await stat(lease.outputPath)).size).toBe(0);
  const ledger = new Database(path.join(f.home, "controller/media/budget.sqlite"), { readonly: true });
  const charge = () => (ledger.prepare("SELECT reserved_bytes AS bytes FROM allocations WHERE execution_id=?").get(f.ticket.executionId) as { bytes: number }).bytes;
  const reserved = charge();
  expect(reserved).toBeGreaterThanOrEqual(2 * 10 * 1024 * 1024);
  const uploadId = randomUUID();
  await media.prepare({ uploadId, imageId: randomUUID(), target: { serverOrigin: f.ticket.serverOrigin, actorUserId: f.ticket.userId!, fence: { sessionId: f.ticket.sessionId, claimId: f.ticket.claimId!, executionGeneration: "1" }, expectedNativeSessionId: "native" }, name: "other.png", mediaType: "image/png", byteLength: "10485760", sha256: "a".repeat(64) });
  expect(charge()).toBeGreaterThanOrEqual(reserved + 10 * 1024 * 1024);
  await media.release({ uploadId });
  await expect(lease.runWriter(async filename => { await writeFile(filename, Buffer.from("partial")); })).resolves.toBeUndefined();
  await f.journal.stopMedia(); f.journal.close();
  const journal = openControllerLifecycleStore(f.file, f.ticket, f.options);
  try {
    expect(() => journal.media().reserveCaptureSource(f.request.captureId, f.request.attemptId)).toThrow("query");
    expect(charge()).toBeGreaterThanOrEqual(reserved);
    expect(await readFile(lease.outputPath, "utf8")).toBe("partial");
    await journal.media().releaseCaptureSource(f.request.captureId, f.request.attemptId);
    await expect(stat(lease.outputPath)).rejects.toThrow();
    expect(charge()).toBeLessThan(reserved - 19 * 1024 * 1024);
  } finally { ledger.close(); await journal.stopMedia(); journal.close(); }
});

test("source release joins the writer before unlink and retains a validated stage", async () => {
  const f = await fixture(), source = await f.source("blue");
  f.journal.registerImageCaptureRequest(f.request);
  const media = f.journal.media(), lease = media.reserveCaptureSource(f.request.captureId, f.request.attemptId);
  let finish!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const writer = lease.runWriter(async (filename, signal) => {
    await writeFile(filename, source.bytes);
    started();
    await new Promise<void>(resolve => { finish = resolve; });
    expect(signal.aborted).toBe(true);
  });
  await entered;
  const released = lease.release();
  expect(await readFile(lease.outputPath)).toEqual(source.bytes);
  finish(); await writer; await released;
  await expect(stat(lease.outputPath)).rejects.toThrow();
  const attemptId = randomUUID(); f.journal.retryImageCaptureRequest(f.request.captureId, attemptId);
  const retained = media.reserveCaptureSource(f.request.captureId, attemptId);
  await retained.runWriter(async filename => { await writeFile(filename, source.bytes); });
  const validated = await media.stageCapture({ ...source, inputPath: retained.outputPath, captureId: f.request.captureId, attemptId, imageId: f.request.occurrence.imageId });
  await retained.release();
  expect(await media.readCapture({ captureId: f.request.captureId, attemptId, sha256: validated.sha256, byteLength: validated.byteLength, offset: "0", limit: 524288 }, policy)).toMatchObject({ data: source.bytes.toString("base64") });
  await f.journal.stopMedia(); f.journal.close();
});

test("each local prepared chunk requires a policy lease and synchronous delivery verification", async () => {
  const f = await fixture(), source = await f.source("blue");
  f.journal.registerImageCaptureRequest(f.request);
  try {
    const media = f.journal.media(), validated = await media.stageCapture({ ...source, captureId: f.request.captureId, attemptId: f.request.attemptId, imageId: f.request.occurrence.imageId });
    const read = { captureId: f.request.captureId, attemptId: f.request.attemptId, sha256: validated.sha256, byteLength: validated.byteLength, offset: "0", limit: 1 };
    await expect(media.readCapture(read)).rejects.toThrow("policy");
    const close = vi.fn(), verify = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("policy revoked"); });
    const authorize = vi.fn(() => ({ verify, close }));
    await expect(media.readCapture(read, authorize)).rejects.toThrow("policy revoked");
    expect(authorize).toHaveBeenCalledWith(f.request); expect(verify).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce();
    const allowed = vi.fn(policy);
    expect(await media.readCapture(read, allowed)).toMatchObject({ offset: "0", eof: false });
    expect(await media.readCapture({ ...read, offset: "1" }, allowed)).toMatchObject({ offset: "1", eof: false });
    expect(allowed).toHaveBeenCalledTimes(2);
    const asyncClose = vi.fn();
    await expect(media.readCapture(read, () => ({ verify: async () => {}, close: asyncClose }))).rejects.toThrow("synchronously");
    expect(asyncClose).toHaveBeenCalledOnce();
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});

test("capture staging rejects bytes whose decoded format differs from the declared source type", async () => {
  const f = await fixture(), source = await f.source("blue");
  f.journal.registerImageCaptureRequest(f.request);
  try {
    const media = f.journal.media();
    await expect(media.stageCapture({ ...source, captureId: f.request.captureId, attemptId: f.request.attemptId, imageId: f.request.occurrence.imageId, declaredMediaType: "image/jpeg" })).rejects.toThrow("declared");
    expect(media.captureStatus(f.request.captureId, f.request.attemptId)).toBeNull();
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});


test("source reservations retain the free-space margin for every unwritten copy", async () => {
  const f = await fixture();
  f.journal.registerImageCaptureRequest(f.request);
  const secondRequest = { ...f.request, captureId: randomUUID(), attemptId: randomUUID(), occurrence: { ...f.request.occurrence, imageId: randomUUID(), sourceKey: "second-source" } };
  f.journal.registerImageOccurrence(secondRequest.occurrence, null); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); f.journal.registerImageCaptureRequest(secondRequest);
  const media = f.journal.media(); disk.freeBytes = BigInt((512 + 30) * 1024 * 1024);
  try {
    const first = media.reserveCaptureSource(f.request.captureId, f.request.attemptId);
    expect(() => media.reserveCaptureSource(secondRequest.captureId, secondRequest.attemptId)).toThrow("free-space");
    await first.release();
    const second = media.reserveCaptureSource(secondRequest.captureId, secondRequest.attemptId);
    await second.release();
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});


test("source capture and relay blocks share two media slots until the actual writer joins", async () => {
  const f = await fixture(); f.journal.registerImageCaptureRequest(f.request);
  const media = f.journal.media();
  const first = media.tryAcquireMediaBlock()!, second = media.tryAcquireMediaBlock()!;
  try {
    expect(media.tryAcquireMediaBlock()).toBeNull();
    expect(() => media.reserveCaptureSource(f.request.captureId, f.request.attemptId)).toThrow("source_capacity");
    second.close();
    const source = media.reserveCaptureSource(f.request.captureId, f.request.attemptId);
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const writer = source.runWriter(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); });
    await started;
    const releasing = source.release();
    expect(media.tryAcquireMediaBlock()).toBeNull();
    finish(); await writer; await releasing;
    const available = media.tryAcquireMediaBlock(); expect(available).not.toBeNull(); available!.close();
  } finally { first.close(); second.close(); await f.journal.stopMedia(); f.journal.close(); }
});

test("prepared delivery stays inside the policy lease before a queued revocation can run", async () => {
  const f = await fixture(), source = await f.source("blue"); f.journal.registerImageCaptureRequest(f.request);
  try {
    const media = f.journal.media(), validated = await media.stageCapture({ ...source, captureId: f.request.captureId, attemptId: f.request.attemptId, imageId: f.request.occurrence.imageId });
    const events: string[] = [], deliver = vi.fn(() => { events.push("deliver"); });
    await media.readCapture({ captureId: f.request.captureId, attemptId: f.request.attemptId, sha256: validated.sha256, byteLength: validated.byteLength, offset: "0", limit: 1 }, () => {
      queueMicrotask(() => { events.push("revoke"); });
      return { verify() { events.push("verify"); }, close() { events.push("close"); } };
    }, deliver);
    expect(deliver).toHaveBeenCalledOnce();
    expect(events).toEqual(["verify", "verify", "deliver", "close", "revoke"]);
  } finally { await f.journal.stopMedia(); f.journal.close(); }
});

test("committed adoption checks the exact service receipt and reserves the third-copy peak", async () => {
  const f = await fixture(), source = await f.source("blue"); f.journal.registerImageCaptureRequest(f.request);
  const media = f.journal.media(), reservation = media.reserveCaptureSource(f.request.captureId, f.request.attemptId);
  const ledger = new Database(path.join(f.home, "controller/media/budget.sqlite"), { readonly: true });
  const charge = () => (ledger.prepare("SELECT reserved_bytes AS bytes FROM allocations WHERE execution_id=?").get(f.ticket.executionId) as { bytes: number }).bytes;
  try {
    await reservation.runWriter(async filename => { await writeFile(filename, source.bytes); });
    const validated = await media.stageCapture({ ...source, inputPath: reservation.outputPath, captureId: f.request.captureId, attemptId: f.request.attemptId, imageId: f.request.occurrence.imageId });
    const resource = { resourceId: f.receipt().resourceId!, status: "available" as const, name: "saved.png", ...validated, error: null, revision: "1" };
    expect(() => media.adoptCaptureResource(f.request.captureId, f.request.attemptId, resource)).toThrow("committed");
    f.journal.observeImageCaptureReceipt(f.receipt({ state: "committed", revision: "2", resource }));
    expect(() => media.adoptCaptureResource(f.request.captureId, f.request.attemptId, { ...resource, resourceId: randomUUID() })).toThrow("identity");
    expect(() => media.adoptCaptureResource(f.request.captureId, f.request.attemptId, { ...resource, width: validated.width + 1 })).toThrow("identity");
    const changed = { ...resource, width: validated.width + 1 };
    f.journal.observeImageCaptureReceipt(f.receipt({ state: "committed", revision: "3", resource: changed }));
    expect(() => media.adoptCaptureResource(f.request.captureId, f.request.attemptId, changed)).toThrow("validated identity");
    f.journal.observeImageCaptureReceipt(f.receipt({ state: "committed", revision: "4", resource }));
    const transfer = media.tryAcquireMediaBlock()!;
    try { expect(() => media.adoptCaptureResource(f.request.captureId, f.request.attemptId, resource)).toThrow("source_capacity"); }
    finally { transfer.close(); }
    const before = charge();
    media.adoptCaptureResource(f.request.captureId, f.request.attemptId, resource);
    expect(charge()).toBeGreaterThanOrEqual(before + source.bytes.length);
    expect(f.journal.readResource(resource.resourceId, "0", 524288)).toMatchObject({ data: source.bytes.toString("base64"), eof: true });
    await reservation.release();
  } finally { ledger.close(); await f.journal.stopMedia(); f.journal.close(); }
});

test("committed originals survive source removal and reopen without recopying or repairing missing saved bytes", async () => {
  const f = await fixture(), source = await f.source("blue"); f.journal.registerImageCaptureRequest(f.request);
  const media = f.journal.media(), validated = await media.stageCapture({ ...source, captureId: f.request.captureId, attemptId: f.request.attemptId, imageId: f.request.occurrence.imageId });
  const resource = { resourceId: f.receipt().resourceId!, status: "available" as const, name: "saved.png", ...validated, error: null, revision: "1" };
  f.journal.observeImageCaptureReceipt(f.receipt({ state: "committed", revision: "2", resource }));
  await rm(source.inputPath);
  disk.freeBytes = BigInt(512 * 1024 * 1024 + source.bytes.length - 1);
  expect(() => media.adoptCaptureResource(f.request.captureId, f.request.attemptId, resource)).toThrow("free-space");
  expect(() => f.journal.readResource(resource.resourceId, "0", 524288)).toThrow("unavailable");
  disk.freeBytes = null;
  media.adoptCaptureResource(f.request.captureId, f.request.attemptId, resource);
  const blob = path.join(`${f.file}.pending-content/blobs`, createHash("sha256").update(resource.resourceId).digest("hex") + ".bin"), before = await stat(blob);
  await f.journal.stopMedia(); f.journal.close();
  const journal = openControllerLifecycleStore(f.file, f.ticket, f.options);
  try {
    journal.media().adoptCaptureResource(f.request.captureId, f.request.attemptId, resource);
    expect((await stat(blob)).ino).toBe(before.ino);
    expect(journal.readResource(resource.resourceId, "0", 524288)).toMatchObject({ data: source.bytes.toString("base64") });
    await rm(blob);
    expect(() => journal.media().adoptCaptureResource(f.request.captureId, f.request.attemptId, resource)).toThrow("missing");
    await expect(stat(blob)).rejects.toThrow();
  } finally { await journal.stopMedia(); journal.close(); }
});
