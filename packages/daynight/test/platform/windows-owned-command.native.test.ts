import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWindowsJobKernel } from "../../src/platform/windows-job.js";
import { loadWindowsNativeProcessKernel } from "../../src/platform/windows-native-process.js";
import type { WindowsCommandJobKernel } from "../../src/platform/windows-job.js";
import { spawnWindowsOwnedCommand, WindowsCommandCleanupError } from "../../src/platform/windows-owned-command.js";
import type { WindowsOwnedCommand } from "../../src/platform/windows-owned-command.js";

type Member = { role: string; pid: number; birth: string; handle: unknown };
const actorRoles = ["root", "middle", "leaf", "bystander"] as const;
const actorCodes = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT", "EIO", "ENOSPC", "EMFILE", "ENFILE", "EINVAL", "UNKNOWN"]);
const actorSyscalls = new Set(["open", "write", "close", "rename", "stat", "read", "spawn"]);
const actorStages = new Set(["identity", "identity-publish", "poll", "spawn-middle", "spawn-leaf", "heartbeat-append", "attempt-fork", "fork-result"]);
type ActorFailure = { schemaVersion: 1; role: string; stage: string; name: string; code?: string; syscall?: string };
const readHeartbeat = (file: string): number => {
  const ticks = statSync(file).size;
  if (!Number.isSafeInteger(ticks) || ticks < 0) throw new Error("Native heartbeat byte count is invalid.");
  return ticks;
};
const safeError = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) return { thrownType: typeof error };
  const fields: Record<string, unknown> = { name: error.name };
  const values = error as Error & { code?: string; syscall?: string; errno?: number; win32Code?: number };
  if (values.code !== undefined && actorCodes.has(values.code)) fields.code = values.code;
  if (values.syscall !== undefined && actorSyscalls.has(values.syscall)) fields.syscall = values.syscall;
  if (Number.isSafeInteger(values.errno) && values.errno! >= -0x8000_0000 && values.errno! <= 0xffff_ffff) fields.errno = values.errno;
  if (Number.isSafeInteger(values.win32Code) && values.win32Code! >= 0 && values.win32Code! <= 0xffff_ffff) fields.win32Code = values.win32Code;
  return fields;
};
const observe = (read: () => unknown): unknown => { try { return read(); } catch (error) { return { observationError: safeError(error) }; } };
const actorFailures = (root: string): ActorFailure[] => actorRoles.flatMap(role => {
  const file = path.join(root, role + ".error.json");
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (Object.keys(value).some(key => !["schemaVersion", "role", "stage", "name", "code", "syscall"].includes(key)) ||
      value.schemaVersion !== 1 || value.role !== role || typeof value.name !== "string" || typeof value.stage !== "string" || !actorStages.has(value.stage) ||
      value.code !== undefined && (typeof value.code !== "string" || !actorCodes.has(value.code)) ||
      value.syscall !== undefined && (typeof value.syscall !== "string" || !actorSyscalls.has(value.syscall))) throw new Error(`Native ${role} error receipt is invalid.`);
  return [value as ActorFailure];
});
const script = path.resolve(import.meta.dirname, "../fixtures/windows-owned-command-tree.mjs");
const until = async (check: () => boolean | Promise<boolean>, deadline = performance.now() + 10_000): Promise<void> => {
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error("Native owned-command fixture barrier did not complete.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

describe.skipIf(process.platform !== "win32")("native platform Windows command ownership", () => {
  let directory: string, api: WindowsCommandJobKernel;
  let terminateProcess: (handle: unknown, code: number) => number;
  let restrict: (handle: unknown) => unknown;
  let nativeLastError: () => number;
  let openSharedHeartbeat: (file: string) => unknown, closeSharedHeartbeat: (handle: unknown) => void;
  beforeAll(async () => {
    const root = path.resolve(import.meta.dirname, "../../../../.tmp"); await mkdir(root, { recursive: true });
    directory = await mkdtemp(path.join(root, "native-owned-command-")); api = await loadWindowsJobKernel();
    const koffi = await import("koffi"), kernel = koffi.load("kernel32.dll");
    terminateProcess = kernel.func("int __stdcall TerminateProcess(void *handle, uint32_t code)");
    const current = kernel.func("void * __stdcall GetCurrentProcess()");
    const duplicate = kernel.func("int __stdcall DuplicateHandle(void *sourceProcess, void *source, void *targetProcess, void *target, uint32_t access, int inherit, uint32_t options)");
    nativeLastError = kernel.func("uint32_t __stdcall GetLastError()");
    const lastError = nativeLastError;
    const openFile = kernel.func("void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)");
    const closeHandle = kernel.func("int __stdcall CloseHandle(void *handle)");
    const bits = koffi.sizeof("void *") * 8;
    openSharedHeartbeat = file => {
      // Permit heartbeat writes while withholding the delete sharing required by replacement.
      const handle: unknown = openFile(file, 0x8000_0000, 3, null, 3, 0x80, null), code = lastError();
      if (handle === null || BigInt.asUintN(bits, koffi.address(handle)) === (1n << BigInt(bits)) - 1n) throw Object.assign(new Error("Native shared heartbeat reader did not open."), { win32Code: code });
      return handle;
    };
    closeSharedHeartbeat = handle => { if (!closeHandle(handle)) { const code = lastError(); throw Object.assign(new Error("Native shared heartbeat reader did not close."), { win32Code: code }); } };
    restrict = job => {
      const buffer = Buffer.alloc(koffi.sizeof("void *"));
      if (!duplicate(current(), job, current(), buffer, 0x00100007, 0, 0)) throw new Error(`Native Job restriction failed (${lastError()}).`);
      return koffi.decode(buffer, "void *");
    };
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  const exercise = async (scenario: "survivor" | "seal" | "last-owner-failure"): Promise<void> => {
    const root = await mkdtemp(path.join(directory, "tree-")), members: Member[] = [], events: unknown[] = [];
    let command: WindowsOwnedCommand | undefined, job: unknown, jobClosed = false, closeAttempted = false, primary: unknown;
    let nativeDenial: unknown, closeCalls = 0, terminateCalls = 0, sealed = false, bystanderClosed = false;
    let bystander: ChildProcess | undefined, bystanderError: unknown;
    let currentStage = "create-fixture";
    const healthy = (liveRoles: readonly string[]): void => {
      const failures = actorFailures(root);
      if (failures.length) throw Object.assign(new Error(`Native fixture actor ${failures[0]!.role} failed at ${failures[0]!.stage}.`), { fixtureRole: failures[0]!.role, stage: currentStage });
      if (bystanderError !== undefined) throw bystanderError;
      if (bystanderClosed) throw new Error(`Native bystander exited before ${currentStage}.`);
      for (const role of liveRoles) {
        const member = members.find(candidate => candidate.role === role);
        if (member === undefined) throw new Error(`Native ${role} was not captured before ${currentStage}.`);
        if (api.signaled(member.handle)) throw new Error(`Native ${role} exited before ${currentStage}.`);
      }
    };
    const barrier = async (stage: string, check: () => boolean | Promise<boolean>, liveRoles: readonly string[], deadline = performance.now() + 10_000): Promise<void> => {
      currentStage = stage; await until(() => { healthy(liveRoles); return check(); }, deadline);
    };
    const failureSnapshot = (): Record<string, unknown> => {
      return { stage: currentStage, actorErrors: observe(() => actorFailures(root)),
        members: members.map(member => ({ role: member.role, pid: member.pid, birth: member.birth, signal: observe(() => api.signaled(member.handle)) })),
        heartbeats: ["leaf", "bystander"].map(role => { const file = path.join(root, role + ".heartbeat"); return { role, present: existsSync(file), ticks: observe(() => existsSync(file) ? readHeartbeat(file) : null) }; }) };
    };
    const record = (stage: string, extra: Record<string, unknown> = {}) => events.push({ stage, atNs: process.hrtime.bigint().toString(),
      members: members.map(member => ({ role: member.role, pid: member.pid, birth: member.birth, signaled: api.signaled(member.handle) })), ...extra });
    const capture = (role: string, pid: number, birth?: string, suppliedHandle?: unknown): Member => {
      const handle = suppliedHandle === undefined ? api.open(pid) : suppliedHandle;
      if (handle === null) throw new Error("Native fixture disappeared before independent capture.");
      try {
        const identity = api.identity(handle), observedBirth = identity.birth.toString();
        expect(identity.pid).toBe(pid); if (birth !== undefined) expect(observedBirth).toBe(birth);
        if (role === "bystander") expect(identity.parentPid).toBe(process.pid);
        else {
          if (job === undefined) throw new Error("Native owned fixture has no assigned Job.");
          expect(api.contains(job, handle)).toBe(true);
        }
        expect(api.signaled(handle)).toBe(false);
        const member: Member = { role, pid, birth: observedBirth, handle };
        members.push(member); return member;
      } catch (error) {
        try { api.closeProcess(handle); }
        catch (closeError) { throw new AggregateError([error, closeError], "Rejected native fixture observation did not close safely."); }
        throw error;
      }
    };
    const declared = async (role: string): Promise<Member> => {
      const file = path.join(root, role + ".json");
      await barrier("declaration-" + role, () => existsSync(file), members.filter(member => member.role === "bystander" || member.role === "root").map(member => member.role));
      const value = JSON.parse(await readFile(file, "utf8")) as { pid: number; birth: string };
      if (role === "root") {
        const original = members.find(member => member.role === "root");
        if (original === undefined) throw new Error("Native target creation was not independently observed.");
        expect(value.pid).toBe(original.pid); expect(value.birth).toBe(original.birth); return original;
      }
      return capture(role, value.pid, value.birth);
    };
    try {
      bystander = spawn(process.execPath, [script, root, "bystander"], { stdio: "ignore", windowsHide: true });
      bystander.once("error", error => { bystanderError = error; }); bystander.once("close", () => { bystanderClosed = true; });
      const unrelated = await declared("bystander");
      command = spawnWindowsOwnedCommand({ file: process.execPath, args: [script, root, "root"], cwd: root, environment: process.env,
        stdin: "ignore", resolver: "node", deadline: performance.now() + 15_000, graceMs: 1000, pipeCloseMs: 1000,
        normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close",
        onReleased: () => { throw new Error("This native control must stop rather than release."); },
      }, { loadKernel: async () => ({ ...api,
        createAnonymousJob: () => {
          const original = api.createAnonymousJob();
          if (scenario !== "last-owner-failure") { job = original; return job; }
          try { job = restrict(original); } catch (error) { api.close(original); throw error; }
          api.close(original); // Only the product duplicate remains: last-close behavior is not masked by a fixture Job handle.
          return job;
        },
        sealAdmissions: handle => {
          api.sealAdmissions(handle); sealed = true;
          if (scenario === "seal") {
            currentStage = "seal-fork-result";
            writeFileSync(path.join(root, "attempt-fork"), "release");
            const deadline = performance.now() + 1000;
            while (!existsSync(path.join(root, "fork-result.json"))) {
              healthy(["bystander", "root", "middle", "leaf"]);
              if (performance.now() >= deadline) throw new Error("Sealed native fork observation did not finish.");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
            const result = JSON.parse(readFileSync(path.join(root, "fork-result.json"), "utf8")) as { marker: boolean };
            expect(result.marker).toBe(false); expect(existsSync(path.join(root, "forbidden-child"))).toBe(false);
            const target = members.find(member => member.role === "root")!;
            expect(api.signaled(target.handle)).toBe(false);
            record("seal-refused-new-user-code-before-termination", { forkResult: result, rootMembership: api.contains(handle, target.handle) });
          }
        },
        terminate: handle => {
          terminateCalls++;
          try { api.terminate(handle); } catch (error) { nativeDenial = error; throw error; }
        },
        close: handle => {
          if (handle === job) { closeAttempted = true; closeCalls++; record("product-job-close-request", { sealed, active: api.active(handle) }); }
          api.close(handle); if (handle === job) jobClosed = true;
        },
      }), loadNative: async () => {
        const native = await loadWindowsNativeProcessKernel();
        return { ...native, duplicateProcess: original => {
          const held = native.duplicateProcess(original);
          let identity;
          try { identity = api.identity(held); }
          catch (error) { api.closeProcess(held); throw error; }
          capture("root", identity.pid, identity.birth.toString(), held);
          return native.duplicateProcess(original);
        } };
      } });
      command.stdout.resume(); command.stderr.resume(); await command.start();
      const target = await declared("root"); expect(api.contains(job, target.handle)).toBe(true);
      expect(api.contains(job, unrelated.handle)).toBe(false);
      writeFileSync(path.join(root, "spawn"), "release");
      const middle = await declared("middle"), leaf = await declared("leaf");
      expect(api.contains(job, leaf.handle)).toBe(true);
      const heartbeat = path.join(root, "leaf.heartbeat"); await barrier("initial-leaf-heartbeat", () => existsSync(heartbeat), ["bystander", "root", "middle", "leaf"]);
      const before = readHeartbeat(heartbeat); await barrier("initial-leaf-heartbeat-growth", () => readHeartbeat(heartbeat) > before, ["bystander", "root", "middle", "leaf"]);
      if (scenario !== "seal") {
        writeFileSync(path.join(root, "leave-middle"), "release"); await barrier("middle-exit", () => api.signaled(middle.handle), ["bystander", "root", "leaf"]);
        currentStage = "original-root-and-pipes-closed"; writeFileSync(path.join(root, "leave-root"), "release"); await command.closed;
        expect(api.signaled(target.handle)).toBe(true); expect(api.signaled(leaf.handle)).toBe(false);
        const closedRootBaseline = readHeartbeat(heartbeat); let advanced = closedRootBaseline;
        await barrier("post-root-leaf-heartbeat-growth", () => {
          expect(api.signaled(leaf.handle)).toBe(false);
          const observed = readHeartbeat(heartbeat);
          if (observed <= closedRootBaseline) return false;
          advanced = observed; return true;
        }, ["bystander", "leaf"]);
        const currentMembership = api.contains(job, leaf.handle), inventory = api.inspect(job);
        expect(currentMembership).toBe(true); expect(inventory).toContain(leaf.pid);
        record("closed-root-with-detectable-live-leaf", { leafMembership: currentMembership, inventory,
          leafHeartbeat: { before: closedRootBaseline, after: advanced } });
      }
      currentStage = "stop-owned";
      if (scenario === "last-owner-failure") {
        let failure: unknown;
        try { await command.stop(); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(WindowsCommandCleanupError);
        expect(nativeDenial).toMatchObject({ name: "WindowsJobError", stage: "terminate-members", win32Code: 5 });
        expect((failure as WindowsCommandCleanupError).errors[0]).toBe(nativeDenial);
        expect(closeCalls).toBe(1); expect(jobClosed).toBe(true);
        await barrier("last-owner-close-owned-exit", () => members.filter(member => member.role !== "bystander").every(member => api.signaled(member.handle)), ["bystander"]);
        record("last-owner-close-assisted-exit-error-retained-before-fixture-cleanup", { originalErrorRetained: (failure as WindowsCommandCleanupError).errors[0] === nativeDenial });
      } else {
        await command.stop();
        expect(members.filter(member => member.role !== "bystander").every(member => api.signaled(member.handle))).toBe(true);
        record("owned-exit-confirmed-before-fixture-cleanup");
      }
      expect(sealed).toBe(true); expect(terminateCalls).toBe(1); expect(closeCalls).toBe(1); expect(jobClosed).toBe(true);
      expect(api.signaled(unrelated.handle)).toBe(false);
      const bystanderHeartbeat = path.join(root, "bystander.heartbeat"); await barrier("post-stop-bystander-heartbeat", () => existsSync(bystanderHeartbeat), ["bystander"]);
      const alive = readHeartbeat(bystanderHeartbeat); await barrier("post-stop-bystander-heartbeat-growth", () => readHeartbeat(bystanderHeartbeat) > alive, ["bystander"]);
      record("bystander-still-writing-before-fixture-cleanup");
    } catch (error) { primary = error; events.push({ stage: "failure-before-fixture-cleanup", atNs: process.hrtime.bigint().toString(), observation: failureSnapshot() }); throw error; }
    finally {
      const failures: unknown[] = [];
      const attempt = (action: () => void): void => { try { action(); } catch (error) { failures.push(error); } };
      if (command !== undefined) { try { await command.stop(); } catch (error) { if (primary === undefined && scenario !== "last-owner-failure") failures.push(error); } }
      if (job !== undefined && !closeAttempted) attempt(() => api.terminate(job));
      for (const member of members) attempt(() => { if (!api.signaled(member.handle) && !terminateProcess(member.handle, 1)) throw new Error("Native command fixture termination failed."); });
      if (bystander !== undefined && !bystanderClosed) attempt(() => { bystander!.kill("SIGKILL"); });
      try { await until(() => members.every(member => api.signaled(member.handle)) && (bystander === undefined || bystanderClosed)); record("fixture-cleanup-complete"); }
      catch (error) { failures.push(error); }
      for (const member of members) attempt(() => api.closeProcess(member.handle));
      if (job !== undefined && !closeAttempted) attempt(() => api.close(job));
      if (bystanderError !== undefined) failures.push(bystanderError);
      const result = command?.result;
      const targetOutcome = result === undefined ? { known: false } : result.kind === "not-started"
        ? { known: true, kind: result.kind, code: result.error.code } : { known: true, kind: result.kind, code: result.code, signal: result.signal };
      console.error("WINDOWS_OWNED_COMMAND_DIAGNOSTIC " + JSON.stringify({ scenario, targetOutcome, primaryError: primary === undefined ? null : String(primary), cleanupErrors: failures.map(String), events }));
      if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], "Native command fixture cleanup failed.");
    }
  };
  it("detects and stops a detached member after its original root and parent exit", async () => exercise("survivor"), 30_000);
  it("seals new user-code admission while an already admitted root remains alive", async () => exercise("seal"), 30_000);
  it("retains an actual native stop failure even when final last-owner close later kills the member", async () => exercise("last-owner-failure"), 30_000);

  it("keeps append heartbeat progress while a known shared reader refuses atomic replacement", async () => {
    const root = await mkdtemp(path.join(directory, "shared-reader-")), heartbeat = path.join(root, "bystander.heartbeat"), events: unknown[] = [];
    let child: ChildProcess | undefined, childClosed = false, childError: unknown, member: Member | undefined, reader: unknown, readerOwned = false, primary: unknown;
    let stage = "actor-declaration";
    const healthy = (): void => {
      const failures = actorFailures(root);
      if (failures.length) throw new Error(`Shared-reader actor failed at ${failures[0]!.stage}.`);
      if (childError !== undefined) throw childError;
      if (childClosed || member !== undefined && api.signaled(member.handle)) throw new Error(`Shared-reader actor exited before ${stage}.`);
    };
    const barrier = async (check: () => boolean): Promise<void> => until(() => { healthy(); return check(); });
    const snapshot = (): Record<string, unknown> => ({ stage, readerHeld: readerOwned, actorErrors: observe(() => actorFailures(root)),
      actor: member === undefined ? null : { pid: member.pid, birth: member.birth, signal: observe(() => api.signaled(member!.handle)) },
      ticks: observe(() => existsSync(heartbeat) ? readHeartbeat(heartbeat) : null) });
    try {
      child = spawn(process.execPath, [script, root, "bystander"], { stdio: "ignore", windowsHide: true });
      child.once("error", error => { childError = error; }); child.once("close", () => { childClosed = true; });
      const file = path.join(root, "bystander.json"); await barrier(() => existsSync(file));
      const declared = JSON.parse(readFileSync(file, "utf8")) as { pid: number; birth: string };
      const handle = api.open(declared.pid);
      if (handle === null) throw new Error("Shared-reader actor disappeared before capture.");
      try {
        const identity = api.identity(handle);
        if (identity.pid !== declared.pid || identity.birth.toString() !== declared.birth || identity.pid !== child.pid || identity.parentPid !== process.pid || api.signaled(handle)) throw new Error("Shared-reader actor identity did not match its original child.");
        member = { role: "bystander", pid: identity.pid, birth: identity.birth.toString(), handle };
      } catch (error) {
        try { api.closeProcess(handle); } catch (closeError) { throw new AggregateError([error, closeError], "Rejected shared-reader observation did not close."); }
        throw error;
      }
      stage = "heartbeat-ready"; await barrier(() => existsSync(heartbeat) && readHeartbeat(heartbeat) > 0);
      reader = openSharedHeartbeat(heartbeat); readerOwned = true;
      const replacement = heartbeat + ".replacement"; writeFileSync(replacement, Buffer.from([1]));
      let replacementError: unknown;
      stage = "refuse-replacement";
      try { renameSync(replacement, heartbeat); } catch (error) { replacementError = error; }
      expect(replacementError).toBeInstanceOf(Error);
      expect((replacementError as NodeJS.ErrnoException).syscall).toBe("rename");
      expect(typeof (replacementError as NodeJS.ErrnoException).code).toBe("string"); expect(existsSync(replacement)).toBe(true);
      const before = readHeartbeat(heartbeat); stage = "append-with-reader-held";
      await barrier(() => readHeartbeat(heartbeat) > before);
      const after = readHeartbeat(heartbeat);
      expect(after).toBeGreaterThan(before); expect(api.signaled(member.handle)).toBe(false); expect(readerOwned).toBe(true);
      events.push({ stage: "append-progress-before-reader-or-actor-cleanup", holder: "fixture-owned-shared-reader", shareMode: 3, deleteSharing: false,
        replacementError: safeError(replacementError), heartbeat: { before, after }, observation: snapshot() });
    } catch (error) { primary = error; events.push({ stage: "failure-before-fixture-cleanup", observation: snapshot() }); throw error; }
    finally {
      const failures: unknown[] = [];
      const attempt = (action: () => void): void => { try { action(); } catch (error) { failures.push(error); } };
      const deadline = performance.now() + 10_000, cooperativeDeadline = deadline - 1000;
      if (readerOwned) { readerOwned = false; attempt(() => closeSharedHeartbeat(reader)); }
      let requested = false, joined = false, forceAttempted = false;
      try { writeFileSync(path.join(root, "leave-bystander"), "release"); requested = true; } catch (error) { failures.push(error); }
      const actorClosed = (): boolean => (member === undefined || api.signaled(member.handle)) && (child === undefined || childClosed);
      if (requested) {
        try { await until(actorClosed, cooperativeDeadline); joined = true; } catch (error) { failures.push(error); }
      }
      if (!joined) {
        if (member !== undefined) attempt(() => {
          if (!api.signaled(member!.handle)) {
            forceAttempted = true;
            if (!terminateProcess(member!.handle, 1)) { const code = nativeLastError(); throw Object.assign(new Error("Shared-reader actor termination failed."), { win32Code: code }); }
          }
        });
        else if (child !== undefined && child.exitCode === null && child.signalCode === null) attempt(() => { forceAttempted = true; child!.kill("SIGKILL"); });
        try { await until(actorClosed, deadline); joined = true; } catch (error) { failures.push(error); }
      }
      let finalSignal: unknown = null;
      if (member !== undefined) {
        try { finalSignal = api.signaled(member.handle); }
        catch (error) { failures.push(error); finalSignal = { observationError: safeError(error) }; }
      }
      const abandonedChildReference = !joined && child !== undefined && !childClosed;
      events.push({ stage: "cleanup-before-observer-close", atNs: process.hrtime.bigint().toString(), cooperativeRequested: requested, forceAttempted, joined, childClosed, abandonedChildReference,
        actor: member === undefined ? null : { pid: member.pid, birth: member.birth, signaled: finalSignal } });
      if (abandonedChildReference) attempt(() => { child!.unref(); });
      if (member !== undefined) attempt(() => api.closeProcess(member!.handle));
      if (childError !== undefined && childError !== primary) failures.push(childError);
      console.error("WINDOWS_HEARTBEAT_SHARING_DIAGNOSTIC " + JSON.stringify({ primaryError: primary === undefined ? null : safeError(primary), cleanupErrors: failures.map(safeError), events }));
      if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], "Shared-reader fixture cleanup failed.", primary === undefined ? undefined : { cause: primary });
    }
  }, 30_000);

  it("preserves quoted argv, Unicode environment, NUL input, and a backpressured binary pipe tail", async () => {
    const root = await mkdtemp(path.join(directory, "argv 中文 "));
    const args = ["", "two words", 'embedded"quote', "trailing\\", "中文", "tab\tvalue"], tail = Buffer.alloc(256 * 1024, 0xab);
    const source = "const fs=require('node:fs');process.stderr.end(JSON.stringify({args:process.argv.slice(1),value:process.env.DAYNIGHT_NATIVE_VALUE,cwd:process.cwd(),input:fs.readFileSync(0).length,path:process.env.PATH,systemRoot:process.env.SystemRoot,coverage:process.env.NODE_V8_COVERAGE})+'\\n');process.stdout.end(Buffer.alloc(256*1024,0xab));";
    const environment = { PATH: path.dirname(process.execPath), Path: "Z:\\not-the-executable-path", DAYNIGHT_NATIVE_VALUE: "中文=value" };
    const file = path.basename(process.execPath), targetArgs = ["-e", source, "--", ...args];
    const baseline = await new Promise<{ code: number | null; output: Buffer; metadata: unknown }>((resolve, reject) => {
      const child = spawn(file, targetArgs, { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const out: Buffer[] = [], err: Buffer[] = []; let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 15_000);
      child.stdout.on("data", chunk => { out.push(chunk as Buffer); }); child.stderr.on("data", chunk => { err.push(chunk as Buffer); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); if (expired) { reject(new Error("Native argv baseline did not finish.")); return; } try { resolve({ code, output: Buffer.concat(out), metadata: JSON.parse(Buffer.concat(err).toString("utf8")) }); } catch (error) { reject(error); } });
    });
    expect(baseline.code).toBe(0); expect(baseline.output).toEqual(tail);
    let committed = false;
    const command = spawnWindowsOwnedCommand({ file, args: targetArgs, cwd: root,
      environment, stdin: "ignore", resolver: "node", deadline: performance.now() + 15_000,
      graceMs: 1000, pipeCloseMs: 1000, normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close", onReleased: () => { committed = true; } });
    const errors: Buffer[] = []; let stderrEnded = false, primary: unknown, stage = "start";
    command.stderr.on("data", chunk => { errors.push(chunk as Buffer); }); command.stderr.once("end", () => { stderrEnded = true; });
    try {
      await command.start(); stage = "metadata-frame-and-backpressure";
      await until(() => Buffer.concat(errors).includes(10) && command.stdout.readableLength >= command.stdout.readableHighWaterMark);
      expect(command.result).toBeUndefined();
      stage = "drain-binary-tail";
      const chunks: Buffer[] = []; for await (const chunk of command.stdout) chunks.push(chunk as Buffer);
      await command.closed;
      expect(Buffer.concat(chunks)).toEqual(tail);
      expect(JSON.parse(Buffer.concat(errors).toString("utf8"))).toEqual(baseline.metadata);
      expect(baseline.metadata).toMatchObject({ args, value: "中文=value", cwd: root, input: 0, path: environment.PATH });
      expect(command.result).toEqual({ kind: "exit", code: 0, signal: null, failure: null });
      await command.release(); expect(committed).toBe(true);
    } catch (error) { primary = error; throw error; }
    finally {
      const failures: unknown[] = [];
      if (!committed) {
        command.stdout.resume(); command.stderr.resume();
        try { await command.stop(); } catch (error) { failures.push(error); }
      }
      console.error("WINDOWS_NATIVE_PIPE_PARITY_DIAGNOSTIC " + JSON.stringify({ stage, primaryError: primary instanceof Error ? { name: primary.name } : null,
        cleanupErrors: failures.map(error => error instanceof Error ? { name: error.name } : { type: typeof error }), stderrFrameBytes: Buffer.concat(errors).length,
        stderrEnded, stdoutEnded: command.stdout.readableEnded, stdoutBufferedBytes: command.stdout.readableLength, stdoutHighWaterMark: command.stdout.readableHighWaterMark, committed }));
      if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], "Native pipe parity fixture cleanup failed.", primary === undefined ? undefined : { cause: primary });
    }
  }, 30_000);

  it.each([7, 259])("reports actual DWORD exit %i from a signaled original process", async code => {
    let committed = false;
    const command = spawnWindowsOwnedCommand({ file: process.execPath, args: ["-e", `process.exit(${code})`], cwd: directory,
      environment: process.env, stdin: "ignore", resolver: "node", deadline: performance.now() + 15_000,
      graceMs: 1000, pipeCloseMs: 1000, normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close", onReleased: () => { committed = true; } });
    command.stdout.resume(); command.stderr.resume();
    try { await command.start(); await command.closed; expect(command.result).toEqual({ kind: "exit", code, signal: null, failure: null }); await command.release(); }
    finally { if (!committed) await command.stop(); }
  }, 30_000);

  it.each(["missing", "bad-image"])("keeps a genuine %s spawn failure aligned with Node", async profile => {
    const file = path.join(directory, `${profile}.exe`), args = ["fixture argument"];
    if (profile === "bad-image") writeFileSync(file, "This is an ordinary test file, not a PE executable.");
    let delivery: "synchronous" | "error-event" | undefined;
    const baseline = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      const failed = (error: unknown, observed: typeof delivery): void => {
        if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string" || !("errno" in error) || typeof error.errno !== "number") { reject(error); return; }
        delivery = observed; resolve(error as NodeJS.ErrnoException);
      };
      let child: ChildProcess;
      try { child = spawn(file, args, { cwd: directory, stdio: "ignore", windowsHide: true }); }
      catch (error) { failed(error, "synchronous"); return; }
      child.once("error", error => { failed(error, "error-event"); });
      child.once("spawn", () => {
        child.once("close", () => { reject(new Error("Invalid image fixture unexpectedly executed.")); });
        child.kill("SIGKILL");
      });
    });
    let committed = false;
    const command = spawnWindowsOwnedCommand({ file, args, cwd: directory, environment: process.env, stdin: "ignore", resolver: "node", deadline: performance.now() + 15_000,
      graceMs: 1000, pipeCloseMs: 1000, normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close", onReleased: () => { committed = true; } });
    command.stdout.resume(); command.stderr.resume();
    try {
      await command.start(); await command.closed;
      const receipt = command.result;
      console.error("WINDOWS_NATIVE_SPAWN_PARITY_DIAGNOSTIC " + JSON.stringify({ profile, delivery, baseline: { code: baseline.code, errno: baseline.errno },
        candidate: receipt?.kind === "not-started" ? { kind: receipt.kind, code: receipt.error.code, errno: receipt.error.errno, win32Code: receipt.error.win32Code } : { kind: receipt?.kind } }));
      expect(command.result).toMatchObject({ kind: "not-started", error: { code: baseline.code, errno: baseline.errno, syscall: `spawn ${file}`, path: file, spawnargs: args } });
      await command.release();
    } finally { if (!committed) await command.stop(); }
  }, 30_000);

  it("kills an unresumed native target after its CLI exits while its ambient Job remains open", async () => {
    const root = await mkdtemp(path.join(directory, "unadmitted-")), held: Member[] = [], events: unknown[] = [];
    const ambientJob = api.createAnonymousJob(); let child: ChildProcess | undefined, childClosed = false, primary: unknown, childError: unknown;
    const capture = async (role: "cli" | "root", parentPid: number): Promise<Member> => {
      const file = path.join(root, role + ".json"); await until(() => existsSync(file));
      const declaration = JSON.parse(await readFile(file, "utf8")) as { pid: number; birth: string };
      const handle = api.open(declaration.pid);
      if (handle === null) throw new Error("Unadmitted fixture disappeared before independent capture.");
      try {
        const identity = api.identity(handle);
        expect(identity.pid).toBe(declaration.pid); expect(identity.birth.toString()).toBe(declaration.birth);
        expect(identity.parentPid).toBe(parentPid); expect(api.signaled(handle)).toBe(false);
        if (role === "root") expect(api.contains(ambientJob, handle)).toBe(true);
        const member: Member = { role, pid: identity.pid, birth: identity.birth.toString(), handle }; held.push(member); return member;
      } catch (error) {
        try { api.closeProcess(handle); }
        catch (closeError) { throw new AggregateError([error, closeError], "Rejected unadmitted observation did not close safely."); }
        throw error;
      }
    };
    const record = (stage: string) => events.push({ stage, atNs: process.hrtime.bigint().toString(), ambientJobStillOpen: true,
      targetMarker: existsSync(path.join(root, "unadmitted-target-marker")),
      members: held.map(member => ({ role: member.role, pid: member.pid, birth: member.birth, signaled: api.signaled(member.handle) })) });
    try {
      api.killOnClose(ambientJob);
      child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../fixtures/windows-owned-command-owner.mjs"), root],
        { stdio: "ignore", windowsHide: true, detached: true });
      child.once("error", error => { childError = error; }); child.once("close", () => { childClosed = true; });
      const cli = await capture("cli", process.pid); expect(cli.pid).toBe(child.pid);
      api.assignHandle(ambientJob, cli.handle); expect(api.contains(ambientJob, cli.handle)).toBe(true);
      writeFileSync(path.join(root, "create-target"), "release");
      const target = await capture("root", cli.pid);
      expect(existsSync(path.join(root, "unadmitted-target-marker"))).toBe(false);
      record("unresumed-native-target-captured-in-live-ambient-job");
      writeFileSync(path.join(root, "exit-cli"), "release");
      await until(() => api.signaled(cli.handle) && childClosed);
      await until(() => api.signaled(target.handle));
      expect(child.exitCode).toBe(0); expect(existsSync(path.join(root, "unadmitted-target-marker"))).toBe(false);
      record("native-target-exited-without-payload-before-ambient-job-cleanup");
    } catch (error) { primary = error; throw error; }
    finally {
      const failures: unknown[] = [];
      const attempt = (action: () => void): void => { try { action(); } catch (error) { failures.push(error); } };
      attempt(() => api.terminate(ambientJob));
      if (child !== undefined && !childClosed) attempt(() => { child!.kill("SIGKILL"); });
      try { await until(() => held.every(member => api.signaled(member.handle)) && (child === undefined || childClosed)); }
      catch (error) { failures.push(error); }
      for (const member of held) attempt(() => api.closeProcess(member.handle));
      attempt(() => api.close(ambientJob));
      if (childError !== undefined) failures.push(childError);
      console.error("WINDOWS_UNADMITTED_COMMAND_DIAGNOSTIC " + JSON.stringify({ primaryError: primary === undefined ? null : String(primary), cleanupErrors: failures.map(String), events }));
      if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], "Unadmitted native fixture cleanup failed.");
    }
  }, 30_000);
});
