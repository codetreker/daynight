import { afterEach, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { createControllerCaptureBridge } from "../../../src/commands/controller/media/capture.js";
import { validateImageFile } from "../../../src/commands/controller/media/image-validation.js";
import type { NativeProvider } from "../../../src/commands/controller/providers/types.js";
import type { ImageCaptureReceipt, ImageCaptureRequest } from "../../../src/session/image-values.js";
import type { createControllerRelay } from "../../../src/commands/controller/relay.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
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

test("source retries preserve the original locator, isolate attempt bytes and reuse a frozen successful attempt", async () => {
  const f = await fixture(), original = await f.source("blue"), replacement = await f.source("red"), attemptId = randomUUID();
  let current = f.receipt(); const calls: unknown[] = [];
  const capture: ReturnType<typeof createControllerRelay>["capture"] = async (action, body) => { calls.push({ action, body }); return current; };
  const resolver = vi.fn(async () => replacement), send = vi.fn();
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
    expect(resolver).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
    await expect(consumer.providerOptions.commitImageCapture!(f.request.captureId, f.request.attemptId, first)).rejects.toThrow("attempt conflict");
    await expect(f.journal.media().readCapture({ captureId: f.request.captureId, attemptId: f.request.attemptId, sha256: first.sha256, byteLength: first.byteLength, offset: "0", limit: 524288 })).rejects.toThrow("attempt conflict");
    expect(await f.journal.media().readCapture({ captureId: f.request.captureId, attemptId, sha256: validated.sha256, byteLength: validated.byteLength, offset: "0", limit: 524288 })).toMatchObject({ preparationId: attemptId, data: replacement.bytes.toString("base64"), eof: true });
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
    const abort = new AbortController(), send = vi.fn(), resolver = vi.fn(async () => { abort.abort(); return source; });
    const attemptId = randomUUID(), consumer = bridge(f.journal, capture, { retryImageCapture: resolver, send } as unknown as NativeProvider);
    await expect(consumer.retry({ captureId: f.request.captureId, attemptId }, abort.signal)).rejects.toThrow();
    expect(f.journal.media().captureStatus(f.request.captureId, attemptId)).toBeNull(); expect(send).not.toHaveBeenCalled();
  } finally { await f.journal.stopMedia(); f.journal.close(); }
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
  } finally { f.journal.close(); }
});
