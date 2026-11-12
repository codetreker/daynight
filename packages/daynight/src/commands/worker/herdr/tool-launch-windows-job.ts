import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Operation } from "../../../api/operation.js";
import { loadWindowsJobKernel, type WindowsNamedJobKernel, type WindowsJobProcess } from "../../../platform/windows-job.js";
import { sameResourceOwner } from "../resource-owner.js";
import { optionalOwnedJson, publishOwnedJson, type HerdrToolLaunchManifest, type HerdrToolLaunchReceipt } from "./tool-launch-protocol.js";
import type { MappingProcessProof } from "./tool-launch-process-proof.js";

type Boundary = { schemaVersion: 1; nonce: string; owner: HerdrToolLaunchManifest["owner"]; selectionKey: string; helperPid: number; helperParentPid: number; helperBirth: string; policy: "kill-on-close" };
type Member = WindowsJobProcess & { handle: unknown; proven: boolean };
type Observer = { check(): void; captureForeground(pids: readonly number[], operation: Operation): void; closedMember(pid: number): boolean; stop(operation: Operation): Promise<void>; stopped(): boolean; release(): void };
let kernel: Promise<WindowsNamedJobKernel> | undefined;
const observers = new Map<string, { boundary: string; observer: Observer }>();
type PendingBinding = { boundary: string; api: WindowsNamedJobKernel; job?: unknown; helper?: unknown; cause: unknown };
const pendingBindings = new Map<string, PendingBinding>();
const releasePendingBinding = (registryKey: string, boundary?: string): void => {
  const pending = pendingBindings.get(registryKey);
  if (pending === undefined) return;
  if (boundary !== undefined && pending.boundary !== boundary) throw new Error("The original Herdr Job pending boundary changed; ownership remains unknown.");
  const failures: unknown[] = [];
  if ("job" in pending) try { pending.api.close(pending.job); delete pending.job; } catch (error) { failures.push(error); }
  if ("helper" in pending) try { pending.api.closeProcess(pending.helper); delete pending.helper; } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError([pending.cause, ...failures], "The original Herdr Job binding handle release remains unknown; its original handles were retained.", { cause: pending.cause });
  pendingBindings.delete(registryKey);
};
const boundaryFile = (manifestPath: string): string => path.join(path.dirname(manifestPath), "windows-job.json");
const name = (manifest: HerdrToolLaunchManifest): string => `Local\\Daynight-${manifest.nonce}`;
const key = (manifestPath: string, manifest: HerdrToolLaunchManifest): string => JSON.stringify([path.resolve(manifestPath), manifest.owner, manifest.nonce, manifest.launch.selectionKey]);
const birth = (value: bigint): string => {
  const ticks = value / 10n * 10n - 116444736000000000n;
  if (ticks < 0n || ticks > 2534023007999999990n) throw new Error("Invalid original Herdr helper creation time.");
  return `${new Date(Number(ticks / 10000000n) * 1000).toISOString().slice(0, 19)}.${(ticks % 10000000n).toString().padStart(7, "0")}Z`;
};
const readBoundary = async (manifestPath: string, manifest: HerdrToolLaunchManifest, helperPid: number): Promise<Boundary> => {
  const value = await optionalOwnedJson(boundaryFile(manifestPath));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("The original Windows Herdr Job has no kill-on-close boundary; ownership remains unknown.");
  const row = value as Boundary;
  if (Object.keys(row).sort().join() !== "helperBirth,helperParentPid,helperPid,nonce,owner,policy,schemaVersion,selectionKey" || row.schemaVersion !== 1 || row.nonce !== manifest.nonce || !sameResourceOwner(row.owner, manifest.owner) || row.selectionKey !== manifest.launch.selectionKey || row.helperPid !== helperPid || !Number.isSafeInteger(row.helperParentPid) || row.helperParentPid < 0 || typeof row.helperBirth !== "string" || !/^[1-9][0-9]{0,19}$/.test(row.helperBirth) || row.policy !== "kill-on-close") throw new Error("The original Windows Herdr Job boundary conflicts with its launch; ownership remains unknown.");
  birth(BigInt(row.helperBirth));
  return row;
};

/** This handle belongs to the helper's OS lifetime. Closing a self-member Job
 * in a JS finally/exit handler would terminate the helper before its native code
 * reaches ExitProcess. OS teardown releases it after selecting that exit code.
 */
export const establishCurrentHerdrHelperJob = async (manifestPath: string, manifest: HerdrToolLaunchManifest, operation: Operation, supplied?: WindowsNamedJobKernel): Promise<void> => {
  operation.check();
  const api = await (supplied ?? (kernel ??= loadWindowsJobKernel()));
  operation.check();
  const processHandle = api.open(process.pid);
  if (processHandle === null) throw new Error("The original Herdr helper process cannot be held.");
  let job: unknown, assignmentAttempted = false, failure: unknown, failed = false;
  try {
    const identity = api.identity(processHandle);
    if (identity.pid !== process.pid || api.signaled(processHandle)) throw new Error("The original Herdr helper identity is unavailable.");
    operation.check(); job = api.create(name(manifest));
    operation.check(); api.killOnClose(job);
    operation.check(); assignmentAttempted = true; api.assignHandle(job, processHandle);
    operation.check();
    if (!api.contains(job, processHandle)) throw new Error("The original Herdr helper Job membership is unconfirmed.");
    const boundary: Boundary = { schemaVersion: 1, nonce: manifest.nonce, owner: manifest.owner, selectionKey: manifest.launch.selectionKey, helperPid: identity.pid, helperParentPid: identity.parentPid, helperBirth: identity.birth.toString(), policy: "kill-on-close" };
    await publishOwnedJson(boundaryFile(manifestPath), boundary);
    operation.check();
  } catch (error) { failed = true; failure = error; }
  const failures: unknown[] = failed ? [failure] : [];
  try { api.closeProcess(processHandle); } catch (error) { failures.push(error); }
  // An assignment error can occur after assignment succeeds. Never close a Job
  // that may contain this helper; the helper's outer failure path exits instead.
  if (job !== undefined && !assignmentAttempted) try { api.close(job); } catch (error) { failures.push(error); }
  if (failures.length > 1) throw new AggregateError(failures, "Original Herdr helper Job setup failed.", { cause: failure });
  if (failures.length === 1) throw failures[0];
};

export const retainHerdrJobObserver = async (manifestPath: string, manifest: HerdrToolLaunchManifest, receipt: Pick<HerdrToolLaunchReceipt, "helperPid">, operation: Operation, proof?: MappingProcessProof, supplied?: WindowsNamedJobKernel): Promise<Observer> => {
  operation.check();
  const boundary = await readBoundary(manifestPath, manifest, receipt.helperPid), encoded = JSON.stringify(boundary), registryKey = key(manifestPath, manifest);
  if (proof !== undefined && (proof.pid !== boundary.helperPid || proof.parentPid !== boundary.helperParentPid || proof.startedAt !== birth(BigInt(boundary.helperBirth)))) throw new Error("The original Herdr helper birth differs from its Job boundary; ownership remains unknown.");
  releasePendingBinding(registryKey, encoded);
  const previous = observers.get(registryKey);
  if (previous !== undefined) {
    if (previous.boundary !== encoded) throw new Error("The original Herdr Job observer boundary changed; ownership remains unknown.");
    return previous.observer;
  }
  const api = await (supplied ?? (kernel ??= loadWindowsJobKernel()));
  operation.check();
  releasePendingBinding(registryKey, encoded);
  const concurrent = observers.get(registryKey);
  if (concurrent !== undefined) {
    if (concurrent.boundary !== encoded) throw new Error("The original Herdr Job observer boundary changed; ownership remains unknown.");
    return concurrent.observer;
  }
  // Hold the original process before adding a second Job lease. A helper may
  // exit between these calls; its held identity and membership still bind the
  // same Job, and the monitor must finish that original instance's cleanup.
  const helperHandle = api.open(boundary.helperPid);
  if (helperHandle === null) throw new Error("The original Herdr helper process cannot bind its Job observer; ownership remains unknown.");
  let job: unknown;
  let helper: Member;
  try {
    const identity = api.identity(helperHandle);
    if (identity.pid !== boundary.helperPid || identity.parentPid !== boundary.helperParentPid || identity.birth.toString() !== boundary.helperBirth) throw new Error("The original Herdr helper instance cannot bind its Job observer.");
    helper = { ...identity, handle: helperHandle, proven: true };
    operation.check();
    job = api.openNamed(name(manifest));
    if (job === null) throw new Error("The original Herdr Job name is missing; complete process closure remains unknown.");
    if (!api.contains(job, helperHandle)) throw new Error("The named Job does not contain the original Herdr helper instance.");
  } catch (cause) {
    // These handles have no proven common ownership. Closing only the extra
    // lease restores helper last-close behavior; never terminate this Job.
    pendingBindings.set(registryKey, { boundary: encoded, api, ...(job === undefined || job === null ? {} : { job }), helper: helperHandle, cause });
    releasePendingBinding(registryKey, encoded);
    throw cause;
  }
  const members: Member[] = [helper];
  let fault: unknown, faulted = false, timer: ReturnType<typeof setInterval> | undefined, released = false, terminating = false;
  const capture = (pid: number): Member | null => {
    let member = members.find(value => value.pid === pid && !api.signaled(value.handle));
    if (member?.proven) return member;
    if (member === undefined) {
      if (members.length >= 1000) throw new Error("The original Herdr Job exceeds its process ownership bound.");
      const handle = api.open(pid);
      if (handle === null) return null;
      member = { pid, parentPid: 0, birth: 0n, handle, proven: false };
      members.push(member);
    }
    Object.assign(member, api.identity(member.handle));
    if (member.pid !== pid || !api.contains(job, member.handle)) { api.closeProcess(member.handle); members.splice(members.indexOf(member), 1); return null; }
    member.proven = true;
    return member;
  };
  const captureMembers = (check: () => void): void => {
    for (const pid of api.inspect(job)) {
      check();
      capture(pid);
    }
  };
  const stopMonitoring = () => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
  const rememberFault = (error: unknown): void => {
    fault = faulted ? new AggregateError([fault, error], "The original Herdr Job observation has unresolved failures.", { cause: fault }) : error;
    faulted = true;
  };
  const observer: Observer = {
    check: () => { if (released) throw new Error("The original Herdr Job observer has been released."); if (faulted) throw new Error("The original Herdr Job observation failed; process ownership remains unknown.", { cause: fault }); },
    captureForeground: (pids, active) => { for (const pid of pids) { active.check(); capture(pid); } },
    closedMember: pid => {
      const original = members.find(member => member.proven && member.pid === pid && api.signaled(member.handle));
      if (original === undefined) return false;
      const current = api.open(pid);
      if (current === null) return true;
      try {
        const identity = api.identity(current);
        return identity.pid === original.pid && identity.parentPid === original.parentPid && identity.birth === original.birth && api.signaled(current);
      } finally { api.closeProcess(current); }
    },
    stopped: () => { observer.check(); return api.active(job) === 0 && members.every(member => api.signaled(member.handle)); },
    stop: async active => {
      active.check();
      if (released) throw new Error("The original Herdr Job observer has been released; termination remains unknown.");
      const failures: unknown[] = [];
      try { captureMembers(() => active.check()); } catch (error) { failures.push(error); }
      try { api.terminate(job); terminating = true; stopMonitoring(); } catch (error) { failures.push(error); }
      try {
        while (api.active(job) !== 0 || members.some(member => !api.signaled(member.handle))) {
          active.check(); await delay(Math.max(1, Math.min(25, active.remainingMs())), undefined, { signal: active.signal });
        }
      } catch (error) { failures.push(error); }
      if (failures.length) { if (!faulted) fault = failures[0]; faulted = true; throw new AggregateError(failures, "The original Herdr Job termination remains unknown; its handles were retained.", { cause: fault }); }
      fault = undefined; faulted = false;
    },
    release: () => {
      if (!observer.stopped()) throw new Error("Cannot release the original Herdr Job before complete process closure.");
      stopMonitoring();
      for (const member of [...members]) { api.closeProcess(member.handle); members.splice(members.indexOf(member), 1); }
      api.close(job); released = true; observers.delete(registryKey);
    },
  };
  // The original helper identity and Job membership are already bound. Keep
  // their handles across later observation failures for explicit cleanup.
  observers.set(registryKey, { boundary: encoded, observer });
  try {
    timer = setInterval(() => {
      try {
        if (terminating || !api.signaled(helper.handle)) return;
        const deadline = performance.now() + 1000;
        const failures: unknown[] = [];
        try { captureMembers(() => { if (performance.now() >= deadline) throw new Error("The original Herdr Job observation deadline elapsed."); }); }
        catch (error) { failures.push(error); }
        try { api.terminate(job); terminating = true; } catch (error) { failures.push(error); }
        stopMonitoring();
        if (failures.length) rememberFault(failures.length === 1 ? failures[0] : new AggregateError(failures, "Original Herdr helper exit cleanup remains unknown.", { cause: failures[0] }));
      } catch (error) { rememberFault(error); stopMonitoring(); }
    }, 100);
    timer.unref();
    captureMembers(() => operation.check());
  } catch (error) { rememberFault(error); throw new Error("The original Herdr Job observer could not bind; its handles were retained.", { cause: error }); }
  return observer;
};

export const releaseHerdrJobObserver = (manifestPath: string, manifest: HerdrToolLaunchManifest): void => {
  const registryKey = key(manifestPath, manifest);
  releasePendingBinding(registryKey);
  observers.get(registryKey)?.observer.release();
};
