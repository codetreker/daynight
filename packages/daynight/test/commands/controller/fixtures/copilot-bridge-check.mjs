import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startCopilotRuntime } from "../../../../dist/commands/controller/providers/copilot-runtime.js";
import { isCopilotBridgeImage, retainCopilotBridgeImage, releaseCopilotBridgeImage, sendCopilotBridgeImages } from "../../../../dist/commands/controller/providers/copilot-bridge.js";
import { CopilotReadCorrelation, copilotReadMarker } from "../../../../dist/commands/controller/providers/copilot-read-authority-correlation.js";
import { openNativeMediaSpool } from "../../../../dist/commands/controller/media/native-spool.js";
import { validateImageFile } from "../../../../dist/commands/controller/media/image-validation.js";

const [root, mode, mediaPath, mediaType = "image/png", expectedFrames = "1"] = process.argv.slice(2), log = path.join(root, "requests.log");
const children = [], events = [], losses = [], traces = [];
let permissionRequest;
const correlation = new CopilotReadCorrelation("b".repeat(64), "fixture-session"), hidden = [];
const records = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
const eventually = async predicate => {
  for (let attempt = 0; attempt < 400; attempt++) { if (predicate()) return; await delay(10); }
  throw new Error("Fixture observation timed out.");
};
let maxFrameBytes = 0, peakControllerRss = process.memoryUsage().rss, decodedImages = 0;
const runtime = startCopilotRuntime({ cwd: root, model: null, args: [], resumeNativeSessionId: null,
  executable: fileURLToPath(new URL("copilot-bridge-native.mjs", import.meta.url)),
  env: { ...process.env, DAYNIGHT_TEST_BRIDGE_LOG: log, DAYNIGHT_TEST_BRIDGE_MODE: mode, DAYNIGHT_TEST_BRIDGE_MEDIA: mediaPath ?? "", DAYNIGHT_TEST_BRIDGE_MIME: mediaType }, onTimeline() {}, onState() {},
  onSpawn(child) {
    children.push(child);
    if (children.length === 2) {
      let bytes = 0;
      child.stdout.on("data", chunk => { peakControllerRss = Math.max(peakControllerRss, process.memoryUsage().rss); for (const byte of chunk) { bytes++; if (byte === 10) { maxFrameBytes = Math.max(maxFrameBytes, bytes); bytes = 0; } } });
    }
  }, onDiagnostic(line) { traces.push(line); },
}, error => losses.push(error), undefined, mode === "no-media" ? undefined : { createSpool(maxBytes) {
  if (mode === "capture-failure") throw new Error("Fixture shared media owner capacity exhausted.");
  return openNativeMediaSpool(path.join(root, randomUUID()), maxBytes, () => {}, () => {});
} });
let releaseReader;
process.once("SIGTERM", () => { void runtime.close(true).finally(() => process.exit(1)); });
try {
  const client = await runtime.ready;
  assert.equal(children.length, 2);
  assert.notEqual(children[0].pid, children[1].pid);
  const config = { sessionId: "fixture-session", onEvent(event) { if (correlation.suppress(event)) { hidden.push(event); return; } if (event.id === "permission-event") assert.equal(event.data.permissionRequest, permissionRequest, "The bridge must preserve the exact callback object."); events.push(event); }, onPermissionRequest(request, context) {
    const refusal = correlation.reject(request, context); if (refusal) return refusal;
    permissionRequest = request;
    return { kind: "no-result" };
  } };
  if (mode === "open-race") {
    const opening = client.createSession(config);
    const other = client.createSession({ sessionId: "second-session", onPermissionRequest: config.onPermissionRequest });
    await assert.rejects(other, /binding/); await opening;
    assert.equal(records().filter(record => record.method === "session.create").length, 1);
  } else if (mode === "admission-revoked" || mode === "admission-close") {
    const session = await client.createSession(config), filename = path.join(root, "admission.png"), bytes = Buffer.alloc(524288, 7);
    writeFileSync(filename, bytes, { mode: 0o400 });
    let allowed = true, checks = 0;
    const pending = sendCopilotBridgeImages(session, { prompt: "", mode: "immediate", attachments: [{ path: filename, byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png" }] }, () => {
      checks++; assert.equal(allowed, true, "effective image qualification shrank while encoding");
    });
    const refused = assert.rejects(pending);
    if (mode === "admission-revoked") allowed = false;
    else await runtime.close(true);
    await refused;
    assert.equal(records().filter(record => record.method === "session.send").length, 0);
    if (mode === "admission-revoked") assert.equal(checks, 1);
  } else {
    const session = await client.createSession(config);
    assert.equal(session.sessionId, "fixture-session");
    if (mode === "kill-helper" || mode === "kill-native" || mode === "malformed") {
      const pending = client.ping("hold"), rejected = assert.rejects(pending, /unknown|exited|frame/);
      const history = session.rpc.eventLog.read({ cursor: "hold", max: 1, includeEphemeral: false }), historyRejected = assert.rejects(history, /unknown|exited|frame/);
      await eventually(() => records().some(record => record.method === "ping"));
      await assert.rejects(session.rpc.eventLog.read({ max: 1, includeEphemeral: false }), /in progress/);
      if (mode === "malformed") await assert.rejects(client.ping("malformed"), /frame|unknown/);
      else children[mode === "kill-helper" ? 1 : 0].kill("SIGKILL");
      await rejected; await historyRejected; await eventually(() => losses.length > 0);
      assert.equal(records().filter(record => record.connected).length, 1);
    } else {
      if (mode === "read-authority") {
        const sourcePath = path.join(root, "source.png"), marker = copilotReadMarker("b".repeat(64), session.sessionId, randomUUID(), 1, "c".repeat(64), sourcePath);
        correlation.issue(marker, sourcePath);
        await client.ping(JSON.stringify({ kind: "source-permission", path: sourcePath, intention: marker }));
        await eventually(() => hidden.length === 2);
        const decision = records().find(record => record.method === "session.permissions.handlePendingPermissionRequest" && record.params.requestId === "source-request");
        assert.equal(decision.params.result.kind, "reject");
        assert.match(decision.params.result.feedback, /^daynight-local-image-refusal-v1:[a-f0-9]{64}$/);
        const restored = new CopilotReadCorrelation("b".repeat(64), session.sessionId); restored.prepareHistory(hidden);
        assert(hidden.every(event => restored.suppress(event, true)));
        assert(!events.some(event => event.id.startsWith("source-")));
      }
      assert.deepEqual(await client.ping("health"), { message: "health", timestamp: 1 });
      assert.deepEqual(await session.rpc.model.getCurrent(), { modelId: "fixture-model" });
      assert.equal((await client.getSessionMetadata(session.sessionId)).sessionId, session.sessionId);
      const catalog = await client.rpc.models.list({});
      assert.equal(catalog.models.length, 500); assert.equal(catalog.models[499].description, "catalog".repeat(800));
      const filename = path.join(root, "input.png"), bytes = Buffer.from("first-image"); writeFileSync(filename, bytes, { mode: 0o400 });
      const input = { path: filename, byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png" };
      assert.equal(await sendCopilotBridgeImages(session, { prompt: "", mode: "immediate", attachments: [input, { ...input, displayName: "second.png" }] }, () => {}), "sent-1");
      await eventually(() => events.some(event => event.id === "permission-event"));
      await session.rpc.permissions.handlePendingPermissionRequest({ requestId: "permission-request", result: { kind: "reject" } });
      await eventually(() => records().some(record => record.method === "session.permissions.handlePendingPermissionRequest"));
      const send = records().find(record => record.method === "session.send");
      assert.equal(send.params.prompt, ""); assert.equal(send.params.mode, "immediate");
      assert.deepEqual(send.params.attachments, [{ type: "blob", data: bytes.toString("base64"), mimeType: "image/png" }, { type: "blob", data: bytes.toString("base64"), mimeType: "image/png", displayName: "second.png" }]);
      await assert.rejects(sendCopilotBridgeImages(session, { prompt: "must not send", mode: "immediate", attachments: [input, { ...input, sha256: "f".repeat(64) }] }, () => {}), /integrity/);
      assert.equal(records().filter(record => record.method === "session.send").length, 1);
      await assert.rejects(session.getEvents(), /bounded/);
      await assert.rejects(session.rpc.eventLog.read({ max: 500, includeEphemeral: false }), /max=1/);
      await assert.rejects(session.rpc.eventLog.read({ sessionId: "unbound-session", max: 1, includeEphemeral: false }), /identity/);
      await assert.rejects(session.send({ prompt: "", attachments: [{ type: "blob", data: "eHk=", mimeType: "image/png" }] }), /controlled bridge leases/);
      const page = await session.rpc.eventLog.read({ cursor: "cursor-0", max: 1, includeEphemeral: false });
      const output = page.events[0], marker = output.data.result.contents[1].data;
      assert.equal(page.cursor, "cursor-1"); assert.equal(output.data.agentId, "agent"); assert.equal(output.data.parentToolCallId, "parent-tool"); assert.equal(output.data.success, false);
      assert.equal(output.data.result.contents[0].text, "before"); assert.equal(output.data.result.contents.at(-1).text, "after");
      assert.equal(output.data.result.structuredContent.data, "structured-data");
      if (mode === "no-media" || mode === "capture-failure") assert.deepEqual(marker, { kind: "copilot_bridge_unavailable", code: mode === "no-media" ? "component_unsupported" : "capture_failed" });
      else if (["many-images", "valid-many-images", "valid-animation"].includes(mode)) {
        const markers = output.data.result.contents.filter(item => item.type === "image").map(item => item.data);
        const count = mode === "valid-animation" ? 1 : 5;
        const expected = mediaPath ? readFileSync(mediaPath) : Buffer.alloc(9 * 1_048_576, 65);
        assert.equal(markers.length, count); assert.equal(runtime.bridgeMetrics().mediaCount, count);
        assert.equal(runtime.bridgeMetrics().mediaBytes, count * expected.length);
        assert.deepEqual(await client.ping("health"), { message: "health", timestamp: 1 });
        for (const image of markers) {
          assert(isCopilotBridgeImage(image)); assert(readFileSync(image.path).equals(expected));
          if (mediaPath) {
            const release = retainCopilotBridgeImage(image);
            releaseCopilotBridgeImage(image);
            try {
              assert(existsSync(image.path));
              const validated = await validateImageFile({ version: 1, policy: "image-validation-v1", inputPath: image.path, expectedByteLength: String(expected.length), expectedSha256: createHash("sha256").update(expected).digest("hex") });
              assert.equal(validated.mediaType, mediaType); assert.equal(validated.frameCount, Number(expectedFrames)); decodedImages++;
            } finally { release(); }
          }
        }
        for (const image of markers) releaseCopilotBridgeImage(image);
        assert.equal(runtime.bridgeMetrics().mediaCount, 0); assert.equal(runtime.bridgeMetrics().mediaBytes, 0);
        assert(markers.every(image => !existsSync(image.path))); await runtime.close();
      }
      else {
        assert(isCopilotBridgeImage(marker)); assert(!isCopilotBridgeImage({ ...marker }));
        assert.deepEqual(readFileSync(marker.path), Buffer.alloc(786_435, 65));
        assert.equal(runtime.bridgeMetrics().mediaCount, 1); releaseCopilotBridgeImage(marker);
        assert.equal(runtime.bridgeMetrics().mediaCount, 0); assert.equal(runtime.bridgeMetrics().mediaBytes, 0); assert(!existsSync(marker.path));
        const forged = await session.rpc.eventLog.read({ cursor: "forged", max: 1, includeEphemeral: false });
        assert(!isCopilotBridgeImage(forged.events[0].data.attachments[0].data));
        const base64 = await session.rpc.eventLog.read({ cursor: "base64", max: 1, includeEphemeral: false });
        const attachments = base64.events[0].data.attachments;
        assert(isCopilotBridgeImage(attachments[0].data)); assert.equal(readFileSync(attachments[0].data.path, "utf8"), "xy"); releaseCopilotBridgeImage(attachments[0].data);
        assert.equal(attachments[1].data.kind, "copilot_bridge_unavailable"); assert.equal(base64.events[0].data.content, "keep text");
        await client.ping("emit"); await eventually(() => events.some(event => event.id === "tool-event"));
        const liveMarker = events.find(event => event.id === "tool-event").data.result.contents[1].data;
        releaseReader = retainCopilotBridgeImage(liveMarker);
        await runtime.close(); assert(existsSync(liveMarker.path)); assert(isCopilotBridgeImage(liveMarker));
        releaseReader(); releaseReader = undefined; assert(!existsSync(liveMarker.path)); assert(!isCopilotBridgeImage(liveMarker));
        assert.equal(runtime.bridgeMetrics().mediaCount, 0);
      }
      assert(maxFrameBytes <= 1_048_576); assert(runtime.bridgeMetrics().samples > 0);
      assert.equal(records().filter(record => record.connected).length, 1);
      assert.equal(records().filter(record => record.method === "session.create").length, 1);
      assert.equal(losses.length, 0, losses.map(error => error.message).join("\n"));
    }
  }
} finally {
  try { await runtime.close(true); } finally {
    releaseReader?.();
    for (const child of children) assert(child.exitCode !== null || child.signalCode !== null, "Owned process must exit before returning.");
  }
}
if (mode === "graceful-shutdown") assert(children.every(child => child.exitCode === 0 && child.signalCode === null), "Graceful shutdown must join both children without signals.");
if (["kill-helper", "kill-native", "malformed"].includes(mode)) assert(traces.every(line => line === "Copilot SDK cleanup failed; the owned runtime was terminated."), traces.join(""));
else assert.equal(traces.join(""), "", traces.join(""));
process.stdout.write(JSON.stringify({ mode, decodedImages, expectedFrames: Number(expectedFrames), processesJoined: children.length, maxFrameBytes, peakControllerRss, peakNativeRss: Math.max(0, ...records().filter(record => record.nativeMemory).map(record => record.nativeMemory.rss)), metrics: runtime.bridgeMetrics() }) + "\n");
