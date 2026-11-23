import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../../src/api/operation.js";
import * as processProof from "../../../../src/commands/controller/process-proof.js";
import * as suspendedChildren from "../../../../src/commands/worker/suspended-node-child.js";
import * as windowsJobs from "../../../../src/commands/worker/bots/windows-job-lease.js";
import { createBotCliProbe, type BotCliProbe } from "../../../../src/commands/worker/bots/cli-probe.js";
import { withOwnedCommandLifecycle } from "../../../../src/commands/worker/owned-command-lifecycle.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); });

it.each(["none", "binding", "assignment"] as const)("retains the suspended Windows guardian through admission and cleanup (failure: %s)", async failure => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const actions: string[] = [], bound = Promise.withResolvers<void>(), commit = Promise.withResolvers<void>();
  let connected = false, exited = false, jobStopped = false, assigned = false;
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(),
    connected: false, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    send: () => { actions.push("command"); child.emit("message", { type: "result", code: 0, signal: null, stdout: "help\n", stderr: "" }); },
    kill: vi.fn(() => { if (assigned && jobStopped) throw new Error("The original guardian was already terminated by its Job."); exited = true; child.emit("close"); return true; }),
  });
  Object.defineProperties(child, { connected: { get: () => connected }, exitCode: { get: () => exited ? 0 : null }, signalCode: { value: null } });
  const native = { child: child as suspendedChildren.GatedNodeChild,
    resume: vi.fn(() => { actions.push("resume"); connected = true; child.emit("message", { type: "ready" }); }),
    closeHandles: vi.fn(() => { actions.push("close-handles"); child.stdout.end(); child.stderr.end(); }),
  };
  vi.spyOn(suspendedChildren, "createSuspendedNodeChild").mockImplementation(async () => { actions.push("suspended"); return native; });
  vi.spyOn(processProof, "captureProcessProof").mockImplementation(async pid => {
    actions.push("capture"); return { pid, parentPid: process.pid, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64) };
  });
  vi.spyOn(windowsJobs, "createWindowsBotJobLease").mockImplementation(async launchId => ({ name: `Local\\Daynight-${launchId}`,
    assign: pid => { expect(pid).toBe(child.pid); actions.push("assign"); if (failure === "assignment") throw new Error("Job assignment refused"); assigned = true; }, inspect: () => jobStopped || !assigned ? [] : [child.pid],
    terminate: () => { actions.push("terminate"); jobStopped = true; if (assigned) queueMicrotask(() => { exited = true; child.emit("close"); }); }, close: () => { actions.push("close-job"); },
  }));
  const operation = createOperation();
  let probe: BotCliProbe | undefined, bindingFailed = false;
  const creating = withOwnedCommandLifecycle(async event => {
    actions.push(event.stage);
    if (event.stage === "bound") {
      bound.resolve(); await commit.promise;
      if (failure === "binding" && !bindingFailed) { bindingFailed = true; throw new Error("Binding persistence refused"); }
    }
  }, () => createBotCliProbe({ environment: process.env, cwd: process.cwd() }, operation));
  try {
    if (failure === "assignment") {
      await expect(creating).rejects.toThrow("Job assignment refused");
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(native.resume).not.toHaveBeenCalled();
      expect(actions).not.toContain("command");
      expect(native.closeHandles).toHaveBeenCalledOnce();
      return;
    }
    await bound.promise;
    expect(actions).toEqual(["prepared", "suspended", "capture", "assign", "bound"]);
    expect(native.resume).not.toHaveBeenCalled();
    commit.resolve();
    if (failure === "binding") {
      await expect(creating).rejects.toThrow("Binding persistence refused");
      expect(native.resume).not.toHaveBeenCalled();
      expect(actions).not.toContain("command");
      expect(child.kill).not.toHaveBeenCalled();
      expect(native.closeHandles).toHaveBeenCalledOnce();
      return;
    }
    probe = await creating;
    await probe.run("daynight", ["task", "--help"]); await probe.run("daynight", ["worker", "--help"]);
    await probe.close();
    expect(actions).toEqual(["prepared", "suspended", "capture", "assign", "bound", "resume", "command", "command", "terminate", "close-job", "close-handles", "stopped"]);
    expect(native.closeHandles).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  } finally { commit.resolve(); probe ??= await creating.catch(() => undefined); await probe?.close(); operation.dispose(); }
});
