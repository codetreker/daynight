import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readWindowsJobSource } from "./lifecycle-store.js";
import { parseWindowsJobSource } from "./windows-job-evidence.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import type { ProcessProof } from "./process-proof.js";

/** A lost bootstrap reply is unknown: the original guardian must not be replayed. */
export const startWindowsJobGuardian = async (input: { ticket: ControllerLaunchTicket; journalPath: string; controller: ProcessProof }): Promise<void> => {
  if (process.platform !== "win32") throw new Error("Windows Job guardians require Windows.");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "NODE_OPTIONS") delete env[key];
  const log = await open(path.join(path.dirname(input.journalPath), `guardian-${input.ticket.launchId}.log`), "a", 0o600);
  let child: ReturnType<typeof spawn> | undefined;
  let failure: unknown, failed = false;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("./windows-job-guardian-child.js", import.meta.url))], {
      detached: true, windowsHide: true, cwd: path.dirname(input.journalPath), stdio: ["ignore", log.fd, log.fd, "ipc"], env,
    });
    const runningChild = child;
    // Keep an error listener after detachment; a late IPC error cannot terminate
    // the Controller or change the guardian's durable ownership.
    runningChild.on("error", () => {});
    const startup = new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(() => reject(new Error("Original Windows guardian startup is unconfirmed."))), 45_000);
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); runningChild.off("message", onMessage); runningChild.off("error", onError); runningChild.off("exit", onExit); action();
      };
      const onMessage = (value: unknown): void => finish(() => resolve(value));
      const onError = (error: Error): void => finish(() => reject(error));
      const onExit = (): void => finish(() => reject(new Error("Original Windows guardian exited before its startup was confirmed.")));
      runningChild.once("message", onMessage); runningChild.once("error", onError); runningChild.once("exit", onExit);
      try { runningChild.send(input, error => { if (error) finish(() => reject(error)); }); }
      catch (error) { finish(() => reject(error)); }
    });
    runningChild.unref();
    const message = await startup;
    if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("Windows guardian startup returned invalid evidence.");
    const result = message as { kind?: unknown; source?: unknown; message?: unknown };
    if (result.kind !== "ready") throw new Error(`Windows guardian startup failed: ${typeof result.message === "string" ? result.message : "unknown result"}`);
    const source = parseWindowsJobSource(result.source, input.ticket);
    const saved = readWindowsJobSource(input.journalPath, input.ticket);
    if (source.phase !== "assigned" || source.guardian.pid !== runningChild.pid || !isDeepStrictEqual(source.controller, input.controller) || !isDeepStrictEqual(saved, source)) throw new Error("Windows guardian startup conflicts with its original persisted source.");
  } catch (error) { failed = true; failure = error; }
  const cleanupFailures: unknown[] = [];
  try { if (child?.connected) child.disconnect(); } catch (error) { cleanupFailures.push(error); }
  try { await log.close(); } catch (error) { cleanupFailures.push(error); }
  if (cleanupFailures.length > 0) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, "Windows guardian startup or local cleanup failed.", failed ? { cause: failure } : undefined);
  if (failed) throw failure;
};
