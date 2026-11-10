import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { providerDisplayEntry } from "../../../src/commands/controller/provider-display.js";
import { CodexControls } from "../../../src/commands/controller/providers/controls-codex.js";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import { codexImageProfile, type CodexImageProfile } from "../../../src/commands/controller/providers/codex-image-profile.js";
import { CodexImageInputs } from "../../../src/commands/controller/providers/codex-image-input.js";
import { CodexImageProjection } from "../../../src/commands/controller/providers/codex-image-projection.js";
import { CodexMediaReference } from "../../../src/commands/controller/providers/codex-rpc-json.js";
import { ProviderImageProjector } from "../../../src/commands/controller/providers/image-projector.js";
import { CodexProjection } from "../../../src/commands/controller/providers/projection.js";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import type { ProviderImageCapabilities } from "../../../src/session/image-values.js";

const lifecycle = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "codex-image-journal-"));
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(root, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "test", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const filename = path.join(root, "state.sqlite"), historyEpoch = randomUUID();
  const fixture = {
    root,
    journal: openControllerLifecycleStore(filename, ticket, { contentOwnedLocally: true }),
    stored: () => fixture.journal.readTimeline({ historyEpoch, direction: "tail", cursor: null, limit: 100 }).items,
    reopen: async () => { await fixture.journal.stopMedia(); fixture.journal.close(); fixture.journal = openControllerLifecycleStore(filename, ticket, { contentOwnedLocally: true }); },
    cleanup: async () => { await fixture.journal.stopMedia(); fixture.journal.close(); await rm(root, { recursive: true, force: true }); },
  };
  return fixture;
};

test.each([false, true])("Codex startup with resume=%s journals unknown geometry and rejects image dispatch without native calls", async resumed => {
  const f = await lifecycle(), capabilities: ProviderImageCapabilities[] = [], log = path.join(f.root, "requests.jsonl");
  let child: ChildProcess | undefined;
  const provider = await openCodexProvider({ cwd: f.root, model: null, args: [], resumeNativeSessionId: resumed ? "images-thread" : null,
    executable: fileURLToPath(new URL("./fixtures/codex-images-native.mjs", import.meta.url)), env: { ...process.env, CODEX_IMAGES_LOG: log, CODEX_IMAGES_COMPATIBLE: "1" },
    onSpawn: value => { child = value; }, onTimeline: entry => { f.journal.projectTimeline(providerDisplayEntry(entry)); },
    onState: state => { if (state.images) capabilities.push(f.journal.providerImageCapabilities(state.images)); },
  }).catch(async error => { await f.cleanup(); throw error; });
  try {
    expect(capabilities.at(-1)).toMatchObject({ modelId: "fixture-vision", expectedNativeSessionId: "images-thread", send: "unknown", steer: "unknown", reasonCode: process.platform === "darwin" ? "capability_unknown" : "profile_disabled", geometry: { known: false } });
    await expect(provider.send({ content: [{ type: "image", imageId: randomUUID(), resourceId: randomUUID(), localPath: path.join(f.root, "unopened.png"), mediaType: "image/png", byteLength: "1", sha256: "a".repeat(64) }] }, randomUUID(), null)).rejects.toThrow("capability is unknown or unsupported");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => ["turn/start", "turn/steer"].includes(call.method))).toEqual([]);
    await provider.close();
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    const last = capabilities.at(-1)!, { revision: _, ...value } = last;
    await f.reopen(); expect(f.journal.providerImageCapabilities(value)).toEqual(last);
  } finally { await provider.close(); await f.cleanup(); }
});

test("Codex capabilities pass the real lifecycle codec and retain revisions after journal reopen", async () => {
  const f = await lifecycle();
  const controls = new CodexControls({ request: async method => method === "model/list" ? { data: [{ model: "gpt-6-astra", inputModalities: ["text", "image"] }, { model: "text", inputModalities: ["text"] }], nextCursor: null } : method === "skills/list" ? { data: [] } : { requirements: null } }, () => "thread", () => null, f.root, f.root, () => {});
  const native = { model: "gpt-6-astra", modelProvider: "copilot_gateway" };
  const profile = codexImageProfile({ userAgent: "daynight/0.167.0 (Mac OS)", platformOs: "macos" }, native, "darwin");
  const controlled: CodexImageProfile = { modelId: native.model, modelProvider: native.modelProvider, geometry: { version: 1, known: true, maxWidth: 1024, maxHeight: 1024, maxPixels: 1_048_576, maxFrames: 1 } };
  try {
    controls.seed(native); await controls.refresh();
    const unknown = f.journal.providerImageCapabilities(controls.imageCapabilities(profile));
    expect(unknown).toMatchObject({ revision: "1", send: "unknown", steer: "unknown", reasonCode: "capability_unknown", geometry: { known: false } });
    await f.reopen();
    expect(f.journal.providerImageCapabilities(controls.imageCapabilities(profile))).toEqual(unknown);
    const supported = f.journal.providerImageCapabilities(controls.imageCapabilities(controlled));
    expect(supported).toMatchObject({ revision: "2", send: "supported", steer: "supported", reasonCode: null, geometry: { known: true } });
    controls.observe({ model: "text" });
    expect(f.journal.providerImageCapabilities(controls.imageCapabilities(profile))).toMatchObject({ revision: "3", send: "unsupported", reasonCode: "model_unsupported" });
    expect(f.journal.providerImageCapabilities(controls.imageCapabilities(null))).toMatchObject({ revision: "4", send: "unknown", reasonCode: "profile_disabled" });
    controls.observe(native);
    const restored = f.journal.providerImageCapabilities(controls.imageCapabilities(profile));
    await f.reopen(); expect(f.journal.providerImageCapabilities(controls.imageCapabilities(profile))).toEqual(restored);
  } finally { controls.close(); await f.cleanup(); }
});

test("Codex tool arguments, errors and image ownership survive the production timeline journal roundtrip", async () => {
  const f = await lifecycle();
  f.journal.patchSnapshot({ nativeSessionId: "thread" });
  const options: ProviderOptions = {
    cwd: f.root, model: null, args: [], resumeNativeSessionId: "thread", onSpawn() {}, onState() {},
    onTimeline: entry => { f.journal.projectTimeline(providerDisplayEntry(entry)); },
    onImageOccurrence: (occurrence, source) => f.journal.registerImageOccurrence(occurrence, source).acknowledged,
    imageOccurrenceAcknowledged: imageId => f.journal.imageOccurrenceAcknowledged(imageId),
    imageRuntime: {
      getIntent: () => null, readState: key => f.journal.readNativeImageState(key), writeState: (key, value) => f.journal.writeNativeImageState(key, value),
      createSpool: maximum => f.journal.media().createSpool(maximum), indexDirectory: () => f.journal.media().nativeIndexDirectory(), reserveIndex: additional => f.journal.media().reserveNativeIndex(additional), acquireIndexReservation: (additional, owner) => f.journal.acquireNativeIndexReservation(additional, owner),
    },
  };
  const items = [
    { id: "failure", type: "mcpToolCall", tool: "lookup", arguments: { query: "record" }, status: "failed", result: null, error: { message: "Access denied by remote server" } },
    { id: "dynamic", type: "dynamicToolCall", tool: "lookup", arguments: { query: "record" }, contentItems: [{ type: "inputText", text: "found" }], success: true },
    { id: "image", type: "mcpToolCall", tool: "draw", arguments: { prompt: "triangle" }, status: "failed", error: { message: "Render failed" }, result: { content: [{ type: "image", data: new CodexMediaReference("unavailable", "image/png", null, null, "native_source_unavailable") }] } },
  ];
  const publish = async () => {
    const publisher = new ProviderImageProjector(options), images = new CodexImageProjection("thread", options, new CodexImageInputs(options, "thread"), publisher);
    const projection = new CodexProjection("thread", entry => publisher.publish(entry), images);
    try { for (const item of items) projection.item(item, true, "turn"); } finally { await publisher.close(); }
  };
  try {
    await publish();
    const before = f.stored();
    expect(before).toHaveLength(3);
    expect(before.find(entry => entry.kind === "tool_call" && entry.callId === "failure")).toMatchObject({ input: JSON.stringify({ query: "record" }, null, 2), status: "failed", output: [{ text: JSON.stringify({ message: "Access denied by remote server" }, null, 2) }] });
    expect(before.find(entry => entry.kind === "tool_call" && entry.callId === "image")).toMatchObject({ input: JSON.stringify({ prompt: "triangle" }, null, 2), status: "failed", output: [{ type: "image_unavailable" }, { text: "Render failed" }] });
    await f.reopen(); expect(f.stored()).toEqual(before);
    await publish(); expect(f.stored()).toEqual(before);
  } finally { await f.cleanup(); }
});
