import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { captureProcessProof, confirmControllerProcessesStopped, stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { createControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { createSuspendedProcess, type WindowsSuspendedProcess } from "../../../src/platform/windows-suspended-process.js";

test("keeps the original Controller process behind its birth gate and preserves its identity and log after dispatch", async () => {
  const base = path.resolve("../../.tmp/controller-bootstrap"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")), marker = path.join(root, "started.json"), logFile = path.join(root, "controller.log"), target = path.join(root, "controller.mjs");
  const launchId = randomUUID(), log = await open(logFile, "a", 0o600);
  const bootstrap = path.resolve("dist/commands/worker/backends/controller-bootstrap.js");
  const proofModule = pathToFileURL(path.resolve("dist/commands/controller/process-proof.js")).href;
  await writeFile(target, `import {writeFileSync} from 'node:fs'; import {captureControllerProcessProof} from ${JSON.stringify(proofModule)};
const proof=await captureControllerProcessProof(${JSON.stringify(launchId)});
console.log('Controller output 完整');console.error('Controller diagnostics');
writeFileSync(${JSON.stringify(marker)},JSON.stringify({proof,args:process.argv.slice(2)}));setInterval(()=>{},1000);`);
  let child: ChildProcess | undefined, suspended: WindowsSuspendedProcess | undefined, lease: ControllerJobLease | undefined, proof: ProcessProof | undefined;
  try {
    const args = [bootstrap, target, "codex", launchId, logFile];
    if (process.platform === "win32") {
      suspended = await createSuspendedProcess({ file: process.execPath, args, cwd: root, environment: { ...process.env, DAYNIGHT_CONTROLLER_ASSIGNED_JOB: launchId } });
      proof = { ...await captureProcessProof(suspended.pid), jobObjectName: `Local\\Daynight-${launchId}` };
      lease = await createControllerJobLease(launchId, proof, Date.now() + 15_000);
    } else {
      child = spawn(process.execPath, args, { cwd: root, env: process.env, detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"] });
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
      expect(ready).toEqual({ kind: "waiting", launchId });
      proof = await captureProcessProof(child.pid!);
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    if (suspended !== undefined) suspended.resume(); else child!.send({ launchId });
    await expect.poll(async () => JSON.parse(await readFile(marker, "utf8")), { timeout: 15_000 }).toEqual({ proof, args: ["controller", "codex", "--launch-id", launchId] });
    expect(await readFile(logFile, "utf8")).toBe("Controller output 完整\nController diagnostics\n");
    expect(await captureProcessProof(proof.pid)).toEqual(expect.objectContaining({ pid: proof.pid, startedAt: proof.startedAt, commandHash: proof.commandHash, processGroupId: proof.processGroupId }));
  } finally {
    const deadline = Date.now() + 15_000;
    if (proof !== undefined && (suspended === undefined || lease !== undefined)) {
      await stopControllerProcesses(proof, [], deadline, lease);
      expect(await confirmControllerProcessesStopped(proof, [], deadline, lease)).toBe(true);
    } else if (suspended !== undefined) suspended.terminate(); else child?.kill("SIGKILL");
    if (suspended !== undefined) {
      while (!suspended.hasExited() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      suspended.close();
    }
    if (lease !== undefined) releaseControllerJobLease(lease);
    await log.close(); await rm(root, { recursive: true, force: true });
  }
}, 40_000);
