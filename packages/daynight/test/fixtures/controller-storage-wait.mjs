import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// The process proof executes the production TypeScript without a preceding
// build; Node needs the same relative extension bridge as our other fixtures.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(source)) return next(source.href, context);
  }
  return next(specifier, context);
} });

const { runController } = await import("../../src/commands/controller/runtime.ts");
const [homeDirectory, launchId, contention] = process.argv.slice(2);
const holdStorageRetry = () => {
  const write = process.stderr.write, schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  let captureNext = false, held, cleared = false;
  process.stderr.write = function (chunk, ...args) {
    const result = Reflect.apply(write, this, [chunk, ...args]);
    if (chunk === "Controller storage is busy; the original launch is waiting.\n") {
      assert(!captureNext && held === undefined, "Expected one storage retry before cancellation.");
      captureNext = true;
    }
    return result;
  };
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (!captureNext) return schedule(callback, milliseconds, ...args);
    captureNext = false;
    assert.equal(milliseconds, 100, "Storage retry after the busy diagnostic.");
    // Keep a real handle, but let only the Controller's abort path clear it.
    held = schedule(callback, 60_000, ...args);
    process.send({ kind: "storage-retry-held", milliseconds });
    return held;
  };
  globalThis.clearTimeout = handle => {
    if (held !== undefined && handle === held) cleared = true;
    return cancel(handle);
  };
  return {
    assertCleared: () => assert(held !== undefined && cleared, "Controller must clear its held storage retry on cancellation."),
    restore: () => {
      process.stderr.write = write; globalThis.setTimeout = schedule; globalThis.clearTimeout = cancel;
      if (held !== undefined) cancel(held);
    },
  };
};
const retry = contention === "ownership-gate" ? holdStorageRetry() : undefined;
// Windows process.kill(SIGTERM) bypasses JS signal handlers. Deliver the same
// runtime cancellation callback through IPC so natural exit proves cleanup.
const stop = message => {
  if (message !== "stop") throw new Error("Unexpected Controller fixture command.");
  process.emit("SIGTERM", "SIGTERM");
};
process.once("message", stop);
try {
  await runController({ homeDirectory, launchId, provider: "codex" });
  retry?.assertCleared();
  process.stdout.write("controller-returned\n");
} finally {
  retry?.restore();
  process.off("message", stop);
  process.disconnect();
}
