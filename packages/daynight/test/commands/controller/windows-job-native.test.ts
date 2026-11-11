import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { captureProcessProof, inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { commitWindowsJobStop, openControllerLifecycleStore, readControllerSnapshot, readWindowsJobReceipt, readWindowsJobSource } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openWindowsGuardianJob, wakeWindowsJobGuardian } from "../../../src/commands/controller/windows-job-guardian.js";

test.skipIf(process.platform !== "win32")("queries and terminates the real guardian's original Job containing a leader and descendant", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/windows-guardian-native");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")), journalPath = path.join(home, "journal.sqlite");
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  openControllerLifecycleStore(journalPath, ticket).close();
  const proofUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/process-proof.js")).href;
  const script = `
    import { spawn } from "node:child_process";
    const { captureControllerProcessProof } = await import(${JSON.stringify(proofUrl)});
    const proof = await captureControllerProcessProof(${JSON.stringify(ticket.launchId)}, ${JSON.stringify({ ticket, journalPath })});
    const child = spawn(process.execPath, ["-e", 'process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    child.once("message", () => process.send({ proof, descendantPid: child.pid }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  const exited = once(child, "exit"); void exited.catch(() => {});
  let leader: ProcessProof | undefined, descendant: ProcessProof | undefined;
  let lease: Awaited<ReturnType<typeof openWindowsGuardianJob>> | undefined;
  try {
    const [ready] = await Promise.race([once(child, "message", { signal: AbortSignal.timeout(45_000) }), exited.then(() => { throw new Error("Controller exited before the original Job was ready."); })]) as [{ proof: ProcessProof; descendantPid: number }];
    leader = ready.proof; descendant = await captureProcessProof(ready.descendantPid);
    expect(descendant.parentPid).toBe(leader.pid);
    const journal = openControllerLifecycleStore(journalPath, ticket);
    journal.patchSnapshot({ controllerProcess: leader, nativeProcesses: [descendant], lifecycle: "working", nativeStopped: false }); journal.close();
    const source = readWindowsJobSource(journalPath, ticket);
    if (source?.phase !== "assigned") throw new Error("Original guardian source was not assigned.");
    lease = await openWindowsGuardianJob(source);
    expect(lease.inspect().members).toEqual(expect.arrayContaining([leader.pid, descendant.pid]));
    expect(await inspectProcessProof(leader)).toBe("running"); expect(await inspectProcessProof(descendant)).toBe("running");
    lease.terminate();
    await vi.waitFor(async () => { expect(await inspectProcessProof(leader!)).toBe("stopped"); expect(await inspectProcessProof(descendant!)).toBe("stopped"); expect(lease!.inspect().active).toBe(0); }, { timeout: 15_000, interval: 25 });
    expect(lease.sealAndObserveEmpty()).toMatchObject({ sealed: true, active: 0, members: [] });
    commitWindowsJobStop(journalPath, ticket, readControllerSnapshot(journalPath)!, source);
    const receipt = readWindowsJobReceipt(journalPath, ticket);
    if (!receipt) throw new Error("Original Job stop receipt was not committed.");
    lease.closeAfterCommit(receipt); lease = undefined;
    await wakeWindowsJobGuardian(ticket.launchId);
    await vi.waitFor(async () => expect(await inspectProcessProof(source.guardian)).toBe("stopped"), { timeout: 15_000, interval: 25 });
  } finally {
    const source = readWindowsJobSource(journalPath, ticket);
    if (lease) {
      const receipt = readWindowsJobReceipt(journalPath, ticket);
      if (receipt) lease.closeAfterCommit(receipt);
      else if (source && await inspectProcessProof(source.guardian) === "running") lease.close();
      else if (source?.phase === "assigned") {
        lease.terminate();
        await vi.waitFor(() => expect(lease!.inspect().active).toBe(0), { timeout: 15_000, interval: 25 });
        lease.sealAndObserveEmpty();
        commitWindowsJobStop(journalPath, ticket, readControllerSnapshot(journalPath)!, source);
        lease.closeAfterCommit(readWindowsJobReceipt(journalPath, ticket)!);
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (source && await inspectProcessProof(source.guardian) === "running") process.kill(source.guardian.pid, "SIGKILL");
    if (descendant && await inspectProcessProof(descendant) === "running") process.kill(descendant.pid, "SIGKILL");
    if (source) await vi.waitFor(async () => expect(await inspectProcessProof(source.guardian)).not.toBe("running"), { timeout: 15_000, interval: 25 });
    if (child.exitCode === null && child.signalCode === null) await Promise.race([exited, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Controller fixture did not exit.")), 15_000); timer.unref(); })]);
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);
