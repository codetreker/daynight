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
const [homeDirectory, launchId] = process.argv.slice(2);
// Windows process.kill(SIGTERM) bypasses JS signal handlers. Deliver the same
// runtime cancellation callback through IPC so natural exit proves cleanup.
const stop = message => {
  if (message !== "stop") throw new Error("Unexpected Controller fixture command.");
  process.emit("SIGTERM", "SIGTERM");
};
process.once("message", stop);
try {
  await runController({ homeDirectory, launchId, provider: "codex" });
  process.stdout.write("controller-returned\n");
} finally {
  process.off("message", stop);
  process.disconnect();
}
