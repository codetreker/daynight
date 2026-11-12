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
      if (code === 2) return null;
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
    if (job === null) { checkDeadline(); return []; }
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
