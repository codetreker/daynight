import { performance } from "node:perf_hooks";
import { verifyWindowsJobMember } from "./windows-process-proof.js";
import type { ProcessProof } from "./process-proof.js";

export class WindowsControllerJobError extends Error {
  constructor(readonly stage: string, readonly win32Code: number) {
    super(`Windows controller Job Object ${stage} failed (Win32 ${win32Code}).`);
    this.name = "WindowsControllerJobError";
  }
}

type JobKernel = {
  readonly pointerSize: number;
  create(name: string): { handle: unknown; alreadyExists: boolean };
  open(name: string, stop: boolean): unknown | null;
  openProcess(pid: number): unknown;
  assign(job: unknown, process: unknown): void;
  query(job: unknown, data: Buffer): void;
  contains(job: unknown, process: unknown): boolean;
  terminate(job: unknown): void;
  close(handle: unknown, stage: string): void;
};

let kernel: Promise<JobKernel> | undefined;
const loadKernel = async (): Promise<JobKernel> => {
  const koffi = await import("koffi");
  const library = koffi.load("kernel32.dll");
  const create = library.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
  const open = library.func("void * __stdcall OpenJobObjectW(uint32_t access, int inherit, str16 name)");
  const openProcess = library.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const assign = library.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
  const query = library.func("int __stdcall QueryInformationJobObject(void *job, int kind, void *data, uint32_t size, void *returned)");
  const contains = library.func("int __stdcall IsProcessInJob(void *process, void *job, void *result)");
  const terminate = library.func("int __stdcall TerminateJobObject(void *job, uint32_t code)");
  const close = library.func("int __stdcall CloseHandle(void *handle)");
  const lastError = library.func("uint32_t __stdcall GetLastError()");
  const setLastError = library.func("void __stdcall SetLastError(uint32_t code)");
  const failure = (stage: string) => new WindowsControllerJobError(stage, lastError() as number);
  return {
    pointerSize: koffi.sizeof("uintptr_t"),
    create: name => {
      setLastError(0);
      const handle: unknown = create(null, name), code = lastError() as number;
      if (handle === null) throw new WindowsControllerJobError("create", code);
      return { handle, alreadyExists: code === 183 };
    },
    open: (name, stop) => {
      const handle: unknown = open(stop ? 12 : 4, 0, name);
      if (handle !== null) return handle;
      const code = lastError() as number;
      throw new WindowsControllerJobError("open", code);
    },
    openProcess: pid => {
      const handle: unknown = openProcess(0x101, 0, pid);
      if (handle === null) throw failure("open-process");
      return handle;
    },
    assign: (job, process) => { if (assign(job, process) === 0) throw failure("assign-process"); },
    query: (job, data) => { if (query(job, 3, data, data.length, null) === 0) throw failure("query-members"); },
    contains: (job, process) => { const result = Buffer.alloc(4); if (contains(process, job, result) === 0) throw failure("verify-membership"); return result.readInt32LE() !== 0; },
    terminate: job => { if (terminate(job, 1) === 0) throw failure("terminate-members"); },
    close: (handle, stage) => { if (close(handle) === 0) throw failure(stage); },
  };
};

const withHandle = <T>(api: JobKernel, handle: unknown, stage: string, action: () => T): T => {
  let result: T | undefined, failure: unknown, failed = false;
  try { result = action(); }
  catch (error) { failed = true; failure = error; }
  try { api.close(handle, stage); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], "Windows controller Job Object operation and handle release failed.", { cause: failure });
    throw error;
  }
  if (failed) throw failure;
  return result!;
};
const withHandleAsync = async <T>(api: JobKernel, handle: unknown, stage: string, action: () => Promise<T>): Promise<T> => {
  let result: T | undefined, failure: unknown, failed = false;
  try { result = await action(); } catch (error) { failed = true; failure = error; }
  try { api.close(handle, stage); }
  catch (error) { if (failed) throw new AggregateError([failure, error], "Windows controller Job Object operation and handle release failed.", { cause: failure }); throw error; }
  if (failed) throw failure;
  return result!;
};

const validate = (name: string): void => { if (!/^Local\\Daynight-[0-9a-f-]{36}$/.test(name)) throw new Error("Invalid controller Job Object identity."); };
const operationDeadline = (absolute?: number): (() => void) => {
  if (absolute !== undefined && (!Number.isSafeInteger(absolute) || absolute <= 0)) throw new Error("Invalid Windows controller Job Object deadline.");
  const deadline = performance.now() + 15_000;
  return () => { if (performance.now() >= deadline || absolute !== undefined && Date.now() >= absolute) throw new Error("Windows controller Job Object operation exceeded its deadline."); };
};

/** Membership survives handle closure while associated processes remain; no breakaway is enabled. */
export const createControllerJob = async (launchId: string, pid: number): Promise<string> => {
  const name = `Local\\Daynight-${launchId}`; validate(name);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) throw new Error("Invalid controller process ID.");
  const checkDeadline = operationDeadline(), api = await (kernel ??= loadKernel());
  checkDeadline();
  const job = api.create(name);
  withHandle(api, job.handle, "close-job-handle", () => {
    checkDeadline();
    if (job.alreadyExists) throw new WindowsControllerJobError("identity-already-exists", 183);
    const process = api.openProcess(pid);
    withHandle(api, process, "close-process-handle", () => {
      checkDeadline(); api.assign(job.handle, process); checkDeadline();
    });
  });
  checkDeadline();
  return name;
};

const ownedJobs = new Map<string, { api: JobKernel; handle: unknown }>();

/** The Controller owns this handle until process exit, including failed startup. */
export const createOwnedControllerJob = async (launchId: string, pid: number): Promise<string> => {
  if (pid !== process.pid) throw new Error("A Controller may retain only its own Job Object.");
  const name = `Local\\Daynight-${launchId}`; validate(name);
  if (ownedJobs.has(name)) throw new Error("The Controller Job Object is already retained.");
  const checkDeadline = operationDeadline(), api = await (kernel ??= loadKernel());
  checkDeadline();
  const job = api.create(name);
  let retained = false, failure: unknown, failed = false;
  try {
    checkDeadline();
    if (job.alreadyExists) throw new WindowsControllerJobError("identity-already-exists", 183);
    const process = api.openProcess(pid);
    withHandle(api, process, "close-process-handle", () => { checkDeadline(); api.assign(job.handle, process); checkDeadline(); });
    checkDeadline();
    ownedJobs.set(name, { api, handle: job.handle }); retained = true;
  } catch (error) { failed = true; failure = error; }
  if (!retained) {
    try { api.close(job.handle, "close-job-handle"); }
    catch (error) { if (failed) throw new AggregateError([failure, error], "Windows Controller Job creation and handle release failed.", { cause: failure }); throw error; }
  }
  if (failed) throw failure;
  return name;
};

/** Intended for controlled fixtures; a running Controller retains its handle until exit. */
export const releaseOwnedControllerJob = (name: string): void => {
  const owned = ownedJobs.get(name);
  if (owned === undefined) throw new Error("Controller Job Object is not retained.");
  ownedJobs.delete(name);
  owned.api.close(owned.handle, "close-job-handle");
};

declare const leaseBrand: unique symbol;
export type ControllerJobLease = { readonly [leaseBrand]: true };
type LeaseState = { api: JobKernel; handle: unknown; name: string; proof: ProcessProof; busy: boolean; closed: boolean };
const leases = new WeakMap<ControllerJobLease, LeaseState>();

/** Open and authenticate the original Controller while both handles are held. */
export const acquireControllerJobLease = async (launchId: string, spawnProof: ProcessProof, deadline: number): Promise<ControllerJobLease> => {
  const name = `Local\\Daynight-${launchId}`; validate(name);
  if (spawnProof.jobObjectName !== undefined && spawnProof.jobObjectName !== name) throw new Error("Controller Job Object identity conflicts with the original launch.");
  const checkDeadline = operationDeadline(deadline);
  checkDeadline();
  let api: JobKernel;
  try { api = await (kernel ??= loadKernel()); }
  catch (cause) {
    if (Date.now() >= deadline) throw new AggregateError([cause, new Error("Windows Job lease acquisition exceeded its deadline.")], "Windows Job lease acquisition failed at its deadline.", { cause });
    throw cause;
  }
  checkDeadline();
  if (api.pointerSize !== 4 && api.pointerSize !== 8) throw new Error("Unsupported Windows Job Object pointer size.");
  let handle: unknown;
  try { handle = api.open(name, true); }
  catch (cause) {
    if (Date.now() >= deadline) throw new AggregateError([cause, new Error("Windows Job lease acquisition exceeded its deadline.")], "Windows Job lease acquisition failed at its deadline.", { cause });
    throw cause;
  }
  if (handle === null) throw new WindowsControllerJobError("open", 2);
  let failure: unknown, failed = false;
  try {
    checkDeadline();
    const memberDeadline = Math.min(deadline, Date.now() + 15_000);
    if (!await verifyWindowsJobMember(spawnProof, memberDeadline, process => api.contains(handle, process))) throw new Error("Windows Job Object lacks its verified original Controller member.");
    checkDeadline();
    const lease = {} as ControllerJobLease;
    leases.set(lease, { api, handle, name, proof: { ...spawnProof }, busy: false, closed: false });
    return lease;
  } catch (error) { failed = true; failure = error; }
  try { api.close(handle, "close-job-handle"); }
  catch (error) { failure = failed ? new AggregateError([failure, error], "Windows Job lease acquisition and handle release failed.", { cause: failure }) : error; }
  if (Date.now() >= deadline && !(failure instanceof Error && /deadline/.test(failure.message))) throw new AggregateError([failure, new Error("Windows Job lease acquisition exceeded its deadline.")], "Windows Job lease acquisition failed at its deadline.", { cause: failure });
  throw failure;
};

export const releaseControllerJobLease = (lease: ControllerJobLease): void => {
  const state = leases.get(lease);
  if (state === undefined || state.closed || state.busy) throw new Error("Windows Job lease is unavailable or in use.");
  state.closed = true;
  state.api.close(state.handle, "close-job-handle");
};

/** Every operation uses the authenticated, retained Job handle. */
export const inspectControllerJobLease = async (lease: ControllerJobLease, controller: ProcessProof, stop: boolean, deadline?: number): Promise<readonly number[]> => {
  const state = leases.get(lease);
  if (state === undefined || state.closed || state.busy) throw new Error("Windows Job lease is unavailable or in use.");
  const original = state.proof;
  if (controller.pid !== original.pid || controller.parentPid !== original.parentPid || controller.processGroupId !== original.processGroupId || controller.startedAt !== original.startedAt || controller.commandHash !== original.commandHash || controller.jobObjectName !== state.name) throw new Error("Windows Job lease conflicts with the original Controller identity.");
  const checkDeadline = operationDeadline(deadline);
  checkDeadline(); state.busy = true;
  try {
    const inventory = (): number[] => {
      checkDeadline(); const data = Buffer.alloc(262_144);
      state.api.query(state.handle, data); checkDeadline();
      const assigned = data.readUInt32LE(0), count = data.readUInt32LE(4), size = state.api.pointerSize;
      if (count > assigned || 8 + count * size > data.length) throw new Error("Invalid controller Job Object process inventory.");
      const members = Array.from({ length: count }, (_, index) => size === 8 ? Number(data.readBigUInt64LE(8 + index * size)) : data.readUInt32LE(8 + index * size));
      if (members.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid controller Job Object process identity.");
      return members;
    };
    let members = inventory();
    if (stop && members.length > 0) {
      checkDeadline(); state.api.terminate(state.handle); checkDeadline();
      for (;;) {
        members = inventory();
        if (members.length === 0) break;
        checkDeadline();
        const left = deadline === undefined ? 25 : Math.max(1, Math.min(25, deadline - Date.now()));
        await new Promise(resolve => setTimeout(resolve, left));
      }
    }
    checkDeadline(); return members;
  } catch (cause) {
    if (deadline !== undefined && Date.now() >= deadline && !(cause instanceof Error && /deadline/.test(cause.message))) throw new AggregateError([cause, new Error("Windows controller Job Object operation exceeded its deadline.")], "Windows controller Job Object operation failed at its deadline.", { cause });
    throw cause;
  } finally { state.busy = false; }
};

/** Native calls are joined before checking the operation's fifteen-second budget. */
export const inspectControllerJob = async (name: string, stop = false, deadline?: number, proofs: readonly ProcessProof[] = []): Promise<readonly number[]> => {
  validate(name);
  const checkDeadline = operationDeadline(deadline);
  try {
    checkDeadline();
    const api = await (kernel ??= loadKernel());
    checkDeadline();
    if (api.pointerSize !== 4 && api.pointerSize !== 8) throw new Error("Unsupported Windows Job Object pointer size.");
    const job = api.open(name, stop);
    if (job === null) throw new WindowsControllerJobError("open", 2);
    const pids = await withHandleAsync(api, job, "close-job-handle", async () => {
      checkDeadline();
      const inventory = (): number[] => {
        checkDeadline();
        const data = Buffer.alloc(262_144);
        api.query(job, data); checkDeadline();
        const assigned = data.readUInt32LE(0), count = data.readUInt32LE(4);
        if (count > assigned || 8 + count * api.pointerSize > data.length) throw new Error("Invalid controller Job Object process inventory.");
        const members = Array.from({ length: count }, (_, index) => {
          const offset = 8 + index * api.pointerSize;
          return api.pointerSize === 8 ? Number(data.readBigUInt64LE(offset)) : data.readUInt32LE(offset);
        });
        if (members.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid controller Job Object process identity.");
        return members;
      };
      let members = inventory();
      if (!stop || members.length === 0) return members;
      const memberDeadline = Math.min(deadline ?? Number.MAX_SAFE_INTEGER, Date.now() + 15_000);
      let verified = false;
      for (const proof of proofs) {
        if (!members.includes(proof.pid)) continue;
        checkDeadline();
        if (await verifyWindowsJobMember(proof, memberDeadline, process => api.contains(job, process))) { verified = true; break; }
      }
      checkDeadline();
      if (!verified) throw new Error("Windows Job Object has no verified original process member; ownership is unconfirmed.");
      api.terminate(job); checkDeadline();
      for (;;) {
        members = inventory();
        if (members.length === 0) return members;
        checkDeadline();
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, memberDeadline - Date.now()))));
      }
    });
    checkDeadline();
    return pids;
  } catch (cause) {
    if (deadline !== undefined && Date.now() >= deadline && !(cause instanceof Error && /deadline/.test(cause.message))) throw new AggregateError([cause, new Error("Windows controller Job Object operation exceeded its deadline.")], "Windows controller Job Object operation failed at its deadline.", { cause });
    throw cause;
  }
};
