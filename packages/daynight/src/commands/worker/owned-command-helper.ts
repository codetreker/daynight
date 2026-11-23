import crossSpawn from "cross-spawn";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { captureProcessProof } from "../controller/process-proof.js";
import { parseLinuxBoot, parseLinuxStat } from "../controller/linux-process-proof.js";
import { readFile } from "node:fs/promises";

// Only this trusted launcher runs before the parent commits the boundary proof.
// It never interprets arguments or environment as shell text.
const launchId = process.argv[2];
if (launchId === undefined || !/^[0-9a-f-]{36}$/.test(launchId) || !process.send) process.exit(1);
const timer = setTimeout(() => process.exit(1), 20_000);
let ownsGroup = false;
const abandon = () => {
  // This still-running group leader is its own original identity witness. If
  // its owner disappears, kill its complete boundary before losing that witness.
  if (ownsGroup) process.kill(-process.pid, "SIGKILL");
  else process.exit(1);
};
process.once("disconnect", abandon);
process.once("error", abandon);
if (process.platform !== "win32") process.on("SIGTERM", () => {});
const send = (message: object) => {
  try { process.send?.(message, error => { if (error != null) abandon(); }); }
  catch { abandon(); }
};
try {
  const proof = process.platform === "linux" ? await (async () => {
    const boot = parseLinuxBoot(await readFile("/proc/sys/kernel/random/boot_id", "utf8"));
    const stat = parseLinuxStat(process.pid, await readFile(`/proc/${process.pid}/stat`, "utf8"));
    if (stat.zombie || stat.exiting) throw new Error("Launcher is exiting.");
    return { pid: process.pid, parentPid: stat.parent, processGroupId: stat.group, startedAt: `linux:v1:${boot}:${stat.ticks}` };
  })() : await captureProcessProof(process.pid);
  ownsGroup = process.platform !== "win32" && proof.processGroupId === process.pid;
  if (process.platform !== "win32" && !ownsGroup) process.exit(1);
  send({ kind: "bound", launchId, proof });
  process.once("message", (value: unknown) => {
    clearTimeout(timer);
    if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "run"
      || !("file" in value) || typeof value.file !== "string" || !("args" in value) || !Array.isArray(value.args)
      || !value.args.every(arg => typeof arg === "string") || !("environment" in value) || typeof value.environment !== "object" || value.environment === null
      || "input" in value && typeof value.input !== "string") process.exit(1);
    const request = value as { file: string; args: string[]; environment: NodeJS.ProcessEnv; input?: string };
    const child = crossSpawn(request.file, request.args, { env: request.environment, stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    // Keep the original group witness even after the command exits or TERM kills
    // it. Only the owner can confirm all descendants and retire this guardian.
    if (ownsGroup) setInterval(() => {}, 60_000);
    // A non-ending pipeline to stdout can resolve with writes still queued;
    // retain each write callback before acknowledging the command's result.
    const forward = (target: NodeJS.WriteStream) => new Writable({
      write: (chunk: Buffer, encoding, callback) => { target.write(chunk, encoding, callback); },
    });
    const captures = [pipeline(child.stdout!, forward(process.stdout)), pipeline(child.stderr!, forward(process.stderr))];
    if (request.input !== undefined) captures.push(pipeline(Readable.from([request.input]), child.stdin!));
    const capture = Promise.all(captures).catch(() => { send({ kind: "io-error" }); });
    child.once("error", error => { send({ kind: "spawn-error", missing: "code" in error && error.code === "ENOENT" }); });
    child.once("close", async (code, signal) => {
      await capture;
      if (ownsGroup) send({ kind: "result", code, signal });
      else process.send?.({ kind: "result", code, signal }, () => process.exit(code === null ? 1 : code));
    });
  });
} catch { clearTimeout(timer); process.exit(1); }
