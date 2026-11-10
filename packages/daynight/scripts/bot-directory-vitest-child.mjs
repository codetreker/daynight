import { pathToFileURL } from "node:url";

// The parent assigns the diagnostic Job before releasing this gate. No test or
// Controller code can run outside that owned descendant boundary.
const timer = setTimeout(() => { throw new Error("Diagnostic Vitest assignment was not confirmed."); }, 30_000);
process.once("message", async message => {
  if (message !== "start") throw new Error("Unexpected diagnostic start message.");
  clearTimeout(timer);
  process.disconnect();
  const [entry, ...args] = process.argv.slice(2);
  if (entry === undefined) throw new Error("A Vitest entry is required.");
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
});
process.send("ready");
