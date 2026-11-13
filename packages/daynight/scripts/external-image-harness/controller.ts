import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TLSSocket } from "node:tls";
import type { ControllerState } from "../../src/session/controller-protocol.js";
import type { MarkdownCaptureRecord } from "../../src/commands/controller/markdown/coordinator.js";

const load = async <T>(name: string): Promise<T> => import(new URL(`../../dist/${name}.js`, import.meta.url).href) as Promise<T>;
const { readLaunchTicket } = await load<typeof import("../../src/commands/controller/launch-ticket.js")>("commands/controller/launch-ticket");
const { openControllerLifecycleStore } = await load<typeof import("../../src/commands/controller/lifecycle-store.js")>("commands/controller/lifecycle-store");
const { createControllerRelay } = await load<typeof import("../../src/commands/controller/relay.js")>("commands/controller/relay");
const { createControllerCaptureBridge } = await load<typeof import("../../src/commands/controller/media/capture.js")>("commands/controller/media/capture");
const { syncControllerImageHistory } = await load<typeof import("../../src/commands/controller/media/history-sync.js")>("commands/controller/media/history-sync");
const { createExternalImagePolicyProducer } = await load<typeof import("../../src/commands/controller/markdown/external-policy.js")>("commands/controller/markdown/external-policy");
const { createMarkdownCaptureCoordinator } = await load<typeof import("../../src/commands/controller/markdown/coordinator.js")>("commands/controller/markdown/coordinator");
const { createMarkdownTimelinePipeline } = await load<typeof import("../../src/commands/controller/markdown/pipeline.js")>("commands/controller/markdown/pipeline");
const { resolveConfigurationPaths } = await load<typeof import("../../src/config/paths.js")>("config/paths");

const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  home: string; launchId: string; directory: string; results: string; sourceURLs: [string, string];
};
const ticket = await readLaunchTicket(input.home, input.launchId);
process.chdir(ticket.cwd);
const persist = async (name: string, value: unknown): Promise<void> => {
  const filename = path.join(input.results, name);
  await writeFile(`${filename}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${filename}.tmp`, filename);
};
const exists = async (filename: string): Promise<boolean> => {
  try { await stat(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
const journal = openControllerLifecycleStore(path.join(input.directory, "journal.sqlite"), ticket, {
  contentOwnedLocally: true, mediaStateDirectory: resolveConfigurationPaths(input.home).stateDirectory,
});
// This identifier binds controlled Markdown input; no native model is invoked.
const controlledNativeSessionId = randomUUID();
journal.patchSnapshot({ nativeSessionId: controlledNativeSessionId, lifecycle: "ready", activity: "idle" });
const events: Record<string, unknown>[] = [], targets: Record<string, unknown>[] = [], requests: Record<string, unknown>[] = [];
const failures: unknown[] = [];
let stopping = false, synchronized = false, historyWork: Promise<void> | null = null;
const historyAbort = new AbortController();
const mark = (kind: string, value: Record<string, unknown> = {}) => events.push({ at: new Date().toISOString(), kind, ...value });
const diagnostics = channel("http.client.request.start");
const observeRequest = (value: unknown) => {
  const request = (value as { request: ClientRequest }).request;
  if (request.getHeader("user-agent") !== "Daynight-Image-Source/1") return;
  const socket = request.socket as TLSSocket;
  const evidence: Record<string, unknown> = {
    host: request.getHeader("host"), path: request.path, method: request.method,
    actualPeer: socket.remoteAddress, remotePort: socket.remotePort,
    transport: socket.encrypted ? "https" : "http",
    tlsAuthorized: socket.encrypted ? socket.authorized : null,
    tlsVersion: socket.encrypted ? socket.getProtocol() : null,
    peerCertificateSHA256: socket.encrypted ? socket.getPeerCertificate().fingerprint256 : null,
  };
  requests.push(evidence);
  request.once("response", response => {
    evidence.status = response.statusCode;
    evidence.contentType = response.headers["content-type"] ?? null;
    evidence.location = response.headers.location ?? null;
    response.once("end", () => { evidence.complete = response.complete; });
  });
};
diagnostics.subscribe(observeRequest);
const readState = (): ControllerState => ({
  nativeSessionId: controlledNativeSessionId, initialInputState: "not_required", synchronized,
  activity: stopping ? "stopped" : "idle", currentTurnId: null,
  capabilities: { send: false, steer: false, cancel: false, respond: false },
});
let captures: ReturnType<typeof createMarkdownCaptureCoordinator>;
let timeline: ReturnType<typeof createMarkdownTimelinePipeline>;
const relay = createControllerRelay(ticket, journal, {
  onConnection: connected => { synchronized = connected; mark("connection", { connected }); if (!connected) captures?.invalidate(); journal.appendEvent({ kind: "state", payload: readState() }); },
  onCommand: async () => { throw new Error("This source regression never submits native input."); },
  onError: message => { mark("relay-error", { message }); }, readState,
  onAcknowledged: () => { mark("source-ack", { through: journal.getLastAcknowledgedSequence() }); },
  beforeImage: () => syncHistory(),
  acquireCaptureReadPolicy: request => captures.acquireReadPolicy(request),
});
const syncHistory = (): Promise<void> => {
  if (historyWork) return historyWork;
  historyWork = (async () => {
    assert(relay.connected() && relay.imageHistorySupported(), "Real relay must support the history ledger.");
    await relay.flush(10_000);
    const fence = relay.currentFence(); assert(fence);
    await syncControllerImageHistory({ ticket, journal, fence, currentFence: relay.currentFence, signal: historyAbort.signal,
      request: async (url, init) => {
        const response = await fetch(url, init);
        mark("history-http-receipt", { method: init?.method, path: new URL(String(url)).pathname, status: response.status, receipt: await response.clone().json() });
        return response;
      },
    });
    mark("history-synchronized", { fence, through: journal.getLastAcknowledgedSequence() });
  })().finally(() => { historyWork = null; });
  return historyWork;
};
const bridge = createControllerCaptureBridge({
  journal, beforeCapture: syncHistory, provider: () => null, writable: () => !stopping && relay.connected(),
  capture: async (action, body) => {
    assert(action === "submit" || action === "query", "Direct source capture cannot call legacy quota controls.");
    if (action === "submit") assert(journal.imageOccurrenceAcknowledged((body as { request: { occurrence: { imageId: string } } }).request.occurrence.imageId));
    const receipt = await relay.capture(action, body);
    mark("service-capture", { action, receipt, sourceAcknowledgedThrough: journal.getLastAcknowledgedSequence() });
    return receipt;
  },
});
const policy = createExternalImagePolicyProducer({ paths: resolveConfigurationPaths(input.home) });
captures = createMarkdownCaptureCoordinator({
  ticket, journal, bridge: bridge.providerOptions, writable: () => !stopping && relay.connected(),
  fence: () => { const fence = relay.currentFence(); return fence ? JSON.stringify(fence) : null; },
  acquireExternalPolicy: async () => {
    const lease = await policy.acquire();
    // Observe successful production guard checkpoints without changing admission.
    return { ...lease, assertTarget: async target => {
      await lease.assertTarget(target);
      targets.push({ at: new Date().toISOString(), ...target, revision: lease.revision, generation: lease.generation });
    } };
  },
  onReceipt: (request, receipt) => timeline.receipt(request, receipt),
  onFailure: (occurrence, error) => { timeline.failure(occurrence, error); failures.push(new Error(`Image ${occurrence.imageId}: ${error.code}`)); },
});
timeline = createMarkdownTimelinePipeline({ journal, captures, onError: error => { failures.push(error); } });
const stop = () => { stopping = true; };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
const records = (): MarkdownCaptureRecord[] => journal.markdownStore.listIds("source", { limit: 32 }).map(id => captures.get(id)!);
let committed: MarkdownCaptureRecord[] | undefined;
try {
  const readyDeadline = Date.now() + 30_000;
  while (!relay.connected()) { assert(Date.now() < readyDeadline, "Controller relay did not synchronize."); await delay(50); }
  assert(relay.imageHistorySupported());
  journal.appendEvent({ kind: "state", payload: readState() });
  const entryId = randomUUID();
  const markdown = input.sourceURLs.map((url, index) => `![public-${index === 0 ? "http" : "https"}](${url})`).join("\n\n");
  assert(timeline.accept({ entryId, revision: "1", kind: "assistant_message", content: [{ type: "text", text: markdown }] }, { format: "markdown", complete: true, truncated: false }));
  await persist("controlled-input.json", { kind: "controlled-complete-markdown", nativeModelInvoked: false, controlledNativeSessionId, entryId, markdown });
  const captureDeadline = Date.now() + 120_000;
  while (!stopping) {
    if (failures.length) throw new AggregateError(failures, "Source regression failed.");
    assert(Date.now() < captureDeadline, "Original capture identities did not reach committed before the deadline.");
    await timeline.tick(); await captures.tick();
    const current = records();
    if (current.length === 2 && current.every(record => record.phase === "settled" && record.receipt?.state === "committed")) {
      committed = current; break;
    }
    if (current.some(record => record.receipt?.state === "failed")) throw new Error("The real service rejected an original capture.");
    await delay(100);
  }
  assert(committed, "Controller stopped before immutable originals were committed.");
  await timeline.drain(); await relay.flush(10_000); await syncHistory();
  for (const record of committed) {
    assert(record.request && record.receipt?.resource && record.sourceAdmission);
    assert.equal(record.receipt.attemptId, record.request.attemptId);
    assert.equal(record.receipt.resource.sha256, record.sourceAdmission.validated.sha256);
    const captureEvents = events.filter(event => event.kind === "service-capture" && (event.receipt as { captureId?: string }).captureId === record.request!.captureId);
    assert(captureEvents.some(event => (event.receipt as { state: string }).state === "copying"));
    assert(captureEvents.some(event => event.action === "query" && (event.receipt as { state: string }).state === "committed"));
    assert(journal.imageOccurrenceAcknowledged(record.occurrence.imageId));
  }
  assert.equal(requests.length, 2, "Each original is fetched once without redirects or recapture.");
  for (const transport of ["http", "https"]) {
    const request = requests.find(item => item.transport === transport); assert(request);
    assert.equal(request.status, 200); assert.equal(request.location, null); assert.equal(request.complete, true);
    assert.equal(request.contentType, "image/png");
    assert(targets.some(target => target.address === request.actualPeer), "The production guard must admit the actual connected peer.");
    if (transport === "https") { assert.equal(request.tlsAuthorized, true); assert(request.peerCertificateSHA256); }
  }
  await persist("controller-committed.json", {
    sessionId: ticket.sessionId, testExecutionId: ticket.testExecutionId, fence: relay.currentFence(),
    sourceAcknowledgedThrough: journal.getLastAcknowledgedSequence(), captures: committed,
    requests, productionTargetCheckpoints: targets, events,
  });
  const stopDeadline = Date.now() + 120_000;
  while (!stopping && !await exists(path.join(input.directory, "stop"))) {
    assert(Date.now() < stopDeadline, "The parent did not stop the original Controller.");
    assert(relay.connected(), "Controller disconnected before the explicit stop.");
    await delay(100);
  }
} catch (error) { failures.push(error); }
finally {
  stopping = true;
  for (const close of [() => captures.stop(), () => timeline.stop(), () => policy.close(), () => relay.close()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  historyAbort.abort(); await (historyWork as Promise<void> | null)?.catch((error: unknown) => failures.push(error));
  let finalCaptures: MarkdownCaptureRecord[] = [];
  try { finalCaptures = records(); } catch (error) { failures.push(error); }
  try { await journal.stopMedia(); journal.close(); } catch (error) { failures.push(error); }
  diagnostics.unsubscribe(observeRequest);
  process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  await persist("controller-closed.json", { closedAt: new Date().toISOString(), succeeded: failures.length === 0, failures: failures.map(error => String(error)), requestCount: requests.length, captures: finalCaptures, events, requests, productionTargetCheckpoints: targets });
}
if (failures.length) throw new AggregateError(failures, "External image Controller regression failed.");
