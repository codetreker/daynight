import crossSpawn from "cross-spawn";
import { captureControllerProcessProof } from "../controller/process-proof.js";

// Only this trusted launcher runs before the parent commits the boundary proof.
// It never interprets arguments or environment as shell text.
const launchId = process.argv[2];
if (launchId === undefined || !/^[0-9a-f-]{36}$/.test(launchId) || !process.send) process.exit(1);
const timer = setTimeout(() => process.exit(1), 20_000);
process.once("disconnect", () => process.exit(1));
try {
  const proof = await captureControllerProcessProof(launchId);
  process.send!({ kind: "bound", launchId, proof });
  process.once("message", (value: unknown) => {
    clearTimeout(timer);
    if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "run"
      || !("file" in value) || typeof value.file !== "string" || !("args" in value) || !Array.isArray(value.args)
      || !value.args.every(arg => typeof arg === "string") || !("environment" in value) || typeof value.environment !== "object" || value.environment === null) process.exit(1);
    const request = value as { file: string; args: string[]; environment: NodeJS.ProcessEnv };
    const child = crossSpawn(request.file, request.args, { env: request.environment, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", () => { process.send?.({ kind: "spawn-error" }); process.exit(1); });
    child.once("close", (code, signal) => {
      process.send?.({ kind: "result", code, signal }, () => process.exit(code === null ? 1 : code));
    });
  });
} catch { clearTimeout(timer); process.exit(1); }
