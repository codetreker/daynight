import { afterEach, describe, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { createMacProcessControl } from "../../../src/commands/worker/herdr/native-macos.js";
import type { MacProcessKernel, MacProcessSample } from "../../../src/commands/worker/herdr/native-macos.js";
import type { MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";

const operations: Operation[] = [];
const op = () => { const value = createOperation({ limits: { totalMs: 2000 } }); operations.push(value); return value; };
afterEach(() => operations.splice(0).forEach(value => value.dispose()));
const identity = (pid: number, role: MacProcessIdentity["role"], ppid: number, sid = 20): MacProcessIdentity => ({ pid, role, ppid, pgid: pid, sid, birthToken: `100:${pid}`, bootId: "boot-a", auditToken: [501, 501, 20, 501, 20, pid, 1, pid + 100] });
const daemon = identity(10, "daemon", 1, 10), shell = identity(20, "shell", 10), agent = identity(30, "agent", 20);
const fixture = () => {
  const live = new Map<number, MacProcessSample>();
  for (const value of [daemon, shell, agent]) live.set(value.pid, { ...structuredClone(value), state: "running" });
  const calls: { pid: number; signal: number }[] = [];
  let boot = "boot-a";
  const hooks: { list?: () => void; signal?: (pid: number, signal: number) => void; read?: (pid: number) => void } = {};
  const kernel: MacProcessKernel = {
    bootId: async () => boot,
    executable: async () => "/bin/bash",
    read: async pid => { hooks.read?.(pid); return structuredClone(live.get(pid) ?? null); },
    list: async () => { hooks.list?.(); return [...live.values()].map(value => structuredClone(value)); },
    peer: async () => ({ pid: daemon.pid, auditToken: [...daemon.auditToken] }),
    signal: async (token, signal) => {
      const pid = token[5]!; hooks.signal?.(pid, signal);
      const value = live.get(pid);
      if (!value || value.auditToken.some((field, index) => token[index] !== field)) return 3;
      calls.push({ pid, signal });
      if (signal === 17) value.state = "stopped";
      if (signal === 19) value.state = "running";
      if (signal === 9) live.delete(pid);
      return 0;
    },
  };
  return { live, calls, hooks, kernel, control: createMacProcessControl({ kernel, platform: "darwin" }), reboot: () => { boot = "boot-b"; } };
};

describe("macOS original process identities", () => {
  it("does not capture a stable final image before its user-space readiness acknowledgement", async () => {
    const f = fixture(); let checks = 0;
    const ready = async () => {
      if (++checks < 3) return false;
      f.live.get(20)!.auditToken[7] = 1000;
      return true;
    };
    const captured = await f.control.capture(20, "shell", { executable: "/bin/bash", operation: op(), ready });
    expect(checks).toBeGreaterThanOrEqual(3); expect(captured.auditToken[7]).toBe(1000);
  });
  it("rejects PID replacement across a readiness callback even when the marker matches", async () => {
    const f = fixture();
    const ready = async () => { f.live.get(20)!.birthToken = "102:20"; return true; };
    await expect(f.control.capture(20, "shell", { executable: "/bin/bash", operation: op(), ready })).rejects.toThrow("replaced");
    expect(f.calls).toEqual([]);
  });
  it("keeps an absent user-space acknowledgement bounded even when the final image is visible", async () => {
    const f = fixture();
    const operation = createOperation({ limits: { totalMs: 40 } }); operations.push(operation);
    await expect(f.control.capture(20, "shell", { executable: "/bin/bash", operation, ready: async () => false })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("waits for the final managed shell image even while the wrapper identity appears stable", async () => {
    const f = fixture(); let reads = 0;
    f.kernel.executable = async () => {
      if (++reads < 4) return "/bin/sh";
      f.live.get(20)!.auditToken[7] = 999;
      return "/bin/bash";
    };
    const captured = await f.control.capture(20, "shell", { executable: "/bin/bash", operation: op(), ready: async () => true });
    expect(reads).toBeGreaterThanOrEqual(5);
    expect(captured.auditToken[7]).toBe(999); expect(f.calls).toEqual([]);
  });
  it("rejects a PID birth replacement while waiting for the managed shell image", async () => {
    const f = fixture();
    f.kernel.executable = async () => { f.live.get(20)!.birthToken = "101:20"; return "/bin/bash"; };
    await expect(f.control.capture(20, "shell", { executable: "/bin/bash", operation: op(), ready: async () => true })).rejects.toThrow("replaced");
    expect(f.calls).toEqual([]);
  });
  it("bounds an unconfirmed shell image without capturing or signaling it", async () => {
    const f = fixture(); f.kernel.executable = async () => "/bin/sh";
    const operation = createOperation({ limits: { totalMs: 40 } }); operations.push(operation);
    await expect(f.control.capture(20, "shell", { executable: "/bin/bash", operation, ready: async () => true })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("reads the current boot independently of an exited original process", async () => {
    const f = fixture(); f.live.clear();
    expect(await f.control.bootIdentity()).toBe("boot-a");
    f.reboot(); expect(await f.control.bootIdentity()).toBe("boot-b");
  });
  it("distinguishes process exit, reboot, PID replacement, and an exec image", async () => {
    const f = fixture();
    expect(await f.control.observe(agent)).toBe("same");
    f.live.get(30)!.auditToken[7]! += 1;
    expect(await f.control.observe(agent)).toBe("changed");
    f.live.get(30)!.birthToken = "101:30";
    expect(await f.control.observe(agent)).toBe("changed");
    f.live.delete(30);
    expect(await f.control.observe(agent)).toBe("exited");
    f.reboot();
    expect(await f.control.observe(shell)).toBe("exited");
  });
  it("never signals a replacement or a process from another boot", async () => {
    const f = fixture(); f.live.get(30)!.auditToken[7]! += 1;
    expect(await f.control.signal(agent, "SIGKILL")).toBe("changed");
    f.reboot(); expect(await f.control.signal(shell, "SIGKILL")).toBe("exited");
    expect(f.calls).toEqual([]);
  });
  it("lets the kernel reject a replacement between observation and signal", async () => {
    const f = fixture(); f.hooks.signal = pid => { f.live.get(pid)!.auditToken[7]! += 1; };
    expect(await f.control.signal(agent, "SIGKILL")).toBe("changed");
    expect(f.live.has(30)).toBe(true); expect(f.calls).toEqual([]);
  });
  it("requires socket peer and independently captured daemon tokens to agree", async () => {
    const f = fixture(); expect(await f.control.peer("/private/run.sock")).toEqual(daemon);
    f.live.get(10)!.auditToken[7]! += 1;
    await expect(f.control.peer("/private/run.sock")).rejects.toThrow();
  });
  it("reports failed process inspection as unknown", async () => {
    const f = fixture(); f.hooks.read = () => { throw new Error("EPERM"); };
    expect(await f.control.observe(agent)).toBe("unknown");
    expect(await f.control.signal(agent, "SIGKILL")).toBe("unknown"); expect(f.calls).toEqual([]);
  });
});

describe("exclusive Herdr run stopping", () => {
  it("recognizes an earlier boot without touching processes in the new boot", async () => {
    const f = fixture(); f.reboot();
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent] }, op());
    expect(result.state).toBe("stopped_confirmed"); expect(result.method).toBe("boot_changed"); expect(f.calls).toEqual([]);
  });
  it("continues a journaled stop after the original daemon already exited", async () => {
    const f = fixture(); f.live.delete(10); f.live.get(20)!.ppid = 1;
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent] }, op());
    expect(result.state).toBe("stopped_confirmed"); expect(f.calls.filter(call => call.signal === 9).map(call => call.pid)).toEqual([30, 20]);
  });
  it("retains an unregistered daemon-session orphan after a daemon crash", async () => {
    const f = fixture(); f.live.delete(10); f.live.get(20)!.ppid = 1;
    f.live.set(40, { ...identity(40, "agent", 1, 10), state: "running" });
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent] }, op());
    expect(result.state).toBe("stop_unknown"); expect(f.calls.some(call => call.signal === 9 || call.pid === 40)).toBe(false);
  });
  it("accepts native self-exit without substituting a later foreground process", async () => {
    const f = fixture(); f.live.delete(30);
    expect((await f.control.stopExclusiveRun({ daemon, processes: [shell, agent] }, op())).state).toBe("stopped_confirmed");
    expect(f.calls.filter(call => call.signal === 9).map(call => call.pid)).toEqual([10, 20]);
  });
  it("kills the daemon before its original terminal processes and preserves other runs", async () => {
    const f = fixture(), other = identity(100, "daemon", 1, 100);
    f.live.set(100, { ...other, state: "running" });
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent] }, op());
    expect(result.state).toBe("stopped_confirmed"); expect(result.method).toBe("instances_exited");
    expect(f.calls.filter(call => call.signal === 9).map(call => call.pid)).toEqual([10, 30, 20]);
    expect(f.live.get(100)?.state).toBe("running");
  });
  it("requests an explicit process tree and original terminal session scope", async () => {
    const f = fixture(), originalList = f.kernel.list;
    f.kernel.list = async scope => {
      expect(scope).toBeDefined(); expect(scope!.rootPids).toContain(10); expect(scope!.sessionIds).toEqual([10, 20]);
      return originalList(scope);
    };
    expect((await f.control.stopExclusiveRun({ daemon, processes: [shell, agent] }, op())).state).toBe("stopped_confirmed");
  });
  it("persists an observed native descendant before freezing it", async () => {
    const f = fixture(), child = identity(40, "agent", 30);
    f.live.set(40, { ...child, state: "running" }); let registered = false;
    f.hooks.signal = (pid, signal) => { if (pid === 40 && signal === 17) expect(registered).toBe(true); };
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent], onDiscovered: async value => { expect(value.pid).toBe(40); registered = true; } }, op());
    expect(result.state).toBe("stopped_confirmed"); expect(result.processes.some(value => value.pid === 40)).toBe(true);
  });
  it("retains unknown siblings and restores only processes frozen by this attempt", async () => {
    const f = fixture(); f.live.get(30)!.state = "stopped";
    f.live.set(40, { ...identity(40, "agent", 20), state: "running" });
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent], onDiscovered: async () => {} }, op());
    expect(result.state).toBe("stop_unknown"); expect(f.calls.some(call => call.signal === 9)).toBe(false);
    expect(f.live.get(10)?.state).toBe("running"); expect(f.live.get(20)?.state).toBe("running");
    expect(f.live.get(30)?.state).toBe("stopped"); expect(f.live.get(40)?.state).toBe("running");
  });
  it("cannot attribute an orphan merely by the old native session id", async () => {
    const f = fixture(); f.live.delete(30); f.live.set(40, { ...identity(40, "agent", 1), state: "running" });
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent], onDiscovered: async () => {} }, op());
    expect(result.state).toBe("stop_unknown"); expect(f.calls.some(call => call.pid === 40 || call.signal === 9)).toBe(false);
  });
  it("does not freeze a discovered process when durable registration fails", async () => {
    const f = fixture(); f.live.set(40, { ...identity(40, "agent", 30), state: "running" });
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent], onDiscovered: async () => { throw new Error("disk full"); } }, op());
    expect(result.state).toBe("stop_unknown"); expect(f.calls.some(call => call.pid === 40 || call.signal === 9)).toBe(false);
    expect(f.live.get(10)?.state).toBe("running");
  });
  it("never resumes an exec replacement during rollback", async () => {
    const f = fixture(); f.hooks.list = () => { f.live.get(30)!.auditToken[7]! += 1; throw new Error("probe failed"); };
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent] }, op());
    expect(result.state).toBe("stop_unknown"); expect(f.calls.some(call => call.pid === 30 && call.signal === 19)).toBe(false);
    expect(f.live.get(10)?.state).toBe("running");
  });
  it("rolls back its freezes when cancellation occurs before destruction", async () => {
    const f = fixture(), controller = new AbortController();
    const operation = createOperation({ signal: controller.signal }); operations.push(operation);
    f.hooks.list = () => controller.abort();
    const result = await f.control.stopExclusiveRun({ daemon, processes: [shell, agent] }, operation);
    expect(result.state).toBe("stop_unknown"); expect(f.calls.some(call => call.signal === 9)).toBe(false);
    expect([...f.live.values()].every(value => value.state === "running")).toBe(true);
  });
});
