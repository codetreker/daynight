import { afterEach, expect, test, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { openSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import Database from "better-sqlite3";
import { openControllerLifecycleStore } from "../../../../src/commands/controller/lifecycle-store.js";
import { createControllerCaptureBridge } from "../../../../src/commands/controller/media/capture.js";
import { ImageCaptureRequestError } from "../../../../src/commands/controller/media/capture-error.js";
import { createMarkdownCaptureCoordinator } from "../../../../src/commands/controller/markdown/coordinator.js";
import { validateImageFile } from "../../../../src/commands/controller/media/image-validation.js";
import type { ControllerLaunchTicket } from "../../../../src/commands/controller/launch-ticket.js";
import type { ImageCaptureReceipt, ImageCaptureRequest } from "../../../../src/session/image-values.js";
import type { LocalImageCheckpoint } from "../../../../src/commands/controller/markdown/local-source-proof.js";
import { createExternalImagePolicyProducer, type ExternalImagePolicyLease } from "../../../../src/commands/controller/markdown/external-policy.js";
import * as externalSource from "../../../../src/commands/controller/markdown/external-source.js";
import { sourceImageDecoder } from "../../../fixtures/image-decoder.js";
import type { ImageDecoder } from "../../../../src/commands/controller/media/image-decoder.js";

const cleanupFaults = vi.hoisted(() => ({ beforeSourceOpen: null as null | ((filename: string) => void) }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (typeof args[0] === "string" && args[0].includes(".media-staging") && args[0].endsWith(".part") && typeof args[1] === "number" && (args[1] & fs.constants.O_EXCL)) cleanupFaults.beforeSourceOpen?.(args[0]);
    return fs.openSync(...args);
  } };
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { cleanupFaults.beforeSourceOpen = null; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const fixture = async (checkSource?: (checkpoint: LocalImageCheckpoint) => void | Promise<void>, external: Pick<Parameters<typeof createMarkdownCaptureCoordinator>[0], "acquireExternalPolicy"> = {}, imageDecoder: ImageDecoder = validateImageFile) => {
  const base = path.resolve(import.meta.dirname, "../../../../../../.tmp/a3-coordinator-tests");
  await mkdir(base, { recursive: true }); const home = await mkdtemp(path.join(base, "c-"));
  const workspace = path.join(home, "workspace"); await mkdir(workspace);
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const currentTicket = { ...ticket, cwd: workspace };
  const file = path.join(home, "journal.sqlite"), journal = openControllerLifecycleStore(file, currentTicket, { imageDecoder });
  journal.patchSnapshot({ nativeSessionId: randomUUID() });
  const body = "![original](original.png)", entryId = randomUUID(), partId = randomUUID(), imageId = randomUUID();
  const occurrence = { imageId, entryId, partId, sourceRevision: "1", sourceTextSha256: createHash("sha256").update(body).digest("hex"), container: "content" as const, callId: null, sourceKey: `${partId}:1:0` };
  journal.projectTimeline({ entryId, revision: "1", kind: "assistant_message", imageProjectionError: null, content: [{ type: "markdown", text: body, partId, revision: "1", textSha256: occurrence.sourceTextSha256, complete: true, truncated: false, bindings: [{ imageId, start: 0, end: body.length, part: { type: "image_unavailable", imageId, label: "original", error: { code: "source_unavailable", message: "Not captured" } } }], retainedImages: [] }] });
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background: "blue" } }).png().toBuffer();
  await writeFile(path.join(workspace, "original.png"), bytes);
  let receipt: ImageCaptureReceipt | null = null, loseRegister = false, allowed = true, writable = true, receiptError: Error | null = null, closed = false;
  const receipts = new Map<string, ImageCaptureReceipt>();
  const calls: string[] = [], changes: ImageCaptureReceipt[] = [];
  const bridge = createControllerCaptureBridge({ journal, beforeCapture: async () => {}, provider: () => null, writable: () => true,
    capture: async (action, body) => {
      calls.push(action);
      const captureId = (body as { captureId: string }).captureId;
      if (action === "register") { const request = body as ImageCaptureRequest; receipts.set(captureId, { captureId, attemptId: request.attemptId, revision: "1", occurrence: request.occurrence, state: "reserved", resourceId: randomUUID(), resource: null, error: null }); if (loseRegister) throw new Error("Lost receipt"); }
      let current = receipts.get(captureId);
      if (!current) throw new Error("Unknown capture");
      if (action === "commit") current = { ...current, revision: String(BigInt(current.revision) + 1n), state: "copying" };
      if (action === "failed") current = { ...current, revision: String(BigInt(current.revision) + 1n), state: "failed", resourceId: null, error: (body as { error: { code: string; message: string } }).error };
      receipts.set(captureId, current);
      if (current.occurrence.imageId === imageId) receipt = current;
      return current;
    } });
  let policy = { nativeSessionId: journal.getSnapshot().nativeSessionId!, cwd: workspace, revision: "verified-test-policy", verify: () => { if (!allowed) throw new Error("revoked"); }, authorizeCheckpoint: async (checkpoint: LocalImageCheckpoint) => { await checkSource?.(checkpoint); } };
  const coordinator = createMarkdownCaptureCoordinator({ ticket: currentTicket, journal, bridge: bridge.providerOptions, writable: () => writable, fence: () => "test-fence", nativeReadPolicy: () => policy, ...external, onReceipt: (_request, value) => { if (receiptError) { const error = receiptError; receiptError = null; throw error; } changes.push(value); } });
  const close = async () => { if (closed) return; closed = true; await coordinator.stop(); await journal.stopMedia(); journal.close(); };
  cleanups.push(close);
  const context = coordinator.contextFor(occurrence);
  const committed = () => {
    if (!receipt) throw new Error("No receipt");
    const resource = { resourceId: receipt.resourceId!, revision: "1", status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), width: 8, height: 6, frameCount: 1, error: null };
    receipt = { ...receipt, revision: String(BigInt(receipt.revision) + 1n), state: "committed", resource };
    receipts.set(receipt.captureId, receipt);
    return resource;
  };
  const serviceRetry = () => {
    if (!receipt) throw new Error("No receipt");
    const attemptId = randomUUID();
    receipt = { ...receipt, attemptId, revision: String(BigInt(receipt.revision) + 1n), state: "reserved", resourceId: randomUUID(), resource: null, error: null };
    receipts.set(receipt.captureId, receipt);
    return attemptId;
  };
  return { journal, coordinator, occurrence, context, calls, changes, bytes, file, bridge, ticket: currentTicket, receipts, policy: () => policy, close, failNextReceipt: (error: Error) => { receiptError = error; }, home: workspace, committed, serviceRetry, setLost: () => { loseRegister = true; }, revoke: () => { allowed = false; }, revokeScope: () => { writable = false; }, replacePolicy: (patch: Partial<typeof policy>) => { policy = { ...policy, ...patch }; } };
};

const releaseFault = (f: Awaited<ReturnType<typeof fixture>>) => {
  const db = new Database(f.file);
  db.exec("CREATE TRIGGER reject_source_release BEFORE INSERT ON image_runtime_state WHEN NEW.key LIKE 'capture-source:%' AND json_extract(NEW.value,'$.released')=1 BEGIN SELECT RAISE(FAIL, 'source release save failed'); END");
  cleanups.push(async () => { db.close(); });
  return {
    recover: () => db.exec("DROP TRIGGER reject_source_release"),
    row: (request: ImageCaptureRequest) => {
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`capture-source:${request.captureId}:${request.attemptId}`) as { value: string } | undefined;
      return row ? JSON.parse(row.value) as { released: boolean } : null;
    },
  };
};
const freeSlots = (f: Awaited<ReturnType<typeof fixture>>) => {
  const leases: { close(): void }[] = [];
  for (let i = 0; i < 3; i++) { const lease = f.journal.media().tryAcquireMediaBlock(); if (!lease) break; leases.push(lease); }
  for (const lease of leases) lease.close();
  return leases.length;
};

test("correlated register refusal settles Markdown locally without repeated queries or a fabricated receipt", async () => {
  const f = await fixture();
  vi.spyOn(f.bridge.providerOptions, "registerImageCapture").mockRejectedValue(new ImageCaptureRequestError({ code: "quota_exceeded", message: "Capture capacity is exhausted." }));
  const query = vi.spyOn(f.bridge.providerOptions, "queryImageCapture");
  f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick(); await f.coordinator.tick();
  expect(query).not.toHaveBeenCalled();
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "settled", receipt: null, error: { code: "quota_exceeded", message: "Capture capacity is exhausted." } });
});

test("Markdown register rate limit retries its frozen identity after a delay", async () => {
  const f = await fixture(), original = f.bridge.providerOptions.registerImageCapture!;
  const register = vi.spyOn(f.bridge.providerOptions, "registerImageCapture").mockRejectedValueOnce(new ImageCaptureRequestError({ code: "rate_limited", message: "Try later." })).mockImplementation(original);
  const query = vi.spyOn(f.bridge.providerOptions, "queryImageCapture"), now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const start = Date.now();
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick(); await f.coordinator.tick();
  expect(register).toHaveBeenCalledOnce(); expect(query).not.toHaveBeenCalled();
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "waiting", cooldownUntil: start + 1000 });
  now.mockReturnValue(start + 1000); await f.coordinator.tick();
  expect(register).toHaveBeenCalledTimes(2); expect(register.mock.calls[0]![0]).toEqual(register.mock.calls[1]![0]);
  expect(query).not.toHaveBeenCalled();
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "unknown", receipt: { state: "copying" } });
});

test.each(["commit", "failure"] as const)("rate-limited Markdown %s survives restart without rereading its source", async action => {
  let sourceReads = 0;
  const f = await fixture(checkpoint => { if (checkpoint.stage === "initial") sourceReads++; });
  if (action === "failure") await rm(path.join(f.home, "original.png"));
  const target = action === "commit" ? "commitImageCapture" : "failImageCapture";
  const control = vi.spyOn(f.bridge.providerOptions, target).mockRejectedValueOnce(new ImageCaptureRequestError({ code: "rate_limited", message: "Try later." }));
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now()), start = Date.now();
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick();
  const request = f.coordinator.get(f.occurrence.imageId)!.request!, args = control.mock.calls[0]!;
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "unknown", retryControl: { action, attemptId: request.attemptId, after: start + 1000 } });
  await f.coordinator.tick(); expect(control).toHaveBeenCalledOnce();
  const readsBeforeRestart = sourceReads;
  await f.close();
  const journal = openControllerLifecycleStore(f.file, f.ticket, { imageDecoder: validateImageFile });
  const unexpected = vi.fn(async () => { throw new Error("Unexpected operation"); });
  const prior = f.receipts.get(request.captureId)!;
  const commit = vi.fn(async (_id: string, _attempt: string, _validated: unknown) => ({ ...prior, revision: "2", state: "copying" as const }));
  const fail = vi.fn(async (_id: string, _attempt: string, error: { code: string; message: string }) => ({ ...prior, revision: "2", state: "failed" as const, resourceId: null, error }));
  const coordinator = createMarkdownCaptureCoordinator({ ticket: f.ticket, journal, writable: () => true, fence: () => "reopened-fence", nativeReadPolicy: f.policy, onReceipt() {}, bridge: {
    registerImageCapture: unexpected, queryImageCapture: unexpected, commitImageCapture: commit, failImageCapture: fail,
  } });
  cleanups.push(async () => { await coordinator.stop(); await journal.stopMedia(); journal.close(); });
  await coordinator.tick(); expect(commit).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
  now.mockReturnValue(start + 1000); await coordinator.tick();
  expect(action === "commit" ? commit : fail).toHaveBeenCalledWith(...args);
  expect(unexpected).not.toHaveBeenCalled(); expect(sourceReads).toBe(readsBeforeRestart);
  expect(coordinator.get(f.occurrence.imageId)?.receipt?.state).toBe(action === "commit" ? "copying" : "failed");
});

test.each(["commit", "failure"] as const)("a lost response to a retried Markdown %s remains observation-only after restart", async action => {
  const f = await fixture();
  if (action === "failure") await rm(path.join(f.home, "original.png"));
  const target = action === "commit" ? "commitImageCapture" : "failImageCapture";
  const control = vi.spyOn(f.bridge.providerOptions, target).mockRejectedValueOnce(new ImageCaptureRequestError({ code: "rate_limited", message: "Try later." })).mockImplementationOnce(async () => {
    expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "unknown", observeOnly: true });
    expect(f.coordinator.get(f.occurrence.imageId)?.retryControl).toBeUndefined();
    throw new Error("Response lost");
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now()), start = Date.now();
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick(); const request = f.coordinator.get(f.occurrence.imageId)!.request!;
  now.mockReturnValue(start + 1000); await f.coordinator.tick(); expect(control).toHaveBeenCalledTimes(2);
  await f.close();
  const journal = openControllerLifecycleStore(f.file, f.ticket, { imageDecoder: validateImageFile });
  const unexpected = vi.fn(async () => { throw new Error("Unexpected replay"); });
  const query = vi.fn(async () => f.receipts.get(request.captureId)!);
  const coordinator = createMarkdownCaptureCoordinator({ ticket: f.ticket, journal, writable: () => true, fence: () => "reopened-fence", nativeReadPolicy: f.policy, onReceipt() {}, bridge: {
    registerImageCapture: unexpected, queryImageCapture: query, commitImageCapture: unexpected, failImageCapture: unexpected,
  } });
  cleanups.push(async () => { await coordinator.stop(); await journal.stopMedia(); journal.close(); });
  await coordinator.tick(); expect(query).toHaveBeenCalledOnce(); expect(unexpected).not.toHaveBeenCalled();
  expect(coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "unknown", observeOnly: true });
});

test("a missing query after an unknown Markdown register keeps the original identity until copying", async () => {
  const f = await fixture(); f.setLost();
  const originalQuery = f.bridge.providerOptions.queryImageCapture!;
  const query = vi.spyOn(f.bridge.providerOptions, "queryImageCapture").mockRejectedValueOnce(new ImageCaptureRequestError({ code: "capture_not_found", message: "Capture was not found." })).mockImplementation(originalQuery);
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick();
  const request = f.coordinator.get(f.occurrence.imageId)!.request!;
  await f.coordinator.tick();
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "unknown", request, receipt: null });
  const prior = f.receipts.get(request.captureId)!;
  f.receipts.set(request.captureId, { ...prior, revision: "2", state: "copying" });
  await f.coordinator.tick();
  expect(query).toHaveBeenCalledTimes(2);
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "unknown", request, receipt: { state: "copying" } });
});

test.each(["commit", "failure"] as const)("a rejected Markdown %s observes the original state without repeating the request", async action => {
  const f = await fixture();
  if (action === "failure") await rm(path.join(f.home, "original.png"));
  const target = action === "commit" ? "commitImageCapture" : "failImageCapture";
  const refused = vi.spyOn(f.bridge.providerOptions, target).mockRejectedValue(new ImageCaptureRequestError({ code: "resource_conflict", message: "Capture changed." }));
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick();
  const request = f.coordinator.get(f.occurrence.imageId)!.request!, prior = f.receipts.get(request.captureId)!;
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "unknown", observeOnly: true });
  await f.coordinator.tick();
  expect(refused).toHaveBeenCalledOnce();
  f.receipts.set(request.captureId, { ...prior, revision: "2", state: "copying" });
  await f.coordinator.tick();
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "unknown", receipt: { state: "copying" } });
  f.receipts.set(request.captureId, { ...prior, revision: "3", state: "failed", resourceId: null, error: { code: "storage_unavailable", message: "Storage failed." } });
  await f.coordinator.tick();
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "settled", receipt: { state: "failed" } });
  expect(refused).toHaveBeenCalledOnce();
});

test("settled source failures retain independent cleanup and restore both slots after access is revoked", async () => {
  let sources = 0;
  const f = await fixture(undefined, { acquireExternalPolicy: async () => { sources++; throw Object.assign(new Error("Forbidden source"), { code: "source_forbidden" }); } });
  const fault = releaseFault(f), occurrences = [f.occurrence];
  const entryId = randomUUID(), partId = randomUUID(), imageId = randomUUID(), text = "![next](https://images.example/next.png)", textSha256 = createHash("sha256").update(text).digest("hex");
  const next = { ...f.occurrence, entryId, partId, imageId, sourceTextSha256: textSha256, sourceKey: `${partId}:1:0` };
  f.journal.projectTimeline({ entryId, revision: "1", kind: "assistant_message", imageProjectionError: null, content: [{ type: "markdown", text, partId, revision: "1", textSha256, complete: true, truncated: false, bindings: [{ imageId, start: 0, end: text.length, part: { type: "image_unavailable", imageId, label: "next", error: { code: "source_unavailable", message: "Not captured" } } }], retainedImages: [] }] });
  occurrences.push(next);
  for (const occurrence of occurrences) f.coordinator.enqueue(occurrence, "https://images.example/original.png", f.coordinator.contextFor(occurrence));
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const requests = occurrences.map(occurrence => f.coordinator.get(occurrence.imageId)!.request!);
  expect(sources).toBe(2); expect(freeSlots(f)).toBe(0);
  for (const request of requests) {
    expect(fault.row(request)?.released).toBe(false);
    expect(f.coordinator.get(request.occurrence.imageId)).toMatchObject({ phase: "settled", error: { code: "source_forbidden" }, sourceCleanup: { captureId: request.captureId, attemptId: request.attemptId, pending: true, error: { code: "SQLITE_CONSTRAINT_TRIGGER" } } });
  }
  fault.recover(); f.revokeScope(); const calls = [...f.calls];
  await f.coordinator.tick();
  expect(f.calls).toEqual(calls); expect(sources).toBe(2); expect(freeSlots(f)).toBe(2);
  for (const request of requests) {
    expect(fault.row(request)?.released).toBe(true);
    expect(f.coordinator.get(request.occurrence.imageId)).toMatchObject({ request, sourceCleanup: { pending: false, error: { code: "SQLITE_CONSTRAINT_TRIGGER" } } });
  }
});

test("unknown failure settlement cannot commit or return the admitted stage after cleanup recovers", async () => {
  let sources = 0;
  const f = await fixture(checkpoint => { if (checkpoint.stage === "initial") sources++; }), fault = releaseFault(f);
  const failed = vi.spyOn(f.bridge.providerOptions, "failImageCapture").mockRejectedValue(new Error("Failure response unavailable"));
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const record = f.coordinator.get(f.occurrence.imageId)!, request = record.request!;
  expect(failed).toHaveBeenCalledOnce(); expect(record.phase).toBe("unknown");
  expect(f.journal.media().captureStatus(request.captureId, request.attemptId)).not.toBeNull();
  expect(fault.row(request)?.released).toBe(false); expect(freeSlots(f)).toBe(1);
  fault.recover(); failed.mockRestore();
  await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "query"]);
  expect(fault.row(request)?.released).toBe(true); expect(freeSlots(f)).toBe(2); expect(sources).toBe(1);
  await expect(f.coordinator.retry(request, new AbortController().signal)).rejects.toMatchObject({ code: "source_unavailable" });
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ request, phase: "unknown", observeOnly: true, sourceCleanup: { pending: false, error: { code: "SQLITE_CONSTRAINT_TRIGGER" } } });
});

test("source retry-after survives cleanup failure without extending its window during recovery", async () => {
  const f = await fixture(undefined, { acquireExternalPolicy: async () => { throw new externalSource.ExternalImageSourceError("source_rate_limited", 30); } }), fault = releaseFault(f);
  const started = Date.now(), now = vi.spyOn(Date, "now").mockReturnValue(started);
  f.coordinator.enqueue(f.occurrence, "https://images.example/original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const original = f.coordinator.get(f.occurrence.imageId)!;
  expect(original).toMatchObject({ error: { code: "source_rate_limited" }, cooldownUntil: started + 30_000, sourceCleanup: { pending: true, error: { code: "SQLITE_CONSTRAINT_TRIGGER" } } });
  fault.recover(); now.mockReturnValue(started + 1000); await f.coordinator.tick();
  expect(f.coordinator.get(f.occurrence.imageId)?.cooldownUntil).toBe(started + 30_000);
  now.mockReturnValue(started + 31_000);
  const attemptId = f.serviceRetry(), request = f.journal.retryImageCaptureRequest(original.request!.captureId, attemptId);
  await expect(f.coordinator.retry(request, new AbortController().signal)).rejects.toMatchObject({ code: "source_rate_limited" });
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ request, error: { code: "source_rate_limited" }, cooldownUntil: started + 61_000, sourceCleanup: { pending: false } });
});

test("an explicit new attempt waits for the original cleanup before changing its source identity", async () => {
  let sources = 0;
  const f = await fixture(checkpoint => { if (checkpoint.stage === "initial") sources++; }), fault = releaseFault(f);
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const original = f.coordinator.get(f.occurrence.imageId)!.request!, attemptId = f.serviceRetry(), request = f.journal.retryImageCaptureRequest(original.captureId, attemptId);
  await expect(f.coordinator.retry(request, new AbortController().signal)).rejects.toThrow("source release save failed");
  expect(f.coordinator.get(f.occurrence.imageId)?.request).toEqual(original); expect(fault.row(request)).toBeNull(); expect(sources).toBe(1);
  fault.recover(); const result = await f.coordinator.retry(request, new AbortController().signal);
  expect(result.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex")); expect(sources).toBe(2);
  expect(fault.row(original)?.released).toBe(true); expect(fault.row(request)?.released).toBe(true); expect(freeSlots(f)).toBe(2);
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ request, sourceCleanup: { captureId: request.captureId, attemptId, pending: false } });
});

test("a queried service retry discards the prior attempt failure before starting its authorized source", async () => {
  const f = await fixture(), originalFail = f.bridge.providerOptions.failImageCapture!;
  const lost = vi.spyOn(f.bridge.providerOptions, "failImageCapture").mockImplementation(async (...args) => { await originalFail(...args); throw new Error("Failure receipt lost"); });
  await rm(path.join(f.home, "original.png"));
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const old = f.coordinator.get(f.occurrence.imageId)!;
  expect(old).toMatchObject({ phase: "unknown", error: { code: "source_not_found" } });
  const attemptId = f.serviceRetry(); lost.mockRestore();
  await f.coordinator.tick();
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ awaitingRetry: true, request: { attemptId } });
  await writeFile(path.join(f.home, "original.png"), f.bytes);
  const request = f.coordinator.get(f.occurrence.imageId)!.request!;
  const result = await f.coordinator.retry(request, new AbortController().signal);
  expect(result.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ request, error: null, sourceCleanup: { attemptId, pending: false } });
  expect(f.calls).toEqual(["register", "failed", "query"]);
});

test("a new attempt is durably awaiting its retry before receipt projection can fail and the journal reopens", async () => {
  const f = await fixture(), originalFail = f.bridge.providerOptions.failImageCapture!;
  const lost = vi.spyOn(f.bridge.providerOptions, "failImageCapture").mockImplementation(async (...args) => { await originalFail(...args); throw new Error("Failure receipt lost"); });
  await rm(path.join(f.home, "original.png"));
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const attemptId = f.serviceRetry(); lost.mockRestore(); f.failNextReceipt(new Error("Receipt projection unavailable"));
  await expect(f.coordinator.tick()).rejects.toThrow("Receipt projection unavailable");
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ request: { attemptId }, started: false, awaitingRetry: true, error: null });
  await f.close();
  const journal = openControllerLifecycleStore(f.file, f.ticket, { imageDecoder: validateImageFile });
  const unexpected = vi.fn(async () => { throw new Error("Unexpected service write"); });
  const coordinator = createMarkdownCaptureCoordinator({ ticket: f.ticket, journal, writable: () => true, fence: () => "reopened-fence", nativeReadPolicy: f.policy, onReceipt() {}, bridge: {
    registerImageCapture: unexpected, commitImageCapture: unexpected, failImageCapture: unexpected,
    queryImageCapture: async captureId => journal.observeImageCaptureReceipt(f.receipts.get(captureId)!),
  } });
  cleanups.push(async () => { await coordinator.stop(); await journal.stopMedia(); journal.close(); });
  await coordinator.tick(); expect(unexpected).not.toHaveBeenCalled();
  expect(coordinator.get(f.occurrence.imageId)).toMatchObject({ request: { attemptId }, started: false, awaitingRetry: true, error: null });
  await writeFile(path.join(f.home, "original.png"), f.bytes);
  const request = coordinator.get(f.occurrence.imageId)!.request!;
  expect((await coordinator.retry(request, new AbortController().signal)).sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
});

test("source reservation cleanup is durable before a lease can fail to open its private file", async () => {
  const f = await fixture(), db = new Database(f.file, { readonly: true }); cleanups.push(async () => { db.close(); });
  const observed: unknown[] = [];
  cleanupFaults.beforeSourceOpen = () => {
    cleanupFaults.beforeSourceOpen = null;
    observed.push(f.coordinator.get(f.occurrence.imageId));
    // Fail an actual filesystem operation after the reservation insert.
    openSync(path.join(f.home, "missing-private-parent", "source.part"), "r");
  };
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const record = f.coordinator.get(f.occurrence.imageId)!, request = record.request!;
  expect(observed).toEqual([expect.objectContaining({ sourceCleanup: { captureId: request.captureId, attemptId: request.attemptId, pending: true, error: null } })]);
  const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`capture-source:${request.captureId}:${request.attemptId}`) as { value: string };
  expect(JSON.parse(row.value).released).toBe(true); expect(freeSlots(f)).toBe(2);
  expect(record).toMatchObject({ phase: "settled", sourceCleanup: { pending: false } });
});

test.each(["rollback", "lost-ack"] as const)("cleanup completion metadata %s keeps a recoverable original identity", async outcome => {
  const f = await fixture(), originalPut = f.journal.markdownStore.put.bind(f.journal.markdownStore);
  let faults = 0;
  vi.spyOn(f.journal.markdownStore, "put").mockImplementation((kind, id, value) => {
    const cleanup = (value as { sourceCleanup?: { pending: boolean } }).sourceCleanup;
    if (kind === "source" && cleanup?.pending === false && faults === 0) {
      faults++;
      if (outcome === "lost-ack") originalPut(kind, id, value);
      throw Object.assign(new Error("Cleanup metadata acknowledgement unavailable"), { code: "EIO" });
    }
    originalPut(kind, id, value);
  });
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const request = f.coordinator.get(f.occurrence.imageId)!.request!;
  expect(faults).toBe(1);
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ request, sourceCleanup: { pending: outcome === "rollback", error: { code: "EIO" } } });
  expect(freeSlots(f)).toBe(2);
  await f.coordinator.tick();
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ request, phase: "settled", sourceCleanup: { pending: false, error: { code: "EIO" } } });
  expect(f.calls).toEqual(["register", "failed"]);
});

test("external admission acquires one lease and releases it before transferring the immutable copy", async () => {
  let producer!: ReturnType<typeof createExternalImagePolicyProducer>, lease!: ExternalImagePolicyLease;
  let acquisitions = 0, releases = 0;
  const f = await fixture(undefined, { acquireExternalPolicy: async () => { acquisitions++; lease = await producer.acquire(); return { ...lease, release() { releases++; lease.release(); } }; } });
  const configFile = path.join(f.home, "config.yml");
  await writeFile(configFile, JSON.stringify({ controller: { externalImages: { schemaVersion: 1, profileId: "fixture", protectedCidrs: [], protectedDomains: [], egress: { mode: "enforced", policyId: "fixture-policy" } } } }));
  producer = createExternalImagePolicyProducer({ paths: { stateDirectory: f.home, configFile } }); cleanups.push(() => producer.close());
  // Source transport owns network admission. This assembly test keeps media
  // staging real and controls only the directly invoked source collaborator.
  vi.spyOn(externalSource, "copyExternalImage").mockImplementation(async input => {
    await writeFile(input.outputPath, f.bytes); return { inputPath: input.outputPath, byteLength: String(f.bytes.length), sha256: createHash("sha256").update(f.bytes).digest("hex"), declaredMediaType: "image/png" };
  });
  f.coordinator.enqueue(f.occurrence, "https://images.example/original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "commit"]); expect(acquisitions).toBe(1); expect(releases).toBe(1);
  await expect(lease.assertEgressPolicy()).rejects.toMatchObject({ code: "policy_restricted" });
  await rm(configFile); await f.coordinator.tick(); expect(acquisitions).toBe(1);
  const record = f.coordinator.get(f.occurrence.imageId)!, readPolicy = f.coordinator.acquireReadPolicy(record.request!);
  expect(() => readPolicy.verify()).not.toThrow();
  f.revokeScope(); expect(() => readPolicy.verify()).toThrow(); readPolicy.close();
});

test("external failure releases its lease and a later profile does not restart the same attempt", async () => {
  let acquisitions = 0, releases = 0;
  const signal = new AbortController().signal;
  const f = await fixture(undefined, { acquireExternalPolicy: async () => { acquisitions++; return { revision: "fixed", generation: "first", signal, async assertEgressPolicy() { throw new Error("revoked"); }, async assertTarget() {}, release() { releases++; } }; } });
  f.coordinator.enqueue(f.occurrence, "https://images.example/original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "failed"]); expect(f.coordinator.get(f.occurrence.imageId)?.error?.code).toBe("policy_restricted");
  await f.coordinator.tick(); expect(acquisitions).toBe(1); expect(releases).toBe(1);
});

test("an unresolved native checkpoint cannot advance source capture or late-commit after revocation", async () => {
  let reached!: () => void, release!: () => void;
  const opened = new Promise<void>(resolve => { reached = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const stages: string[] = [];
  const f = await fixture(async checkpoint => { stages.push(checkpoint.stage); if (checkpoint.stage === "opened") { reached(); await pending; } });
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  const work = f.coordinator.tick();
  await Promise.race([opened, work]);
  expect(stages).toEqual(["initial", "opened"]);
  expect(f.calls).toEqual(["register"]);
  f.revoke(); f.coordinator.invalidateNativeReadPolicy();
  await f.coordinator.drainNativeReadPolicy(); await work;
  release(); await Promise.resolve();
  expect(f.calls).toEqual(["register", "failed"]);
  const record = f.coordinator.get(f.occurrence.imageId)!;
  expect(f.journal.media().captureStatus(record.request!.captureId, record.request!.attemptId)).toBeNull();
});

test.each(["nativeSessionId", "cwd"] as const)("a policy for another %s cannot authorize this source", async field => {
  const f = await fixture();
  f.replacePolicy({ [field]: field === "cwd" ? path.dirname(f.home) : randomUUID() });
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "failed"]);
  expect(f.coordinator.get(f.occurrence.imageId)?.error?.code).toBe("policy_restricted");
});

test("source authorization uses the current policy on an explicit service retry", async () => {
  const f = await fixture();
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick();
  f.serviceRetry(); await f.coordinator.tick();
  f.replacePolicy({ revision: "new-native-authority" });
  const request = f.coordinator.get(f.occurrence.imageId)!.request!;
  const result = await f.coordinator.retry(request, new AbortController().signal);
  expect(result.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
});

test("the source policy can refuse the actual opened object before capture validation", async () => {
  const stages: string[] = [];
  const f = await fixture(checkpoint => { stages.push(checkpoint.stage); if (checkpoint.stage === "opened") { expect(checkpoint.proof.requested.locator).toBe("original.png"); expect(checkpoint.proof.opened).not.toBeNull(); throw new Error("native object denied"); } });
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "failed"]); expect(stages).toEqual(["initial", "opened"]);
  const record = f.coordinator.get(f.occurrence.imageId)!;
  expect(record.error?.code).toBe("policy_restricted");
  expect(f.journal.media().captureStatus(record.request!.captureId, record.request!.attemptId)).toBeNull();
  expect(JSON.stringify(record)).not.toContain('"traversal"');
});

test("the source policy receives stable evidence through final without persisting it", async () => {
  const checks: LocalImageCheckpoint[] = [], f = await fixture(checkpoint => { checks.push(checkpoint); });
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "commit"]); expect(checks.map(check => check.stage)).toEqual(["initial", "opened", "block", "final"]);
  expect(checks[1]!.proof.root.identity).toMatchObject(f.context.root);
  expect(checks[2]!.proof).toEqual(checks[1]!.proof); expect(checks[3]!.proof).toEqual(checks[1]!.proof);
  expect(JSON.stringify(f.coordinator.get(f.occurrence.imageId))).not.toContain('"traversal"');
});

test("the original position is acknowledged before source IO and copies remain immutable after source deletion", async () => {
  const f = await fixture();
  f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  await f.coordinator.tick(); expect(f.calls).toEqual([]);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "commit"]);
  await rm(path.join(f.home, "original.png"));
  const record = f.coordinator.get(f.occurrence.imageId)!;
  const validated = f.journal.media().captureStatus(record.request!.captureId, record.request!.attemptId)!;
  const chunk = await f.journal.media().readCapture({ captureId: record.request!.captureId, attemptId: record.request!.attemptId, ...validated, offset: "0", limit: 524288 }, f.coordinator.acquireReadPolicy);
  expect(Buffer.from(chunk.data, "base64")).toEqual(f.bytes);
  f.revokeScope();
  await expect(f.journal.media().readCapture({ captureId: record.request!.captureId, attemptId: record.request!.attemptId, ...validated, offset: "0", limit: 524288 }, f.coordinator.acquireReadPolicy)).rejects.toThrow();
});

test("later native source restrictions do not reauthorize or replace an admitted immutable copy", async () => {
  const f = await fixture();
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const record = f.coordinator.get(f.occurrence.imageId)!, request = record.request!;
  const validated = f.journal.media().captureStatus(request.captureId, request.attemptId)!;
  f.revoke(); await rm(path.join(f.home, "original.png"));
  const chunk = await f.journal.media().readCapture({ captureId: request.captureId, attemptId: request.attemptId, ...validated, offset: "0", limit: 524288 }, f.coordinator.acquireReadPolicy);
  expect(Buffer.from(chunk.data, "base64")).toEqual(f.bytes);
  f.journal.markdownStore.put("source", f.occurrence.imageId, { ...record, sourceAdmission: null });
  await expect(f.journal.media().readCapture({ captureId: request.captureId, attemptId: request.attemptId, ...validated, offset: "0", limit: 524288 }, f.coordinator.acquireReadPolicy)).rejects.toThrow();
});

test("an interrupted validation without its source admission is not committed or re-read", async () => {
  const f = await fixture();
  f.coordinator.enqueue(f.occurrence, "original.png", f.context); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const record = f.coordinator.get(f.occurrence.imageId)!;
  f.serviceRetry(); await f.coordinator.tick();
  const request = f.coordinator.get(f.occurrence.imageId)!.request!;
  await f.coordinator.retry(request, new AbortController().signal);
  const retryRecord = f.coordinator.get(f.occurrence.imageId)!;
  f.journal.markdownStore.put("source", f.occurrence.imageId, { ...retryRecord, sourceAdmission: null, awaitingRetry: false });
  await rm(path.join(f.home, "original.png"));
  await f.coordinator.tick();
  expect(f.calls.at(-1)).toBe("failed");
  expect(f.coordinator.get(f.occurrence.imageId)?.error?.code).toBe("source_unavailable");
  expect(f.coordinator.get(f.occurrence.imageId)?.request?.captureId).toBe(record.request!.captureId);
});

test("a lost register response queries the same identity and never issues a second register", async () => {
  const f = await fixture(); f.setLost(); f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  await f.coordinator.tick(); const original = f.coordinator.get(f.occurrence.imageId)!.request;
  expect(f.calls).toEqual(["register"]);
  await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "query", "commit"]);
  expect(f.coordinator.get(f.occurrence.imageId)!.request).toEqual(original);
});

test("untrusted resource identifiers and unsupported schemes never become local paths", async () => {
  const f = await fixture(); f.coordinator.enqueue(f.occurrence, `daynight-resource:${randomUUID()}`, f.context);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  expect(f.calls).toEqual([]); expect(f.coordinator.get(f.occurrence.imageId)!.error?.code).toBe("source_forbidden");
});

test("a committed capture imports its verified original before publishing the resource and survives source deletion", async () => {
  const f = await fixture(); f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const resource = f.committed(); await rm(path.join(f.home, "original.png"));
  await f.coordinator.tick();
  expect(f.changes.at(-1)?.state).toBe("committed");
  expect(Buffer.from(f.journal.readResource(resource.resourceId, "0", 524288).data, "base64")).toEqual(f.bytes);
  expect(f.coordinator.get(f.occurrence.imageId)?.phase).toBe("settled");
  await f.coordinator.tick(); expect(f.calls).toEqual(["register", "commit", "query"]);
});

test("the execution root cannot be adopted after replacement before the first copy", async () => {
  const f = await fixture(); f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  await rename(f.home, `${f.home}-original`); await mkdir(f.home); await writeFile(path.join(f.home, "original.png"), f.bytes);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "failed"]);
  expect(f.changes.at(-1)).toMatchObject({ state: "failed", error: { code: "source_forbidden" } });
});

test("an interrupted writer settles from the original query without opening the now changed source", async () => {
  const f = await fixture(); f.setLost(); f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const record = f.coordinator.get(f.occurrence.imageId)!;
  f.journal.markdownStore.put("source", f.occurrence.imageId, { ...record, started: true, phase: "reading" });
  await rm(path.join(f.home, "original.png"));
  await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "query", "failed"]);
  expect(f.coordinator.get(f.occurrence.imageId)!.request).toEqual(record.request);
  expect(f.journal.media().captureStatus(record.request!.captureId, record.request!.attemptId)).toBeNull();
});

test("querying a new retry reservation waits for its original control request and does not fail or duplicate the writer", async () => {
  const f = await fixture(); f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const attemptId = f.serviceRetry(); await f.coordinator.tick(); await f.coordinator.tick();
  expect(f.calls).toEqual(["register", "commit", "query", "query"]);
  const request = f.coordinator.get(f.occurrence.imageId)!.request!;
  expect(request.attemptId).toBe(attemptId);
  expect(f.journal.media().captureStatus(request.captureId, attemptId)).toBeNull();
  const validated = await f.coordinator.retry(request, new AbortController().signal);
  expect(validated.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
  expect(await f.coordinator.retry(request, new AbortController().signal)).toEqual(validated);
});

test.each([
  { bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), code: "decode_failed" },
  { bytes: Buffer.from("<svg/>"), code: "unsupported_media_type" },
])("a real decoder failure remains $code on its original occurrence until an explicit retry", async ({ bytes, code }) => {
  let decoder!: ImageDecoder;
  const f = await fixture(undefined, {}, (request, signal) => decoder(request, signal));
  decoder = await sourceImageDecoder(path.join(f.home, "decoder"));
  await writeFile(path.join(f.home, "original.png"), bytes);
  f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const failed = f.coordinator.get(f.occurrence.imageId)!;
  expect(failed).toMatchObject({ phase: "settled", error: { code }, receipt: { state: "failed", error: { code } } });
  expect(f.calls).toEqual(["register", "failed"]);
  await writeFile(path.join(f.home, "original.png"), f.bytes);
  await f.coordinator.tick(); expect(f.calls).toEqual(["register", "failed"]);
  const attemptId = f.serviceRetry(), request = f.journal.retryImageCaptureRequest(failed.request!.captureId, attemptId);
  const validated = await f.coordinator.retry(request, new AbortController().signal);
  expect(validated.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
  expect(f.coordinator.get(f.occurrence.imageId)?.request).toEqual({ ...failed.request, attemptId });
});

test("two active sources refuse a retry before source work and accept the same attempt after capacity returns", async () => {
  const gate = Promise.withResolvers<void>(); let hold = false, entered = 0;
  const f = await fixture(async checkpoint => { if (hold && checkpoint.stage === "initial") { entered++; await gate.promise; } });
  await rm(path.join(f.home, "original.png"));
  f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  const original = f.coordinator.get(f.occurrence.imageId)!;
  expect(original.error?.code).toBe("source_not_found");
  const attemptId = f.serviceRetry(), request = f.journal.retryImageCaptureRequest(original.request!.captureId, attemptId);
  await writeFile(path.join(f.home, "original.png"), f.bytes);
  for (const name of ["active-one.png", "active-two.png"]) {
    const text = `![active](${name})`, imageId = randomUUID(), entryId = randomUUID(), partId = randomUUID(), textSha256 = createHash("sha256").update(text).digest("hex");
    const occurrence = { imageId, entryId, partId, sourceRevision: "1", sourceTextSha256: textSha256, container: "content" as const, callId: null, sourceKey: `${partId}:1:0` };
    f.journal.projectTimeline({ entryId, revision: "1", kind: "assistant_message", imageProjectionError: null, content: [{ type: "markdown", text, partId, revision: "1", textSha256, complete: true, truncated: false, bindings: [{ imageId, start: 0, end: text.length, part: { type: "image_unavailable", imageId, label: "active", error: { code: "source_unavailable", message: "Not captured" } } }], retainedImages: [] }] });
    await writeFile(path.join(f.home, name), f.bytes);
    f.coordinator.enqueue(occurrence, name, f.coordinator.contextFor(occurrence));
  }
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); hold = true;
  const pending = f.coordinator.tick();
  try {
    await vi.waitFor(() => expect(entered).toBe(2));
    await expect(f.coordinator.retry(request, new AbortController().signal)).rejects.toMatchObject({ code: "rate_limited" });
    expect(entered).toBe(2);
    expect(f.coordinator.get(f.occurrence.imageId)).toEqual(original);
    expect(f.journal.media().captureStatus(request.captureId, attemptId)).toBeNull();
    expect(f.calls.filter(action => action === "failed")).toHaveLength(1);
  } finally { hold = false; gate.resolve(); await pending; }
  const validated = await f.coordinator.retry(request, new AbortController().signal);
  expect(validated.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
  expect(f.coordinator.get(f.occurrence.imageId)?.request).toEqual(request);
});

test.each(["toString", "constructor", "image_validation_unavailable", "EIO"])("decoder infrastructure error %s does not establish a retryable image rejection", async code => {
  const f = await fixture(undefined, {}, async () => { throw Object.assign(new Error("Image validation is unavailable."), { code }); });
  f.coordinator.enqueue(f.occurrence, "original.png", f.context);
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); await f.coordinator.tick();
  expect(f.coordinator.get(f.occurrence.imageId)).toMatchObject({ phase: "settled", error: { code: "source_unavailable" }, receipt: { state: "failed", error: { code: "source_unavailable" } } });
  expect(f.calls).toEqual(["register", "failed"]);
});
