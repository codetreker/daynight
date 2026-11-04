import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openCopilotProvider } from "../../../../dist/commands/controller/providers/copilot.js";
import { startupFailure } from "../../../../dist/commands/controller/startup.js";

const [root, mode] = process.argv.slice(2), children = [];
const log = path.join(root, "requests.log");
try {
  const error = await openCopilotProvider({ cwd: root, model: null, args: [], resumeNativeSessionId: null,
    executable: fileURLToPath(new URL("copilot-startup.mjs", import.meta.url)),
    env: { ...process.env, DAYNIGHT_TEST_STARTUP_MODE: mode, DAYNIGHT_TEST_STARTUP_LOG: log },
    onTimeline() {}, onState() {}, onSpawn(child) { children.push(child); },
  }).then(async provider => { await provider.close(); throw new Error("Fixture unexpectedly initialized."); }, error => error);
  assert.deepEqual(startupFailure(error), mode === "reject" ? { state: "failed", reasonCode: "native_rejected" }
    : { state: "unknown", reasonCode: mode === "disconnect" ? "native_transport_unknown" : "native_timeout" });
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["connect", "skills.getDiscoveryPaths", "session.create"]);
  assert.equal(children.length, 1);
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  await setImmediate();
  process.stdout.write("Startup failure retained; transport disposed and owned process exit confirmed.\n");
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
