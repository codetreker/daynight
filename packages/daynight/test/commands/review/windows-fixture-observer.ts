import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

type Role = "root" | "parent" | "leaf";
type Identity = { pid: number; parentPid: number; birth: string };
type Member = { role: Role; pid: number; birth: string; handle: unknown; lastLiveNs?: string; firstSignaledNs?: string; exitFileTime?: string };
const ticks = (): string => process.hrtime.bigint().toString();

/** Observes only this test's fixed tree. It is not a production tree inventory. */
export const createWindowsFixtureObserver = async (root: ChildProcess) => {
  if (process.platform !== "win32" || root.pid === undefined) throw new Error("A spawned Windows fixture is required.");
  const koffi = await import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const open = kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const times = kernel.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)");
  const terminate = kernel.func("int __stdcall TerminateProcess(void *process, uint32_t code)");
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const members: Member[] = [];
  const events: unknown[] = [];
  let probeError: unknown;
  let sampler: ReturnType<typeof setInterval> | undefined;
  let lastState = "";
  let maximumPollGapMs = 0;
  let previousPoll = performance.now();
  let liveAtStopReturn = false;
  let rootClosed = false;
  let declarations: Array<["parent" | "leaf", Identity]> = [];
  const fail = (stage: string) => new Error(`Windows fixture observer ${stage} failed (${lastError()}).`);
  const processTimes = (handle: unknown) => {
    const creation = Buffer.alloc(8), exit = Buffer.alloc(8);
    if (!times(handle, creation, exit, Buffer.alloc(8), Buffer.alloc(8))) throw fail("GetProcessTimes");
    return { birth: creation.readBigUInt64LE().toString(), exit: exit.readBigUInt64LE().toString() };
  };
  const state = (member: Member) => {
    const beforeNs = ticks();
    const result = wait(member.handle, 0) as number;
    const afterNs = ticks();
    if (result !== 0 && result !== 258) throw fail("WaitForSingleObject");
    if (result === 258) member.lastLiveNs = beforeNs;
    else if (member.firstSignaledNs === undefined) {
      member.firstSignaledNs = afterNs;
      member.exitFileTime = processTimes(member.handle).exit;
    }
    return { role: member.role, pid: member.pid, birth: member.birth, signaled: result === 0, beforeNs, afterNs,
      lastLiveNs: member.lastLiveNs, firstSignaledNs: member.firstSignaledNs, exitFileTime: member.exitFileTime };
  };
  const record = (stage: string, details?: unknown): void => {
    if (probeError !== undefined) return;
    try {
      const beforeNs = ticks(), utcMs = Date.now();
      const observed = members.map(state);
      if (stage === "stop-return") liveAtStopReturn = observed.some(member => !member.signaled);
      const signature = observed.map(member => `${member.role}:${member.signaled}`).join(";");
      if (stage !== "poll" || signature !== lastState) {
        if (events.length >= 64) throw new Error("Fixture observation event bound exceeded.");
        events.push({ stage, beforeNs, afterNs: ticks(), utcMs, details, members: observed });
      }
      lastState = signature;
    } catch (error) {
      probeError = error;
      if (sampler !== undefined) clearInterval(sampler);
      events.push({ stage, observerError: String(error), atNs: ticks() });
    }
  };
  const capture = (role: Role, pid: number, expectedBirth?: string): void => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) throw new Error("Invalid fixture PID.");
    // Termination rights are only acquired for fixture children with their own
    // creation identity. Root cleanup uses Node's original ChildProcess handle.
    const handle: unknown = open(0x00101000 | (expectedBirth === undefined ? 0 : 1), 0, pid);
    if (handle === null) throw fail("OpenProcess");
    let birth: string;
    try {
      const actual = processTimes(handle);
      if (expectedBirth !== undefined && actual.birth !== expectedBirth) throw new Error("Fixture PID creation identity changed before observation.");
      birth = actual.birth;
    } catch (error) {
      if (!close(handle)) throw new AggregateError([error, fail("CloseHandle(unaccepted identity)")], "Fixture identity acquisition and handle release failed.");
      throw error;
    }
    const member = { role, pid, birth, handle };
    members.push(member);
    if (state(member).signaled) throw new Error("Fixture exited before observation was established.");
  };
  const closeHandles = (): void => {
    const failures: Error[] = [];
    for (const member of members.splice(0)) if (!close(member.handle)) failures.push(fail(`CloseHandle(${member.role})`));
    if (failures.length) throw new AggregateError(failures, "Fixture observation handles could not be released.");
  };
  try {
    if (root.exitCode !== null || root.signalCode !== null) throw new Error("Fixture root already closed.");
    capture("root", root.pid);
    if (root.exitCode !== null || root.signalCode !== null) throw new Error("Fixture root closed while observation was established.");
  } catch (error) { closeHandles(); throw error; }
  const onRootClose = (code: number | null, signal: NodeJS.Signals | null): void => { rootClosed = true; record("root-close", { code, signal }); };
  root.once("close", onRootClose);
  record("root-handle-ready");
  return {
    record,
    attach(parent: Identity, leaf: Identity): void {
      if (parent.parentPid !== root.pid || leaf.parentPid !== parent.pid || new Set([root.pid, parent.pid, leaf.pid]).size !== 3 ||
        [parent, leaf].some(value => !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 0xffff_ffff || typeof value.birth !== "string" || !/^[1-9][0-9]*$/.test(value.birth))) throw new Error("Fixture declaration does not match the fixed root/parent/leaf chain.");
      declarations = [["parent", parent], ["leaf", leaf]];
      const failures: unknown[] = [];
      for (const [role, identity] of declarations) {
        try { capture(role, identity.pid, identity.birth); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Fixture observation identities could not all be acquired.");
      record("tree-handles-ready");
      if (probeError !== undefined) throw probeError;
      previousPoll = performance.now();
      sampler = setInterval(() => {
        const now = performance.now(); maximumPollGapMs = Math.max(maximumPollGapMs, now - previousPoll); previousPoll = now;
        record("poll");
      }, 5);
    },
    async finish(primaryError: unknown): Promise<void> {
      if (sampler !== undefined) clearInterval(sampler);
      const cleanupErrors: unknown[] = [];
      const attempt = (action: () => void): void => { try { action(); } catch (error) { cleanupErrors.push(error); } };
      try {
        record("cleanup-start");
        // A failed observation of one member must not suppress acquisition or
        // cleanup of another already-declared fixture identity.
        for (const [role, identity] of declarations) if (!members.some(member => member.role === role)) {
          attempt(() => capture(role, identity.pid, identity.birth));
        }
        for (const member of members) {
          if (member.role === "root") continue;
          attempt(() => {
            let signaled = false;
            try { signaled = state(member).signaled; } catch (error) { cleanupErrors.push(error); }
            if (!signaled && !terminate(member.handle, 1) && !state(member).signaled) throw fail(`TerminateProcess(${member.role})`);
          });
        }
        attempt(() => { if (root.exitCode === null && root.signalCode === null) root.kill("SIGKILL"); });
        const deadline = performance.now() + 3_000;
        const stopped = (): boolean => {
          let complete = rootClosed;
          for (const member of members) {
            try { if (!state(member).signaled) complete = false; }
            catch { complete = false; }
          }
          return complete;
        };
        while (!stopped() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        if (!stopped()) cleanupErrors.push(new Error("Owned fixture exits and root closure remain unconfirmed after cleanup."));
        if (members.length !== 3) cleanupErrors.push(new Error("Fixture identity inventory was incomplete; full cleanup is unconfirmed."));
        record(cleanupErrors.length ? "cleanup-unconfirmed" : "cleanup-complete");
      } catch (error) { cleanupErrors.push(error); }
      finally {
        root.removeListener("close", onRootClose);
        attempt(closeHandles);
        console.error("WINDOWS_REVIEW_STOP_DIAGNOSTIC " + JSON.stringify({ schemaVersion: 1, pollIntervalMs: 5,
          maximumPollGapMs, primaryError: primaryError === undefined ? null : String(primaryError),
          cleanupErrors: cleanupErrors.map(String), liveAtStopReturn, observerError: probeError === undefined ? null : String(probeError), events }));
      }
      const failures = [...cleanupErrors];
      if (probeError !== undefined) failures.push(probeError);
      if (liveAtStopReturn) failures.push(new Error("A held fixture process handle was not signaled when supervisor.stop returned."));
      if (failures.length) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], "Fixture observation or owned cleanup failed.");
    },
  };
};

export type WindowsFixtureObserver = Awaited<ReturnType<typeof createWindowsFixtureObserver>>;
