import { openSync, writeSync } from "node:fs";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

// POSIX executes only this trusted gate before the parent's durable birth record.
// Windows starts this same bootstrap with its primary thread suspended.
const [target, provider, markerOrLaunchId, idOrLog, newLog] = process.argv.slice(2);
const explicit = markerOrLaunchId === "--launch-id";
const launchId = explicit ? idOrLog : markerOrLaunchId;
const logFile = explicit ? newLog : idOrLog;
if (!target || !provider || !launchId || !logFile) process.exit(1);
if (process.platform !== "win32") {
  if (!process.connected) process.exit(1);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Controller launch gate expired.")), 30_000);
    const disconnected = () => { clearTimeout(timer); reject(new Error("Controller launch owner disconnected.")); };
    process.once("disconnect", disconnected);
    process.once("message", (value: unknown) => {
      clearTimeout(timer); process.off("disconnect", disconnected);
      if (typeof value !== "object" || value === null || !("launchId" in value) || value.launchId !== launchId) reject(new Error("Controller launch gate identity conflict."));
      else resolve();
    });
    process.send?.({ kind: "waiting", launchId });
  });
  process.disconnect?.();
} else {
  const fd = openSync(logFile, "a", 0o600);
  // CreateProcessW does not inherit the parent's descriptors. Keep Controller
  // output in its original execution log after the Worker releases its handles.
  for (const name of ["stdout", "stderr"]) Object.defineProperty(process, name, { configurable: true, value: new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try { writeSync(fd, chunk); callback(); } catch (error) { callback(error as Error); }
    },
  }) });
}
process.argv = [process.execPath, target, "controller", provider, "--launch-id", launchId];
await import(pathToFileURL(target).href);
