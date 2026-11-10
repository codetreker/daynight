import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../src/api/operation.js";
import type { WindowsCommandJobKernel, WindowsJobProcess } from "../../src/platform/windows-job.js";
import { loadWindowsJobKernel } from "../../src/platform/windows-job.js";
import { loadWindowsNativeProcessKernel } from "../../src/platform/windows-native-process.js";
import type { WindowsOwnedCommand } from "../../src/platform/windows-owned-command.js";
import { RepositoryGitError, runRepositoryGit } from "../../src/repository/git.js";

type Probe = {
  restricted: boolean;
  duplicate: (job: unknown) => unknown;
  readFlags: (job: unknown) => number;
  observeRoot: (process: unknown, identity: WindowsJobProcess) => void;
  job?: unknown;
  fullJob?: unknown;
  root?: Member;
  createdRoot?: { pid: number; birth: string };
  command?: WindowsOwnedCommand;
  terminateCalls: number;
  releaseCalls: number;
  closeCalls: number;
  nativeError?: unknown;
  observationError?: unknown;
  releaseFlags?: number;
  closeFlags?: number;
  stdoutEnded: boolean;
  stderrEnded: boolean;
};
const boundary = vi.hoisted(() => ({ probe: undefined as Probe | undefined }));
vi.mock("../../src/platform/windows-owned-command.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/platform/windows-owned-command.js")>();
  const spawnWindowsOwnedCommand: typeof actual.spawnWindowsOwnedCommand = options => {
    const probe = boundary.probe;
    if (probe === undefined) throw new Error("A native Git ownership probe must be configured.");
    const command = actual.spawnWindowsOwnedCommand(options, { loadNative: async () => {
      const native = await loadWindowsNativeProcessKernel(), api = await loadWindowsJobKernel();
      return { ...native, duplicateProcess: (original: unknown) => {
        const productObservation = native.duplicateProcess(original);
        try {
          const fixtureObservation = native.duplicateProcess(original);
          let transferred = false;
          try {
            const identity = api.identity(productObservation);
            transferred = true; probe.observeRoot(fixtureObservation, identity);
            return productObservation;
          } catch (error) {
            if (!transferred) {
              try { api.closeProcess(fixtureObservation); }
              catch (closeError) { throw new AggregateError([error, closeError], "Unaccepted fixture process duplicate did not close safely."); }
            }
            throw error;
          }
        } catch (error) {
          try { api.closeProcess(productObservation); }
          catch (closeError) { throw new AggregateError([error, closeError], "Unaccepted product process duplicate did not close safely."); }
          throw error;
        }
      } };
    }, loadKernel: async () => {
      const api = await loadWindowsJobKernel();
      return {
        ...api,
        createAnonymousJob: () => {
          const full = api.createAnonymousJob();
          if (probe.restricted) {
            probe.fullJob = full;
            probe.job = probe.duplicate(full);
          } else probe.job = full;
          return probe.job;
        },
        terminate: job => {
          ++probe.terminateCalls;
          try { api.terminate(job); }
          catch (error) { probe.nativeError = error; throw error; }
        },
        clearKillOnClose: job => {
          api.clearKillOnClose(job); ++probe.releaseCalls;
          try { probe.releaseFlags = probe.readFlags(job); } catch (error) { probe.observationError = error; }
        },
        close: job => {
          ++probe.closeCalls;
          try { probe.closeFlags = probe.readFlags(job); } catch (error) { probe.observationError = error; }
          api.close(job);
        },
      };
    } });
    probe.command = command;
    command.stdout.once("end", () => { probe.stdoutEnded = true; });
    command.stderr.once("end", () => { probe.stderrEnded = true; });
    return command;
  };
  return { ...actual, spawnWindowsOwnedCommand };
});

type Member = { role: string; pid: number; birth: string; handle: unknown };
type Declaration = { pid: number; parentPid: number; birth: string };
type ActorFailure = { role: string; stage: string; name: string; code?: string | number };
const actorRoles = ["middle", "leaf", "pipe", "bystander"] as const;
const barrierMs = 10_000;
const script = path.resolve(import.meta.dirname, "../fixtures/git-owned-command-tree.mjs");
const environment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env: environment(), encoding: "utf8", timeout: 10_000, stdio: "pipe" });
const until = async (stage: string, check: () => boolean | Promise<boolean>, deadline = performance.now() + barrierMs): Promise<void> => {
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error(`Native repository Git fixture barrier ${stage} did not complete.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const shell = (value: string): string => JSON.stringify(value.replaceAll("\\", "/"));
const safeError = (error: unknown, ancestors: ReadonlySet<Error> = new Set()): Record<string, unknown> => {
  if (!(error instanceof Error)) return { nonErrorType: typeof error };
  if (ancestors.has(error)) return { name: error.name, referenceToAncestor: true };
  const result: Record<string, unknown> = { name: error.name };
  for (const key of ["code", "kind", "stage", "win32Code", "fixtureRole", "exitCode", "signal", "origin"] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number" || value === null) result[key] = value;
  }
  if (error instanceof RepositoryGitError) result.commandDeadlineExceeded = error.message.includes("Repository Git command deadline exceeded");
  const next = new Set(ancestors).add(error);
  if (error.cause !== undefined) result.cause = safeError(error.cause, next);
  if (error instanceof AggregateError) result.errors = error.errors.map(cause => safeError(cause, next));
  return result;
};
const actorFailures = (root: string): ActorFailure[] => actorRoles.flatMap(role => {
  const file = path.join(root, role + ".error.json");
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.role !== role || typeof value.stage !== "string" || typeof value.name !== "string" ||
      value.code !== undefined && typeof value.code !== "string" && typeof value.code !== "number") throw new Error(`Invalid native fixture ${role} error receipt.`);
  return [{ role, stage: value.stage, name: value.name, ...(value.code === undefined ? {} : { code: value.code as string | number }) }];
});
const failedObservation = (root: string, stage: string, members: readonly Member[], api: WindowsCommandJobKernel): Record<string, unknown> => {
  let actorErrors: unknown;
  try { actorErrors = actorFailures(root); } catch (error) { actorErrors = { observationError: safeError(error) }; }
  return { stage, actorErrors, members: members.map(member => {
    const beforeNs = process.hrtime.bigint().toString();
    try { return { role: member.role, pid: member.pid, birth: member.birth, signaled: api.signaled(member.handle), beforeNs, afterNs: process.hrtime.bigint().toString() }; }
    catch (error) { return { role: member.role, pid: member.pid, birth: member.birth, observationError: safeError(error), beforeNs, afterNs: process.hrtime.bigint().toString() }; }
  }), heartbeats: actorRoles.map(role => {
    const file = path.join(root, role + ".heartbeat");
    if (!existsSync(file)) return { role, present: false };
    try {
      const source = readFileSync(file, "utf8"), ticks = Number(source);
      return Number.isSafeInteger(ticks) && ticks > 0 && source === String(ticks) ? { role, present: true, ticks } : { role, present: true, valid: false };
    } catch (error) { return { role, observationError: safeError(error) }; }
  }) };
};
const assertLiveActors = (root: string, members: readonly Member[], api: WindowsCommandJobKernel, stage: string, liveRoles: readonly string[]): void => {
  const failures = actorFailures(root);
  if (failures.length) throw Object.assign(new Error(`Native fixture actor ${failures[0]!.role} failed at ${failures[0]!.stage}.`), { stage, fixtureRole: failures[0]!.role });
  for (const role of liveRoles) {
    const member = members.find(candidate => candidate.role === role);
    if (member === undefined) throw new Error(`Native fixture ${role} has not been captured before barrier ${stage}.`);
    if (api.signaled(member.handle)) throw Object.assign(new Error(`Native fixture ${role} exited before barrier ${stage}.`), { stage, fixtureRole: role });
  }
};

// These are actual Git invocations and native handles. The only injected value
// is the Job handle returned to the owner; termination itself is never mocked.
describe.skipIf(process.platform !== "win32")("native repository Git Job ownership", () => {
  let directory: string;
  let api: WindowsCommandJobKernel;
  let terminateProcess: (process: unknown, code: number) => number;
  let lastError: () => number;
  let duplicateJob: (job: unknown) => unknown;
  let readFlags: (job: unknown) => number;
  beforeAll(async () => {
    const scratch = path.resolve(import.meta.dirname, "../../../../.tmp");
    await mkdir(scratch, { recursive: true });
    directory = await mkdtemp(path.join(scratch, "repository-git-owned-native-"));
    api = await loadWindowsJobKernel();
    const koffi = await import("koffi"), kernel = koffi.load("kernel32.dll");
    terminateProcess = kernel.func("int __stdcall TerminateProcess(void *process, uint32_t code)");
    const current = kernel.func("void * __stdcall GetCurrentProcess()");
    const duplicate = kernel.func("int __stdcall DuplicateHandle(void *sourceProcess, void *source, void *targetProcess, void *target, uint32_t access, int inherit, uint32_t options)");
    lastError = kernel.func("uint32_t __stdcall GetLastError()");
    const query = kernel.func("int __stdcall QueryInformationJobObject(void *job, int kind, void *data, uint32_t size, void *returned)");
    const basic = koffi.struct({ PerProcessUserTimeLimit: "int64_t", PerJobUserTimeLimit: "int64_t", LimitFlags: "uint32_t", MinimumWorkingSetSize: "size_t", MaximumWorkingSetSize: "size_t", ActiveProcessLimit: "uint32_t", Affinity: "uintptr_t", PriorityClass: "uint32_t", SchedulingClass: "uint32_t" });
    const counters = koffi.struct({ ReadOperationCount: "uint64_t", WriteOperationCount: "uint64_t", OtherOperationCount: "uint64_t", ReadTransferCount: "uint64_t", WriteTransferCount: "uint64_t", OtherTransferCount: "uint64_t" });
    const extended = koffi.struct({ BasicLimitInformation: basic, IoInfo: counters, ProcessMemoryLimit: "size_t", JobMemoryLimit: "size_t", PeakProcessMemoryUsed: "size_t", PeakJobMemoryUsed: "size_t" });
    readFlags = job => {
      const output = Buffer.alloc(koffi.sizeof(extended)), returned = Buffer.alloc(4);
      if (!query(job, 9, output, output.length, returned)) throw new Error(`Native release policy observation failed (${lastError()}).`);
      if (returned.readUInt32LE() !== output.length) throw new Error("Native release policy observation returned an invalid size.");
      return output.readUInt32LE(koffi.offsetof(extended, "BasicLimitInformation") + koffi.offsetof(basic, "LimitFlags"));
    };
    duplicateJob = job => {
      const output = Buffer.alloc(koffi.sizeof("void *"));
      if (!duplicate(current(), job, current(), output, 0x00100007, 0, 0)) throw new Error(`Native restricted Job duplication failed (${lastError()}).`);
      return koffi.decode(output, "void *");
    };
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
  const terminateHeld = (member: Member): void => {
    if (api.signaled(member.handle)) return;
    if (!terminateProcess(member.handle, 1)) {
      const code = lastError();
      throw Object.assign(new Error(`Native Git fixture ${member.role} termination failed (Win32 ${code}).`),
        { stage: "fixture-terminate-process", fixtureRole: member.role, win32Code: code });
    }
  };

  const exercise = async (scenario: { kind: "fetch-stop" | "release" | "denied-stop"; code: number; allowExitOne?: boolean }): Promise<void> => {
    const root = await mkdtemp(path.join(directory, "Git 中文 "));
    const members: Member[] = [], events: unknown[] = [];
    const probe: Probe = { restricted: scenario.kind === "denied-stop", duplicate: duplicateJob, readFlags, terminateCalls: 0, releaseCalls: 0, closeCalls: 0, stdoutEnded: false, stderrEnded: false,
      observeRoot: (handle, expected) => {
        let accepted = false;
        try {
          if (probe.root !== undefined) throw new Error("Native Git fixture received more than one created root.");
          const identity = api.identity(handle);
          probe.createdRoot = { pid: expected.pid, birth: expected.birth.toString() };
          expect(identity.pid).toBe(expected.pid); expect(identity.birth).toBe(expected.birth);
          const root: Member = { role: "git", pid: identity.pid, birth: identity.birth.toString(), handle };
          members.push(root); probe.root = root; accepted = true;
          expect(api.contains(probe.job, handle)).toBe(true); expect(api.signaled(handle)).toBe(false);
        } catch (error) {
          if (!accepted) {
            try { api.closeProcess(handle); }
            catch (closeError) { throw new AggregateError([error, closeError], "Rejected original Git root observation did not close safely."); }
          }
          throw error;
        }
      } };
    boundary.probe = probe;
    const controller = new AbortController(), operation = createOperation({ signal: controller.signal, limits: { totalMs: 20_000 } });
    let pending: Promise<unknown> | undefined, primary: unknown;
    let returnedProduct: unknown, productReturned = false, rootReleased = false, expectedProductErrorAssertionsCompleted = false;
    let currentStage = "create-fixture";
    let bystander: ChildProcess | undefined, bystanderClosed = false;
    let bystanderError: unknown;
    const healthy = (liveRoles: readonly string[]): void => {
      if (bystanderError !== undefined) throw bystanderError;
      if (bystander !== undefined && bystanderClosed) throw new Error("Native fixture bystander exited before its live observation.");
      assertLiveActors(root, members, api, currentStage, liveRoles);
      if (!rootReleased && productReturned) throw new Error("Native Git returned before the controlled root was released.", returnedProduct instanceof Error ? { cause: returnedProduct } : undefined);
    };
    const barrier = async (stage: string, check: () => boolean | Promise<boolean>, liveRoles: readonly string[] = []): Promise<void> => {
      currentStage = stage;
      await until(stage, async () => { healthy(liveRoles); const ready = await check(); healthy(liveRoles); return ready; });
    };
    const capture = (role: string, pid: number, expectedBirth?: string): Member => {
      const handle = api.open(pid);
      if (handle === null) throw new Error("A native Git fixture disappeared before independent capture.");
      try {
        const identity = api.identity(handle);
        expect(identity.pid).toBe(pid);
        if (expectedBirth !== undefined) expect(identity.birth.toString()).toBe(expectedBirth);
        const member = { role, pid, birth: identity.birth.toString(), handle }; members.push(member);
        expect(api.signaled(handle)).toBe(false);
        return member;
      } catch (error) {
        if (!members.some(member => member.handle === handle)) api.closeProcess(handle);
        throw error;
      }
    };
    const declare = async (role: string): Promise<Member> => {
      const file = path.join(root, role + ".json");
      await barrier("declare-" + role, () => existsSync(file), members.filter(member => member.role === "git" || actorRoles.some(actor => actor === member.role)).map(member => member.role));
      const value = JSON.parse(await readFile(file, "utf8")) as Declaration;
      return capture(role, value.pid, value.birth);
    };
    const record = (stage: string, details?: unknown): void => {
      const receipt = probe.command?.result;
      events.push({ stage, atNs: process.hrtime.bigint().toString(), details, members: members.map(member => {
        const beforeNs = process.hrtime.bigint().toString(), signaled = api.signaled(member.handle);
        return { role: member.role, pid: member.pid, birth: member.birth, signaled, beforeNs, afterNs: process.hrtime.bigint().toString() };
      }),
        createdRoot: probe.createdRoot, target: receipt === undefined ? "pending" : receipt.kind === "exit" ? { kind: receipt.kind, code: receipt.code, signal: receipt.signal } : { kind: receipt.kind },
        terminateCalls: probe.terminateCalls, releaseCalls: probe.releaseCalls, closeCalls: probe.closeCalls,
        releaseFlags: probe.releaseFlags, closeFlags: probe.closeFlags, stdoutEnded: probe.stdoutEnded, stderrEnded: probe.stderrEnded });
    };
    try {
      bystander = spawn(process.execPath, [script, root, "bystander"], { cwd: directory, stdio: "ignore", detached: true, windowsHide: true });
      bystander.once("error", error => { bystanderError = error; });
      bystander.once("close", () => { bystanderClosed = true; });
      const unrelated = await declare("bystander");
      currentStage = "configure-real-git";
      git(root, ["init", "--initial-branch=main"]);
      const command = `${shell(process.execPath)} ${shell(script)} ${shell(root)} middle ${scenario.kind === "release" ? "background" : "fetch-pipe"} ${scenario.code}`;
      let args: string[];
      if (scenario.kind === "release") {
        git(root, ["config", "alias.daynight-background", "!" + command]);
        args = ["daynight-background"];
      } else {
        const origin = path.join(root, "origin.git");
        git(root, ["init", "--bare", origin]);
        git(root, ["remote", "add", "origin", origin]);
        git(root, ["config", "remote.origin.uploadpack", command]);
        args = ["fetch", "--no-tags", "origin", "main"];
      }
      currentStage = "start-owned-git";
      pending = runRepositoryGit(root, args, operation, { ...(scenario.allowExitOne === undefined ? {} : { allowExitOne: scenario.allowExitOne }), ...(scenario.kind === "denied-stop" ? { timeoutMs: 6_000 } : {}) })
        .then(result => { productReturned = true; returnedProduct = result; return result; }, (error: unknown) => { productReturned = true; returnedProduct = error; return error; });
      const middle = await declare("middle"), leaf = await declare("leaf");
      const pipe = scenario.kind === "release" ? undefined : await declare("pipe");
      currentStage = "verify-prepared-membership";
      expect(probe.job).toBeDefined();
      const leafMembership = api.contains(probe.job, leaf.handle);
      expect(leafMembership).toBe(true);
      expect(api.contains(probe.job, middle.handle)).toBe(true);
      expect(api.contains(probe.job, unrelated.handle)).toBe(false);
      if (pipe !== undefined) expect(api.contains(probe.job, pipe.handle)).toBe(true);
      const target = probe.root;
      expect(target).toBeDefined();
      const heartbeat = path.join(root, "leaf.heartbeat"), bystanderHeartbeat = path.join(root, "bystander.heartbeat");
      await barrier("initial-leaf-and-bystander-heartbeat-files", () => existsSync(heartbeat) && existsSync(bystanderHeartbeat), ["leaf", "bystander"]);
      currentStage = "initial-leaf-heartbeat-baseline";
      const before = Number(readFileSync(heartbeat, "utf8"));
      await barrier("initial-leaf-heartbeat-growth", () => Number(readFileSync(heartbeat, "utf8")) > before, ["leaf", "bystander"]);
      record("owned-live-before-root-release", { leafMembership, leafHeartbeat: { before, after: Number(readFileSync(heartbeat, "utf8")) } });
      currentStage = "release-original-root";
      writeFileSync(path.join(root, "leave-middle"), "release");
      rootReleased = true;
      await barrier("middle-and-original-git-exited", () => api.signaled(middle.handle) && api.signaled(target!.handle), ["leaf", "bystander"]);
      expect(api.signaled(leaf.handle)).toBe(false);
      currentStage = "after-root-exit-heartbeat-baseline";
      const running = Number(readFileSync(heartbeat, "utf8"));
      await barrier("leaf-heartbeat-after-root-exit", () => Number(readFileSync(heartbeat, "utf8")) > running, ["leaf", "bystander"]);
      const unrelatedBefore = Number(readFileSync(bystanderHeartbeat, "utf8"));
      if (scenario.kind === "release") {
        currentStage = "normal-product-return";
        const result = await pending;
        if (scenario.code === 0 || scenario.code === 1 && scenario.allowExitOne === true) expect(result).toMatchObject({ exitCode: scenario.code });
        else expect(result).toBeInstanceOf(RepositoryGitError);
        if (scenario.code !== 0 && !(scenario.code === 1 && scenario.allowExitOne === true)) expect(result).toMatchObject({ exitCode: scenario.code });
        expect(probe.command!.result).toMatchObject({ kind: "exit", code: scenario.code, failure: null });
        expect(probe.terminateCalls).toBe(0); expect(probe.releaseCalls).toBe(1); expect(probe.closeCalls).toBe(1);
        expect(probe.observationError).toBeUndefined();
        expect(probe.releaseFlags).toBeTypeOf("number"); expect(probe.releaseFlags! & 0x2000).toBe(0);
        expect(probe.closeFlags).toBeTypeOf("number"); expect(probe.closeFlags! & 0x2000).toBe(0);
        expect(probe.fullJob).toBeUndefined();
        expect(probe.stdoutEnded).toBe(true); expect(probe.stderrEnded).toBe(true);
        expect(api.signaled(leaf.handle)).toBe(false);
        const released = Number(readFileSync(heartbeat, "utf8"));
        await barrier("released-background-heartbeat", () => Number(readFileSync(heartbeat, "utf8")) > released, ["leaf", "bystander"]);
        expectedProductErrorAssertionsCompleted = result instanceof Error;
        record("normal-release-kept-background-alive", { leafHeartbeat: { before: released, after: Number(readFileSync(heartbeat, "utf8")) } });
      } else {
        const survivingMembership = api.contains(probe.fullJob ?? probe.job, leaf.handle);
        const survivingInventory = api.inspect(probe.fullJob ?? probe.job);
        expect(survivingMembership).toBe(true);
        expect(survivingInventory).toContain(leaf.pid);
        expect(api.signaled(pipe!.handle)).toBe(false);
        record("root-closed-with-live-leaf-and-pipe", { leafMembership: survivingMembership, inventory: survivingInventory, leafHeartbeat: { before: running, after: Number(readFileSync(heartbeat, "utf8")) } });
        const cancelled = performance.now();
        if (scenario.kind === "fetch-stop") controller.abort(new Error("Cancel the real Git fetch after its root exits"));
        currentStage = "stopped-product-return";
        const result = await pending;
        expect(probe.terminateCalls).toBe(1); expect(probe.releaseCalls).toBe(0); expect(probe.closeCalls).toBe(1);
        if (scenario.kind === "fetch-stop") {
          expect(result).toBe(operation.signal.reason);
          expect(performance.now() - cancelled).toBeLessThan(2500);
          expect(api.signaled(leaf.handle)).toBe(true); expect(api.signaled(pipe!.handle)).toBe(true);
          expect(probe.stdoutEnded).toBe(true); expect(probe.stderrEnded).toBe(true);
          expectedProductErrorAssertionsCompleted = true;
          record("stopped-owned-objects-before-fixture-cleanup");
        } else {
          expect(result).toBeInstanceOf(AggregateError);
          expect(probe.nativeError).toMatchObject({ name: "WindowsJobError", stage: "terminate-members", win32Code: 5 });
          expect((result as AggregateError).errors[0]).toBe(probe.nativeError);
          expect((result as AggregateError).cause).toBeInstanceOf(RepositoryGitError);
          expect(((result as AggregateError).cause as Error).message).toContain("Repository Git command deadline exceeded");
          expect(operation.signal.aborted).toBe(false);
          currentStage = "verify-native-denial-owned-survivors";
          expect(api.signaled(leaf.handle)).toBe(false);
          const retainedMembership = api.contains(probe.fullJob, leaf.handle), retainedActive = api.active(probe.fullJob);
          expect(retainedMembership).toBe(true); expect(retainedActive).toBeGreaterThan(0);
          const retained = Number(readFileSync(heartbeat, "utf8"));
          await barrier("native-denial-retained-leaf-heartbeat", () => Number(readFileSync(heartbeat, "utf8")) > retained, ["leaf", "pipe", "bystander"]);
          expectedProductErrorAssertionsCompleted = true;
          record("native-denial-retained-live-member-before-fixture-cleanup", { leafMembership: retainedMembership, jobActive: retainedActive,
            leafHeartbeat: { before: retained, after: Number(readFileSync(heartbeat, "utf8")) } });
        }
      }
      expect(api.signaled(unrelated.handle)).toBe(false);
      await barrier("bystander-heartbeat-before-cleanup", () => Number(readFileSync(bystanderHeartbeat, "utf8")) > unrelatedBefore,
        scenario.kind === "fetch-stop" ? ["bystander"] : ["leaf", "bystander"]);
      record("bystander-live-before-fixture-cleanup", { bystanderHeartbeat: { before: unrelatedBefore, after: Number(readFileSync(bystanderHeartbeat, "utf8")) } });
    } catch (error) {
      primary = error;
      events.push({ stage: "unexpected-fixture-failure-before-cleanup", atNs: process.hrtime.bigint().toString(), observation: failedObservation(root, currentStage, members, api),
        productReturned, returnedProductError: returnedProduct instanceof Error ? safeError(returnedProduct) : null });
      throw error;
    }
    finally {
      const cleanup: unknown[] = [];
      const cleanupFailures: unknown[] = [];
      const attempt = (stage: string, role: string | null, action: () => void): boolean => {
        try { action(); return true; }
        catch (error) { cleanup.push(error); cleanupFailures.push({ stage, role, error: safeError(error) }); return false; }
      };
      const productReturnedBeforeCleanup = productReturned;
      controller.abort(new Error("Clean up the native Git ownership fixture"));
      if (pending !== undefined) await pending;
      const cleanupDeadline = performance.now() + barrierMs;
      const owned = members.filter(member => member.role !== "bystander");
      const observedBystander = members.find(member => member.role === "bystander");
      if (observedBystander !== undefined) attempt("terminate-bystander", "bystander", () => terminateHeld(observedBystander));
      else if (bystander !== undefined && !bystanderClosed) attempt("terminate-original-bystander", "bystander", () => { bystander!.kill("SIGKILL"); });
      let fullJobRequestSucceeded = false, fullJobMembersJoined = false;
      if (probe.fullJob !== undefined && attempt("terminate-full-job", null, () => api.terminate(probe.fullJob))) {
        fullJobRequestSucceeded = true;
        try { await until("cleanup-full-job-owned-objects", () => owned.every(member => api.signaled(member.handle)), cleanupDeadline); fullJobMembersJoined = true; }
        catch (error) { cleanup.push(error); cleanupFailures.push({ stage: "cleanup-full-job-owned-objects", error: safeError(error), observation: failedObservation(root, "cleanup-full-job-owned-objects", members, api) }); }
      }
      // A successful Job termination request is asynchronous. Join its members
      // without issuing a second per-object request; fallback follows a failed request.
      // https://github.com/MicrosoftDocs/sdk-api/blob/656e9656bfaef34dd29cd7ee9e1146aec17e924c/sdk-api-src/content/processthreadsapi/nf-processthreadsapi-terminateprocess.md#L89-L95
      if (!fullJobRequestSucceeded) for (const member of owned) attempt("terminate-owned-object", member.role, () => terminateHeld(member));
      try {
        await until("cleanup-all-held-objects", () => members.every(member => api.signaled(member.handle)), cleanupDeadline);
        record(cleanup.length === 0 ? "fixture-cleanup-complete" : "fixture-cleanup-complete-with-errors");
      } catch (error) {
        cleanup.push(error); cleanupFailures.push({ stage: "cleanup-all-held-objects", error: safeError(error), observation: failedObservation(root, "cleanup-all-held-objects", members, api) });
      }
      if (bystander !== undefined) {
        try { await until("cleanup-bystander-close", () => bystanderClosed); }
        catch (error) { cleanup.push(error); cleanupFailures.push({ stage: "cleanup-bystander-close", role: "bystander", error: safeError(error), observation: failedObservation(root, "cleanup-bystander-close", members, api) }); }
      }
      for (const member of members) attempt("close-observation", member.role, () => api.closeProcess(member.handle));
      if (probe.fullJob !== undefined) attempt("close-full-job", null, () => api.close(probe.fullJob));
      if (bystanderError !== undefined) { cleanup.push(bystanderError); cleanupFailures.push({ stage: "bystander-process", role: "bystander", error: safeError(bystanderError) }); }
      operation.dispose(); boundary.probe = undefined;
      const returnedCause = returnedProduct instanceof Error ? returnedProduct.cause : undefined;
      const deadlineError = returnedProduct instanceof RepositoryGitError ? returnedProduct : returnedCause;
      console.error("WINDOWS_REPOSITORY_GIT_JOB_DIAGNOSTIC " + JSON.stringify({ scenario, primaryErrorMeaning: "unexpected-fixture-error", primaryError: primary === undefined ? null : String(primary),
        createdRoot: probe.createdRoot, productReturnedBeforeCleanup, returnedProductError: returnedProduct instanceof Error ? safeError(returnedProduct) : null,
        returnedProductCommandDeadlineExceeded: deadlineError instanceof RepositoryGitError && deadlineError.message.includes("Repository Git command deadline exceeded"),
        returnedProductFirstErrorIsNativeError: probe.nativeError !== undefined && returnedProduct instanceof AggregateError && returnedProduct.errors[0] === probe.nativeError,
        expectedProductErrorAssertionsCompleted, cleanupFullJobAvailable: probe.fullJob !== undefined,
        cleanupFullJobRequestSucceeded: fullJobRequestSucceeded, cleanupFullJobMembersJoined: fullJobMembersJoined,
        cleanupHeldFallbackSelected: !fullJobRequestSucceeded, cleanupErrors: cleanup.map(String), cleanupFailures, events }));
      if (cleanup.length !== 0) throw new AggregateError(primary === undefined ? cleanup : [primary, ...cleanup], "Native Git ownership fixture cleanup failed.");
    }
  };

  const qualifyCliExit = async (profile: "direct" | "owned"): Promise<void> => {
    const root = await mkdtemp(path.join(directory, "cli-exit-")), members: Member[] = [], events: unknown[] = [];
    const ownerScript = path.resolve(import.meta.dirname, "../fixtures/git-owned-command-cli.mjs");
    let owner: ChildProcess | undefined, ownerClosed = false, runRequested = false, ownerError: unknown, primary: unknown;
    let ownerResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let currentStage = "create-cli-fixture";
    const barrier = async (stage: string, check: () => boolean | Promise<boolean>, liveRoles: readonly string[] = []): Promise<void> => {
      currentStage = stage;
      await until(stage, async () => {
        if (ownerError !== undefined) throw ownerError;
        assertLiveActors(root, members, api, stage, liveRoles);
        const ready = await check();
        assertLiveActors(root, members, api, stage, liveRoles);
        return ready;
      });
    };
    const capture = (role: string, requireLive = true): Member => {
      const value = JSON.parse(readFileSync(path.join(root, role + ".json"), "utf8")) as Declaration;
      const handle = api.open(value.pid);
      if (handle === null) throw new Error("CLI background fixture disappeared before independent capture.");
      try {
        const identity = api.identity(handle);
        expect(identity.pid).toBe(value.pid); expect(identity.birth.toString()).toBe(value.birth);
        if (role === "cli") expect(identity.parentPid).toBe(process.pid);
        if (requireLive) expect(api.signaled(handle)).toBe(false);
        const member = { role, pid: identity.pid, birth: identity.birth.toString(), handle }; members.push(member);
        return member;
      } catch (error) {
        try { api.closeProcess(handle); }
        catch (closeError) { throw new AggregateError([error, closeError], "Rejected CLI fixture observation did not close safely."); }
        throw error;
      }
    };
    const declared = async (role: string): Promise<Member> => {
      await barrier("cli-declare-" + role, () => {
        if (existsSync(path.join(root, role + ".json"))) return true;
        if (ownerClosed) throw new Error("The CLI fixture closed before publishing its controlled process identity.", { cause: ownerError });
        return false;
      });
      return capture(role);
    };
    const record = (stage: string, details?: unknown): void => {
      events.push({ stage, atNs: process.hrtime.bigint().toString(), details, members: members.map(member => {
        const beforeNs = process.hrtime.bigint().toString(), signaled = api.signaled(member.handle);
        return { role: member.role, pid: member.pid, birth: member.birth, signaled, beforeNs, afterNs: process.hrtime.bigint().toString() };
      }) });
    };
    try {
      git(root, ["init", "--initial-branch=main"]);
      git(root, ["config", "alias.daynight-background", `!${shell(process.execPath)} ${shell(script)} ${shell(root)} middle background 0`]);
      // The test owner must not join this Vitest Node's kill-on-close Job. Both
      // profiles retain the same ambient OS Job policy and acquire no extra Job handle.
      owner = spawn(process.execPath, [ownerScript, root, profile], { cwd: directory, env: environment(), detached: true, windowsHide: true, stdio: "ignore" });
      owner.once("close", (code, signal) => { ownerResult = { code, signal }; ownerClosed = true; }); owner.once("error", error => { ownerError = error; });
      const cli = await declared("cli");
      writeFileSync(path.join(root, "run-cli"), "release");
      runRequested = true;
      const middle = await declared("middle"), leaf = await declared("leaf");
      const heartbeat = path.join(root, "leaf.heartbeat"); await barrier("cli-leaf-heartbeat-file", () => existsSync(heartbeat), ["leaf", "cli"]);
      const started = Number(readFileSync(heartbeat, "utf8"));
      await barrier("cli-initial-leaf-heartbeat-growth", () => Number(readFileSync(heartbeat, "utf8")) > started, ["leaf", "cli"]);
      writeFileSync(path.join(root, "leave-middle"), "release");
      const resultFile = path.join(root, "cli-result.json"); await barrier("cli-product-result", () => existsSync(resultFile), ["leaf", "cli"]);
      const result = JSON.parse(readFileSync(resultFile, "utf8")) as { profile: string; kind: string; exitCode?: number; signal?: string | null };
      expect(result).toEqual({ profile, kind: "completed", exitCode: 0, signal: null });
      expect(api.signaled(cli.handle)).toBe(false); expect(api.signaled(leaf.handle)).toBe(false);
      await barrier("cli-middle-exited", () => api.signaled(middle.handle), ["leaf", "cli"]);
      record("normal-git-completed-before-cli-exit", { target: result });
      writeFileSync(path.join(root, "exit-cli"), "release");
      await barrier("cli-owner-exited", () => api.signaled(cli.handle) && ownerClosed, ["leaf"]);
      expect(ownerResult).toEqual({ code: 0, signal: null });
      const afterCliExit = Number(readFileSync(heartbeat, "utf8")); let advanced = afterCliExit;
      await barrier("cli-background-heartbeat-after-owner-exit", () => {
        expect(api.signaled(cli.handle)).toBe(true); expect(api.signaled(leaf.handle)).toBe(false);
        const observed = Number(readFileSync(heartbeat, "utf8"));
        if (observed <= afterCliExit) return false;
        advanced = observed; return true;
      }, ["leaf"]);
      record("background-writing-after-original-cli-object-exited-before-fixture-cleanup", { cli: ownerResult, leafHeartbeat: { before: afterCliExit, after: advanced } });
    } catch (error) {
      primary = error;
      events.push({ stage: "unexpected-fixture-failure-before-cleanup", atNs: process.hrtime.bigint().toString(), observation: failedObservation(root, currentStage, members, api) });
      throw error;
    }
    finally {
      const cleanup: unknown[] = [];
      const attempt = (action: () => void): void => { try { action(); } catch (error) { cleanup.push(error); } };
      for (const role of ["cli", "middle", "leaf"]) {
        if (!members.some(member => member.role === role) && existsSync(path.join(root, role + ".json"))) attempt(() => { capture(role, false); });
      }
      if (owner !== undefined && !ownerClosed) attempt(() => { owner!.kill("SIGKILL"); });
      for (const member of members) attempt(() => terminateHeld(member));
      if (runRequested && ["cli", "middle", "leaf"].some(role => !members.some(member => member.role === role))) cleanup.push(new Error("The CLI fixture identity inventory is incomplete; background cleanup remains unconfirmed."));
      try { await until("cli-fixture-cleanup", () => members.every(member => api.signaled(member.handle)) && (owner === undefined || ownerClosed)); record(cleanup.length === 0 ? "fixture-cleanup-complete" : "fixture-cleanup-unconfirmed"); }
      catch (error) { cleanup.push(error); events.push({ stage: "fixture-cleanup-failure", observation: failedObservation(root, "cli-fixture-cleanup", members, api) }); }
      for (const member of members) attempt(() => api.closeProcess(member.handle));
      if (ownerError !== undefined) cleanup.push(ownerError);
      console.error("WINDOWS_REPOSITORY_GIT_CLI_EXIT_DIAGNOSTIC " + JSON.stringify({ profile, primaryError: primary === undefined ? null : String(primary), cleanupErrors: cleanup.map(String), events }));
      if (cleanup.length) throw new AggregateError(primary === undefined ? cleanup : [primary, ...cleanup], "Native CLI background fixture cleanup failed.");
    }
  };

  it.each(["direct", "owned"] as const)("keeps a normal Git background member alive after its %s CLI owner exits", async profile => qualifyCliExit(profile), 30_000);

  it("stops real fetch descendants after the Git root and uploadpack exit while a pipe remains inherited", async () => exercise({ kind: "fetch-stop", code: 0 }), 30_000);
  it.each([{ code: 0 }, { code: 1, allowExitOne: true }, { code: 7 }, { code: 128 }])("releases a normal Git exit $code without killing its background member", async scenario => exercise({ kind: "release", ...scenario }), 30_000);
  it("preserves a real native termination denial and command deadline while its independently owned descendant survives", async () => exercise({ kind: "denied-stop", code: 0 }), 30_000);
});
