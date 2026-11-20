import crossSpawn from "cross-spawn";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { captureProcessProof } from "../controller/process-proof.js";

// Only this trusted launcher runs before the parent commits the boundary proof.
// It never interprets arguments or environment as shell text.
const launchId = process.argv[2];
if (launchId === undefined || !/^[0-9a-f-]{36}$/.test(launchId) || !process.send) process.exit(1);
const timer = setTimeout(() => process.exit(1), 20_000);
process.once("disconnect", () => process.exit(1));
try {
  const proof = await captureProcessProof(process.pid);
  process.send!({ kind: "bound", launchId, proof });
  process.once("message", (value: unknown) => {
    clearTimeout(timer);
    if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "run"
      || !("file" in value) || typeof value.file !== "string" || !("args" in value) || !Array.isArray(value.args)
      || !value.args.every(arg => typeof arg === "string") || !("environment" in value) || typeof value.environment !== "object" || value.environment === null
      || "input" in value && typeof value.input !== "string") process.exit(1);
    const request = value as { file: string; args: string[]; environment: NodeJS.ProcessEnv; input?: string };
    const child = crossSpawn(request.file, request.args, { env: request.environment, stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    // The launcher exits explicitly after its receipt. A non-ending pipeline to
    // stdout can resolve with writes still queued; retain each write callback.
    const forward = (target: NodeJS.WriteStream) => new Writable({
      write: (chunk: Buffer, encoding, callback) => { target.write(chunk, encoding, callback); },
    });
    const captures = [pipeline(child.stdout!, forward(process.stdout)), pipeline(child.stderr!, forward(process.stderr))];
    if (request.input !== undefined) captures.push(pipeline(Readable.from([request.input]), child.stdin!));
    const capture = Promise.all(captures).catch(() => { process.send?.({ kind: "io-error" }); });
    child.once("error", error => { process.send?.({ kind: "spawn-error", missing: "code" in error && error.code === "ENOENT" }); });
    child.once("close", async (code, signal) => {
      await capture;
      process.send?.({ kind: "result", code, signal }, () => process.exit(code === null ? 1 : code));
    });
  });
} catch { clearTimeout(timer); process.exit(1); }
