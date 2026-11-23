import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import timers from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";

if (path.basename(process.argv[1] ?? "") === "copilot-bridge-worker.js") {
  const observer = new URL("../../../../dist/commands/controller/providers/copilot-route-observation.js", import.meta.url);
  const parentURL = pathToFileURL(realpathSync(fileURLToPath(observer))).href;
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === "node:timers" && context.parentURL === parentURL) return { url: import.meta.url, shortCircuit: true };
    return next(specifier, context);
  } });
}

export default {
  setTimeout(callback, milliseconds) {
    assert.equal(milliseconds, 5000);
    const root = process.env.DAYNIGHT_TEST_ROUTE_CLOCK_ROOT;
    writeFileSync(path.join(root, "route-clock-armed-5000"), "", { flag: "wx" });
    const release = path.join(root, "route-clock-release");
    const timer = timers.setInterval(() => {
      if (!existsSync(release)) return;
      timers.clearInterval(timer);
      callback();
    }, 10);
    return timer;
  },
  clearTimeout: timers.clearInterval,
};
