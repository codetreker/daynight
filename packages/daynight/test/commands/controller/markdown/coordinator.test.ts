import { afterEach, expect, test } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { openControllerLifecycleStore } from "../../../../src/commands/controller/lifecycle-store.js";
import { createControllerCaptureBridge } from "../../../../src/commands/controller/media/capture.js";
import { createMarkdownCaptureCoordinator } from "../../../../src/commands/controller/markdown/coordinator.js";
import { validateImageFile } from "../../../../src/commands/controller/media/image-validation.js";
import type { ControllerLaunchTicket } from "../../../../src/commands/controller/launch-ticket.js";
import type { ImageCaptureReceipt, ImageCaptureRequest } from "../../../../src/session/image-values.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../../.tmp/a3-coordinator-tests");
  await mkdir(base, { recursive: true }); const home = await mkdtemp(path.join(base, "c-"));
  const workspace = path.join(home, "workspace"); await mkdir(workspace);
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const currentTicket = { ...ticket, cwd: workspace };
  const file = path.join(home, "journal.sqlite"), journal = openControllerLifecycleStore(file, currentTicket, { imageDecoder: validateImageFile });
  journal.patchSnapshot({ nativeSessionId: randomUUID() });
  const body = "![original](original.png)", entryId = randomUUID(), partId = randomUUID(), imageId = randomUUID();
  const occurrence = { imageId, entryId, partId, sourceRevision: "1", sourceTextSha256: createHash("sha256").update(body).digest("hex"), container: "content" as const, callId: null, sourceKey: `${partId}:1:0` };
  journal.projectTimeline({ entryId, revision: "1", kind: "assistant_message", imageProjectionError: null, content: [{ type: "markdown", text: body, partId, revision: "1", textSha256: occurrence.sourceTextSha256, complete: true, truncated: false, bindings: [{ imageId, start: 0, end: body.length, part: { type: "image_unavailable", imageId, label: "original", error: { code: "source_unavailable", message: "Not captured" } } }], retainedImages: [] }] });
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background: "blue" } }).png().toBuffer();
  await writeFile(path.join(workspace, "original.png"), bytes);
  let receipt: ImageCaptureReceipt | null = null, loseRegister = false, allowed = true;
  const calls: string[] = [], changes: ImageCaptureReceipt[] = [];
  const bridge = createControllerCaptureBridge({ journal, beforeCapture: async () => {}, provider: () => null, writable: () => true,
    capture: async (action, body) => {
      calls.push(action);
      if (action === "register") { const request = body as ImageCaptureRequest; receipt = { captureId: request.captureId, attemptId: request.attemptId, revision: "1", occurrence: request.occurrence, state: "reserved", resourceId: randomUUID(), resource: null, error: null }; if (loseRegister) throw new Error("Lost receipt"); }
      if (!receipt) throw new Error("Unknown capture");
      if (action === "commit") receipt = { ...receipt, revision: String(BigInt(receipt.revision) + 1n), state: "copying" };
      if (action === "failed") receipt = { ...receipt, revision: String(BigInt(receipt.revision) + 1n), state: "failed", resourceId: null, error: (body as { error: { code: string; message: string } }).error };
      return receipt;
    } });
  const coordinator = createMarkdownCaptureCoordinator({ ticket: currentTicket, journal, bridge: bridge.providerOptions, writable: () => true, fence: () => "test-fence", nativeReadPolicy: () => ({ revision: "verified-test-policy", verify: () => { if (!allowed) throw new Error("revoked"); } }), onReceipt: (_request, value) => { changes.push(value); } });
  cleanups.push(async () => { await coordinator.stop(); await journal.stopMedia(); journal.close(); });
  const context = coordinator.contextFor(occurrence);
  const committed = () => {
    if (!receipt) throw new Error("No receipt");
    const resource = { resourceId: receipt.resourceId!, revision: "1", status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), width: 8, height: 6, frameCount: 1, error: null };
    receipt = { ...receipt, revision: String(BigInt(receipt.revision) + 1n), state: "committed", resource };
    return resource;
  };
  const serviceRetry = () => {
    if (!receipt) throw new Error("No receipt");
    const attemptId = randomUUID();
    receipt = { ...receipt, attemptId, revision: String(BigInt(receipt.revision) + 1n), state: "reserved", resourceId: randomUUID(), resource: null, error: null };
    return attemptId;
  };
  return { journal, coordinator, occurrence, context, calls, changes, bytes, home: workspace, committed, serviceRetry, setLost: () => { loseRegister = true; }, revoke: () => { allowed = false; } };
};

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
  f.revoke();
  await expect(f.journal.media().readCapture({ captureId: record.request!.captureId, attemptId: record.request!.attemptId, ...validated, offset: "0", limit: 524288 }, f.coordinator.acquireReadPolicy)).rejects.toThrow();
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
