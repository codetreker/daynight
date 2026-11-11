import { spawn, type ChildProcess } from "node:child_process";
import { createOperation, type Operation } from "../../api/operation.js";
import { withinOperation } from "../../platform/tool-io.js";
import { readToolRuntimeText } from "../../platform/tool-runtime-io.js";
import { captureProcessProof, confirmControllerProcessesStopped, stopControllerProcesses, type ProcessProof } from "../controller/process-proof.js";
import { toolExtractionChildSource } from "./tool-extraction-child.js";

export async function readExtractionProof(file: string, preparationId: string): Promise<ProcessProof | undefined> {
  const operation = createOperation({ limits: { totalMs: 5000 } });
  let content: string;
  try { content = await readToolRuntimeText(file, operation, { limit: 4096, private: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  finally { operation.dispose(); }
  const row = JSON.parse(content) as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "preparationId,proof,schemaVersion" || row.schemaVersion !== 1 || row.preparationId !== preparationId) throw new Error("Invalid extraction identity.");
  const proof = row.proof as ProcessProof;
  if (!proof || Object.keys(proof).sort().join() !== "commandHash,parentPid,pid,processGroupId,startedAt" || !Number.isSafeInteger(proof.pid) || proof.pid < 1
    || !Number.isSafeInteger(proof.parentPid) || proof.parentPid < 1 || proof.processGroupId !== proof.pid
    || typeof proof.startedAt !== "string" || !proof.startedAt || proof.startedAt.length > 128 || !/^[a-f0-9]{64}$/.test(proof.commandHash)) throw new Error("Invalid extraction process proof.");
  return proof;
}
export async function stopExtraction(proof: ProcessProof): Promise<void> {
  await stopControllerProcesses(proof, [], Date.now() + 10_000);
  if (!await confirmControllerProcessesStopped(proof, [])) throw new Error("Extraction process cleanup is unconfirmed.");
}

/** No native command crosses the gate before the owner confirms durable proof. */
export async function runToolExtraction(input: {
  node: string; cwd: string; proofPath: string; preparationId: string;
  file: string; args: string[]; environment: NodeJS.ProcessEnv;
  commit(proof: ProcessProof): Promise<void>;
}, operation: Operation): Promise<void> {
  let child: ChildProcess | undefined, proof: ProcessProof | undefined, closed = false, committed = false;
  let pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let fatal: Error | undefined;
  const fail = (error = new Error("Extraction helper stopped before acknowledgement.")) => { fatal = error; pending?.reject(error); };
  const message = (timeoutMs: number) => new Promise<unknown>((resolve, reject) => {
    if (fatal) { reject(fatal); return; }
    const timer = setTimeout(() => finish(() => reject(new Error("Extraction deadline elapsed."))), timeoutMs);
    const abort = () => finish(() => reject(new Error("Extraction cancelled.")));
    const finish = (action: () => void) => { clearTimeout(timer); operation.signal.removeEventListener("abort", abort); pending = undefined; action(); };
    pending = { resolve: value => finish(() => resolve(value)), reject: error => finish(() => reject(error)) };
    operation.signal.addEventListener("abort", abort, { once: true }); if (operation.signal.aborted) abort();
  });
  try {
    const ready = message(Math.min(10_000, operation.remainingMs())); void ready.catch(() => {});
    const environment = { ...input.environment };
    delete environment.NODE_OPTIONS; delete environment.NODE_COMPILE_CACHE; environment.NODE_DISABLE_COMPILE_CACHE = "1";
    child = spawn(input.node, ["-e", toolExtractionChildSource, input.proofPath, input.preparationId], { cwd: input.cwd, env: environment, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.on("message", value => pending?.resolve(value)); child.once("error", fail); child.once("close", () => { closed = true; fail(); });
    if ((await ready as { type?: string })?.type !== "ready" || !child.pid) throw new Error("Extraction helper is not ready.");
    proof = await withinOperation(readExtractionProof(input.proofPath, input.preparationId), operation);
    if (!proof || proof.pid !== child.pid || proof.parentPid !== process.pid || JSON.stringify(await captureProcessProof(child.pid)) !== JSON.stringify(proof)) throw new Error("Extraction helper proof mismatch.");
    await input.commit(proof); operation.check();
    if (closed || !child.connected) throw new Error("Extraction helper disconnected before commit.");
    const result = message(Math.min(20_000, operation.remainingMs())); void result.catch(() => {});
    committed = true;
    child.send({ type: "commit", preparationId: input.preparationId, file: input.file, args: input.args, environment: input.environment }, error => { if (error) fail(error); });
    const value = await result as { type?: string; ok?: boolean };
    if (value?.type !== "result" || value.ok !== true) throw new Error("Copilot extraction failed.");
  } finally {
    // Cleanup is separately bounded and still runs after operation cancellation.
    if (proof) await stopExtraction(proof);
    else if (child?.pid && !closed) child.kill("SIGKILL");
    if (child && !closed) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Extraction helper cleanup is unconfirmed (${committed ? "committed" : "uncommitted"}).`)), 10_000);
        child!.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}
