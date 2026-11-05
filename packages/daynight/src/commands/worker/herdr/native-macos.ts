import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Operation } from "../../../api/operation.js";
import type { MacProcessIdentity } from "./lifecycle-types.js";

export type MacProcessObservation = "same" | "exited" | "changed" | "unknown";
export type MacProcessSignal = "SIGSTOP" | "SIGCONT" | "SIGKILL" | "SIGTERM" | "SIGHUP";
export type MacSignalResult = "sent" | Exclude<MacProcessObservation, "same">;
export type MacProcessSample = Omit<MacProcessIdentity, "role"> & { state: "running" | "stopped" };
export type MacProcessScope = { rootPids: readonly number[]; sessionIds: readonly number[] };
export type MacProcessKernel = {
  bootId(): Promise<string>;
  read(pid: number): Promise<MacProcessSample | null>;
  executable(pid: number): Promise<string>;
  list(scope?: MacProcessScope): Promise<MacProcessSample[]>;
  peer(endpoint: string): Promise<{ pid: number; auditToken: number[] }>;
  signal(auditToken: readonly number[], signal: number): Promise<number>;
};
export type MacExclusiveStopInput = {
  daemon: MacProcessIdentity;
  processes: readonly MacProcessIdentity[];
  onDiscovered?: (identity: MacProcessIdentity) => Promise<void>;
};
export type MacExclusiveStopResult = { state: "stopped_confirmed" | "stop_unknown"; processes: MacProcessIdentity[]; method?: "instances_exited" | "boot_changed"; reason?: string };
const signals: Record<MacProcessSignal, number> = { SIGSTOP: 17, SIGCONT: 19, SIGKILL: 9, SIGTERM: 15, SIGHUP: 1 };
const pidValid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff;
const tokenValid = (token: readonly number[], pid: number): boolean => token.length === 8 && token.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff) && token[5] === pid;
const sameToken = (left: readonly number[], right: readonly number[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
const same = (left: MacProcessIdentity | MacProcessSample, right: MacProcessIdentity | MacProcessSample): boolean => left.pid === right.pid && left.bootId === right.bootId && left.birthToken === right.birthToken && sameToken(left.auditToken, right.auditToken);
const identityOf = (sample: MacProcessSample, role: MacProcessIdentity["role"]): MacProcessIdentity => ({ pid: sample.pid, role, birthToken: sample.birthToken, bootId: sample.bootId, auditToken: [...sample.auditToken], ppid: sample.ppid, pgid: sample.pgid, sid: sample.sid });
const validate = (identity: MacProcessIdentity): void => {
  if (!pidValid(identity.pid) || !tokenValid(identity.auditToken, identity.pid) || !identity.bootId || !/^\d+:\d+$/.test(identity.birthToken) || !["daemon", "shell", "agent"].includes(identity.role)) throw new Error("The original macOS process identity is invalid.");
};
const bornAfter = (child: MacProcessIdentity | MacProcessSample, parent: MacProcessIdentity): boolean => {
  const [childSeconds, childMicros] = child.birthToken.split(":"), [parentSeconds, parentMicros] = parent.birthToken.split(":");
  if (childSeconds === undefined || childMicros === undefined || parentSeconds === undefined || parentMicros === undefined) return false;
  return BigInt(childSeconds) * 1_000_000n + BigInt(childMicros) >= BigInt(parentSeconds) * 1_000_000n + BigInt(parentMicros);
};

// A task name port exposes the audit token without requesting a task control port.
// Signal delivery resolves and retains the exact process identity inside the kernel:
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c#L3564
const loadKernel = async (): Promise<MacProcessKernel> => {
  const koffi = await import("koffi");
  const library = koffi.load("/usr/lib/libSystem.B.dylib");
  const pidInfo = library.func("int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size)");
  const pidPath = library.func("int proc_pidpath(int pid, void *buffer, uint32_t size)");
  const listPids = library.func("int proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int size)");
  const taskName = library.func("int task_name_for_pid(uint32_t task, int pid, void *port)");
  const taskInfo = library.func("int task_info(uint32_t port, int flavor, void *token, void *count)");
  const deallocate = library.func("int mach_port_deallocate(uint32_t task, uint32_t port)");
  const self = koffi.decode(library.symbol("mach_task_self_"), "uint32_t") as number;
  const getSid = library.func("int getsid(int pid)");
  const sysctl = library.func("int sysctlbyname(const char *name, void *out, void *size, void *input, size_t inputsize)");
  const signalToken = library.func("int proc_signal_with_audittoken(void *token, int signal)");
  const errorPointer = library.func("void *__error(void)");
  const error = (): number => koffi.decode(errorPointer(), "int") as number;
  const socket = library.func("int socket(int domain, int type, int protocol)");
  const connect = library.func("int connect(int fd, void *address, uint32_t size)");
  const fcntl = library.func("int fcntl(int fd, int command, int flags)");
  const poll = library.func("int poll(void *fds, uint32_t count, int timeout)");
  const getsockopt = library.func("int getsockopt(int fd, int level, int option, void *out, void *size)");
  const close = library.func("int close(int fd)");
  const uint32 = (value: number): Buffer => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; };
  const bootId = (): string => {
    const buffer = Buffer.alloc(256), size = Buffer.alloc(8); size.writeBigUInt64LE(256n);
    if (sysctl("kern.bootsessionuuid", buffer, size, null, 0) !== 0) throw new Error("Cannot inspect the macOS boot identity.");
    const value = buffer.subarray(0, buffer.indexOf(0)).toString("utf8");
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new Error("The macOS boot identity is invalid.");
    return value;
  };
  const bsd = (pid: number): Buffer | null => {
    const buffer = Buffer.alloc(136), result = pidInfo(pid, 3, 0, buffer, buffer.length);
    if (result !== buffer.length) {
      if (result === 0 && error() === 3) return null;
      throw new Error(`Cannot inspect macOS process ${pid}.`);
    }
    if (buffer.readUInt32LE(12) !== pid) throw new Error("The macOS process observation has a different PID.");
    // Darwin SZOMB: execution has ended and the descriptor table is closed.
    return buffer.readUInt32LE(4) === 5 ? null : buffer;
  };
  const audit = (pid: number): number[] => {
    const portBuffer = Buffer.alloc(4);
    if (taskName(self, pid, portBuffer) !== 0) throw new Error(`Cannot acquire the name port for macOS process ${pid}.`);
    const port = portBuffer.readUInt32LE();
    if (port === 0) throw new Error("The macOS task name port is absent.");
    try {
      const token = Buffer.alloc(32), count = uint32(8);
      if (taskInfo(port, 15, token, count) !== 0 || count.readUInt32LE() !== 8) throw new Error(`Cannot inspect the audit token for macOS process ${pid}.`);
      const values = Array.from({ length: 8 }, (_, index) => token.readUInt32LE(index * 4));
      if (!tokenValid(values, pid)) throw new Error("The macOS audit token does not identify the observed process.");
      return values;
    } finally { deallocate(self, port); }
  };
  const birth = (buffer: Buffer): string => `${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}`;
  const read = (pid: number): MacProcessSample | null => {
    if (!pidValid(pid)) throw new Error("A macOS process PID must be a positive integer.");
    const boot = bootId(), before = bsd(pid);
    if (before === null) return null;
    try {
      const token = audit(pid), sid = getSid(pid) as number, after = bsd(pid);
      if (after === null) return null;
      if (sid <= 0 || birth(before) !== birth(after) || !sameToken(token, audit(pid)) || boot !== bootId()) throw new Error("The macOS process identity changed during inspection.");
      return { pid, birthToken: birth(after), bootId: boot, auditToken: token, ppid: after.readUInt32LE(16), pgid: after.readUInt32LE(100), sid, state: after.readUInt32LE(4) === 4 ? "stopped" : "running" };
    } catch (cause) {
      if (bsd(pid) === null) return null;
      throw cause;
    }
  };
  const peer = (endpoint: string): { pid: number; auditToken: number[] } => {
    const path = Buffer.from(endpoint, "utf8");
    if (path.length === 0 || path.length > 103 || path.includes(0)) throw new Error("The macOS local socket path is invalid.");
    const address = Buffer.alloc(106); address[0] = path.length + 3; address[1] = 1; path.copy(address, 2);
    const fd = socket(1, 1, 0) as number;
    if (fd < 0) throw new Error("Cannot create a macOS peer identity socket.");
    try {
      if (fcntl(fd, 4, 4) < 0) throw new Error("Cannot bound the macOS peer identity connection.");
      if (connect(fd, address, path.length + 3) !== 0) {
        if (![35, 36].includes(error())) throw new Error("Cannot connect to the original Herdr endpoint.");
        const descriptor = Buffer.alloc(8); descriptor.writeInt32LE(fd); descriptor.writeInt16LE(4, 4);
        if (poll(descriptor, 1, 1000) <= 0) throw new Error("The macOS peer identity connection timed out.");
        const result = Buffer.alloc(4), size = uint32(4);
        if (getsockopt(fd, 0xffff, 0x1007, result, size) !== 0 || result.readInt32LE() !== 0) throw new Error("The macOS peer identity connection failed.");
      }
      const pidBuffer = Buffer.alloc(4), pidSize = uint32(4), token = Buffer.alloc(32), tokenSize = uint32(32);
      if (getsockopt(fd, 0, 2, pidBuffer, pidSize) !== 0 || getsockopt(fd, 0, 6, token, tokenSize) !== 0 || pidSize.readUInt32LE() !== 4 || tokenSize.readUInt32LE() !== 32) throw new Error("Cannot inspect the original Herdr socket peer.");
      const pid = pidBuffer.readInt32LE(), auditToken = Array.from({ length: 8 }, (_, index) => token.readUInt32LE(index * 4));
      if (!pidValid(pid) || !tokenValid(auditToken, pid)) throw new Error("The Herdr socket peer identity is invalid.");
      return { pid, auditToken };
    } finally { close(fd); }
  };
  return {
    bootId: async () => bootId(), read: async pid => read(pid), peer: async endpoint => peer(endpoint),
    executable: async pid => {
      const buffer = Buffer.alloc(4096), length = pidPath(pid, buffer, buffer.length) as number;
      const end = buffer.indexOf(0);
      if (length <= 0 || end <= 0 || end >= buffer.length || buffer[0] !== 47) throw new Error("Cannot inspect the macOS process executable image.");
      return buffer.subarray(0, end).toString("utf8");
    },
    list: async scope => {
      const ids = (type: number, value: number): number[] => {
        for (let capacity = 4096; capacity <= 65536; capacity *= 2) {
          const buffer = Buffer.alloc(capacity * 4);
          koffi.encode(errorPointer(), "int", 0);
          const size = listPids(type, value, buffer, buffer.length) as number;
          if (size < 0 || (size === 0 && error() !== 0) || size % 4 !== 0) throw new Error("Cannot enumerate the original macOS process scope.");
          if (size >= buffer.length) continue;
          return Array.from({ length: size / 4 }, (_, index) => buffer.readInt32LE(index * 4)).filter(pid => pid > 0);
        }
        throw new Error("The macOS process enumeration exceeds its supported bound.");
      };
      const selected = new Set<number>();
      if (scope) {
        for (const pid of scope.rootPids) selected.add(pid);
        // getsid permits inspecting other users' session membership without a task
        // port. A privileged descendant must not disappear behind a UID filter.
        for (const pid of ids(1, 0)) {
          const sid = getSid(pid) as number;
          if (sid <= 0) { if (error() === 3) continue; throw new Error("Cannot inspect process session membership."); }
          if (scope.sessionIds.includes(sid)) selected.add(pid);
        }
        const queue = [...selected];
        for (let index = 0; index < queue.length; index++) {
          if (queue.length > 65536) throw new Error("The original process tree exceeds its supported bound.");
          for (const pid of ids(6, queue[index]!)) if (!selected.has(pid)) { selected.add(pid); queue.push(pid); }
        }
      } else {
        const uid = process.getuid?.();
        if (uid === undefined) throw new Error("The macOS user identity is unavailable.");
        for (const pid of ids(4, uid)) selected.add(pid);
      }
      // Do not request protected task ports outside the recorded scope. A denied
      // BSD or task-port read inside that scope remains an error, never absence.
      const result: MacProcessSample[] = [];
      for (const pid of selected) { const sample = read(pid); if (sample !== null) result.push(sample); }
      return result;
    },
    signal: async (token, signal) => {
      const buffer = Buffer.alloc(32); token.forEach((value, index) => buffer.writeUInt32LE(value, index * 4));
      return signalToken(buffer, signal) as number;
    },
  };
};

export const createMacProcessControl = (options: { kernel?: MacProcessKernel; platform?: NodeJS.Platform } = {}) => {
  let loaded: Promise<MacProcessKernel> | undefined;
  const kernel = (): Promise<MacProcessKernel> => {
    if ((options.platform ?? process.platform) !== "darwin") return Promise.reject(new Error("Original Herdr process control requires macOS."));
    return loaded ??= options.kernel ? Promise.resolve(options.kernel) : loadKernel();
  };
  const capture = async (pid: number, role: MacProcessIdentity["role"], expected?: { executable: string; operation: Operation; ready: () => Promise<boolean> }): Promise<MacProcessIdentity> => {
    const access = await kernel(), boot = await access.bootId();
    if (expected) {
      let original: MacProcessSample | undefined;
      const wait = async (): Promise<void> => { expected.operation.check(); await delay(10, undefined, { signal: expected.operation.signal }); };
      const validateBirth = (sample: MacProcessSample | null): MacProcessSample => {
        if (sample === null) throw new Error("The prepared shell exited before identity registration.");
        if (sample.pid !== pid || sample.bootId !== boot || original && sample.birthToken !== original.birthToken) throw new Error("The prepared shell was replaced before identity registration.");
        original ??= sample;
        return sample;
      };
      for (;;) {
        expected.operation.check();
        let first: MacProcessSample | null;
        try { first = await access.read(pid); }
        catch { await wait(); continue; }
        validateBirth(first);
        const ready = await expected.ready();
        let acknowledged: MacProcessSample | null;
        try { acknowledged = await access.read(pid); }
        catch { await wait(); continue; }
        const before = validateBirth(acknowledged);
        if (!ready) { await wait(); continue; }
        let executable: string, last: MacProcessSample | null;
        try { executable = await access.executable(pid); last = await access.read(pid); }
        catch { await wait(); continue; }
        const after = validateBirth(last);
        // The final shell must acknowledge from user space before image capture:
        // kernel executable metadata can become visible during an unfinished exec.
        if (executable === expected.executable && same(before, after)) {
          expected.operation.check();
          const result = identityOf(after, role); validate(result); return result;
        }
        await wait();
      }
    }
    const sample = await access.read(pid);
    if (sample === null || boot !== sample.bootId) throw new Error("The original macOS process cannot be captured.");
    const result = identityOf(sample, role); validate(result); return result;
  };
  const observe = async (identity: MacProcessIdentity): Promise<MacProcessObservation> => {
    try {
      validate(identity); const access = await kernel();
      if (await access.bootId() !== identity.bootId) return "exited";
      const current = await access.read(identity.pid);
      return current === null ? "exited" : same(identity, current) ? "same" : "changed";
    } catch { return "unknown"; }
  };
  const signal = async (identity: MacProcessIdentity, value: MacProcessSignal): Promise<MacSignalResult> => {
    try {
      const before = await observe(identity); if (before !== "same") return before;
      const code = await (await kernel()).signal(identity.auditToken, signals[value]);
      if (code === 0) return "sent";
      if (code === 3) { const after = await observe(identity); return after === "same" ? "unknown" : after; }
      return "unknown";
    } catch { return "unknown"; }
  };
  const list = async (scope?: MacProcessScope): Promise<MacProcessIdentity[]> => (await (await kernel()).list(scope)).map(sample => identityOf(sample, "agent"));
  const stopExclusiveRun = async (input: MacExclusiveStopInput, operation: Operation): Promise<MacExclusiveStopResult> => {
    const processes = input.processes.map(value => structuredClone(value));
    const frozenHere: MacProcessIdentity[] = [];
    const known = new Map<number, MacProcessIdentity>();
    let completed = false;
    try {
      validate(input.daemon);
      if (input.daemon.role !== "daemon" || processes.some(value => value.role === "daemon") || !processes.some(value => value.role === "shell")) throw new Error("An exclusive run requires its original daemon and shell identities.");
      for (const value of [input.daemon, ...processes]) { validate(value); if (known.has(value.pid) || value.bootId !== input.daemon.bootId) throw new Error("The original run process identities conflict."); known.set(value.pid, value); }
      const access = await kernel();
      operation.check();
      if (await access.bootId() !== input.daemon.bootId) { completed = true; return { state: "stopped_confirmed", processes, method: "boot_changed" }; }
      const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
        const deadline = performance.now() + Math.min(1500, operation.remainingMs());
        do { operation.check(); if (await check()) return; await delay(10); } while (performance.now() < deadline);
        throw new Error("The original process did not reach its expected state within the stop deadline.");
      };
      const freeze = async (identity: MacProcessIdentity): Promise<void> => {
        operation.check(); const observed = await observe(identity);
        if (observed === "exited") return;
        if (observed !== "same") throw new Error("The original process identity cannot authorize stopping.");
        const before = await access.read(identity.pid);
        if (before === null) return;
        if (!same(identity, before)) throw new Error("The original process was replaced before freezing.");
        if (before.state !== "stopped") {
          const sent = await signal(identity, "SIGSTOP");
          if (sent === "exited") return;
          if (sent !== "sent") throw new Error("The original process freeze was not confirmed.");
          frozenHere.push(identity);
        }
        await waitFor(async () => {
          const current = await access.read(identity.pid);
          if (current === null) return true;
          if (!same(identity, current)) throw new Error("The process identity changed during freezing.");
          return current.state === "stopped";
        });
      };
      await freeze(input.daemon);
      for (const identity of [...processes.filter(value => value.role === "shell"), ...processes.filter(value => value.role === "agent")]) await freeze(identity);
      const relevant = (samples: MacProcessSample[]): MacProcessSample[] => {
        const sessionIds = new Set([input.daemon.sid, ...processes.filter(value => value.role === "shell").map(value => value.sid)]);
        const ids = new Set(samples.filter(value => known.has(value.pid)).map(value => value.pid));
        let changed = true;
        while (changed) { changed = false; for (const value of samples) if (ids.has(value.ppid) && !ids.has(value.pid)) { ids.add(value.pid); changed = true; } }
        return samples.filter(value => ids.has(value.pid) || sessionIds.has(value.sid));
      };
      const scope = (): MacProcessScope => ({ rootPids: [...known.keys()], sessionIds: [input.daemon.sid, ...processes.filter(value => value.role === "shell").map(value => value.sid)] });
      let stable = false;
      for (let round = 0; round < 1000; round++) {
        operation.check(); const samples = relevant(await access.list(scope())); operation.check();
        const pending: MacProcessSample[] = [];
        for (const sample of samples) {
          const original = known.get(sample.pid);
          if (original) { if (!same(original, sample) || sample.state !== "stopped") throw new Error("An original run process changed after freezing."); }
          else pending.push(sample);
        }
        if (pending.length === 0) { stable = true; break; }
        const child = pending.find(sample => {
          const parent = known.get(sample.ppid);
          return parent?.role === "agent" && samples.some(value => value.pid === parent.pid && same(parent, value) && value.state === "stopped") && bornAfter(sample, parent);
        });
        if (!child || !input.onDiscovered || processes.length >= 1000) throw new Error(`The original terminal has resources without a durable, continuous native-parent identity: ${pending.map(value => `${value.pid} (parent ${value.ppid}, session ${value.sid})`).join(", ")}.`);
        const parent = known.get(child.ppid)!;
        if (await observe(parent) !== "same") throw new Error("The original descendant parent identity changed.");
        const current = await capture(child.pid, "agent");
        if (!same(current, child) || current.ppid !== parent.pid || await observe(parent) !== "same") throw new Error("The observed descendant ancestry changed before registration.");
        await input.onDiscovered(current);
        processes.push(current); known.set(current.pid, current);
        await freeze(current);
      }
      if (!stable) throw new Error("The exclusive run process tree did not stabilize within its supported bound.");
      operation.check();
      // The daemon must die first: its ordinary close/drop code rediscovers PIDs.
      // This operation is valid only for a daemon dedicated to this recorded run.
      for (const identity of [input.daemon, ...processes.toReversed()]) {
        operation.check(); const result = await signal(identity, "SIGKILL");
        if (result !== "sent" && result !== "exited") throw new Error("The original process stop could not be confirmed.");
        await waitFor(async () => {
          const state = await observe(identity);
          if (state === "changed" || state === "unknown") throw new Error("The stopped process identity became uncertain.");
          return state === "exited";
        });
      }
      if (relevant(await access.list(scope())).length !== 0) throw new Error("The original terminal still has unresolved process resources.");
      completed = true;
      return { state: "stopped_confirmed", processes, method: "instances_exited" };
    } catch (cause) {
      return { state: "stop_unknown", processes, reason: cause instanceof Error ? cause.message : "The original run stop remains unknown." };
    } finally {
      if (!completed) {
        // Cancellation cannot skip rollback, and a replacement must never receive SIGCONT.
        for (const identity of frozenHere.toReversed()) await signal(identity, "SIGCONT");
      }
    }
  };
  return { bootIdentity: async (): Promise<string> => (await kernel()).bootId(), capture, observe, list, signal, stopExclusiveRun, peer: async (endpoint: string): Promise<MacProcessIdentity> => {
    const peer = await (await kernel()).peer(endpoint), identity = await capture(peer.pid, "daemon");
    if (!sameToken(peer.auditToken, identity.auditToken)) throw new Error("The Herdr socket peer changed during identity capture.");
    return identity;
  } };
};
export type MacProcessControl = ReturnType<typeof createMacProcessControl>;
