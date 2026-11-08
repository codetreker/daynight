import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openCopilotProvider } from "../../../../dist/commands/controller/providers/copilot.js";
import { startupFailure } from "../../../../dist/commands/controller/startup.js";
import { captureStartupDeadline, stopStartupChildren } from "../../../helpers/startup-deadline.ts";

const [root, mode] = process.argv.slice(2), children = [];
const log = path.join(root, "requests.log");
const deadline = mode === "timeout" || mode === "socket-close" ? captureStartupDeadline() : undefined;
const connect = Socket.prototype.connect, sockets = [];
const observeConnect = function (...args) {
  const socket = this, receipt = { socket, closed: false, address: undefined };
  socket.once("connect", () => { receipt.address = { host: socket.remoteAddress, port: socket.remotePort }; });
  const closed = new Promise(resolve => socket.once("close", resolve));
  void closed.then(() => { receipt.closed = true; });
  sockets.push(receipt);
  return Reflect.apply(connect, socket, args);
};
if (mode === "socket-close") Socket.prototype.connect = observeConnect;
let nativeOutput = "", nativePort, openingSettled = false;
let opening;
try {
  opening = openCopilotProvider({ cwd: root, model: null, args: [], resumeNativeSessionId: null,
    executable: fileURLToPath(new URL("copilot-startup.mjs", import.meta.url)),
    env: { ...process.env, DAYNIGHT_TEST_STARTUP_MODE: mode, DAYNIGHT_TEST_STARTUP_LOG: log },
    onTimeline() {}, onState() {}, onSpawn(child) {
      children.push(child);
      if (mode === "socket-close") child.stdout.on("data", chunk => {
        nativeOutput += String(chunk);
        const port = /listening on port (\d+)[ \t]*\r?\n/i.exec(nativeOutput)?.[1];
        if (port !== undefined) nativePort = Number(port);
      });
    },
  }).then(async provider => { await provider.close(); throw new Error("Fixture unexpectedly initialized."); }, error => error);
  void opening.finally(() => { openingSettled = true; }).catch(() => {});
  if (deadline) await deadline.expireAfterRequest(log, requests => {
    if (!requests.includes("session.create")) return false;
    if (mode !== "socket-close") return true;
    assert.equal(sockets.length, 1, "Expected one SDK client connection to the native fixture.");
    const receipt = sockets[0];
    // The client close handlers must finish before cleanup encounters the closed transport.
    if (!receipt.closed) return false;
    assert.deepEqual(receipt.address, { host: "127.0.0.1", port: nativePort });
    assert.equal(receipt.socket.readableEnded, true);
    assert.equal(receipt.socket.destroyed, true);
    assert.equal(openingSettled, false);
    assert.equal(children.length, 1);
    assert.equal(children[0].exitCode, null);
    assert.equal(children[0].signalCode, null);
    return true;
  });
  const error = await opening;
  assert.deepEqual(startupFailure(error), mode === "reject" ? { state: "failed", reasonCode: "native_rejected" }
    : { state: "unknown", reasonCode: mode === "disconnect" ? "native_transport_unknown" : "native_timeout" });
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["connect", "skills.getDiscoveryPaths", "session.create"]);
  assert.equal(children.length, 1);
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  await setImmediate();
  process.stdout.write("Startup failure retained; transport disposed and owned process exit confirmed.\n");
} finally {
  try { await stopStartupChildren(children); await opening?.catch(() => {}); }
  finally {
    try { deadline?.restore(); }
    finally {
      if (mode === "socket-close") {
        const currentConnect = Socket.prototype.connect;
        Socket.prototype.connect = connect;
        assert.equal(currentConnect, observeConnect);
      }
    }
  }
}
