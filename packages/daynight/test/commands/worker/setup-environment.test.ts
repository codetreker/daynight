import { describe, expect, it, vi } from "vitest";
import type { Operation } from "../../../src/api/operation.js";
import { OwnedCommandCleanupError } from "../../../src/commands/worker/owned-command.js";
import type { OwnedCommand } from "../../../src/commands/worker/owned-command.js";
import { inspectWorkerEnvironment } from "../../../src/commands/worker/setup-environment.js";

const fixture = () => {
  const options = { workingDirectory: "/work", signal: new AbortController().signal };
  const runCommand = vi.fn(async (_command: OwnedCommand, _operation: Operation) => ({ stdout: "git version 2.43.0\n", stderr: "" }));
  const dependencies = { environment: { PATH: "/tools" }, platform: "linux" as const, nodeVersion: "24.19.0", runCommand };
  return { options, dependencies, runCommand };
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
};

describe("worker setup environment inspection", () => {
  it.each([["linux", "linux"], ["darwin", "macos"], ["win32", "windows"]] as const)("checks common prerequisites on %s", async (platform, expected) => {
    const f = fixture();
    const checks = await inspectWorkerEnvironment(f.options, { ...f.dependencies, platform });
    expect(checks).toEqual([
      { label: "Operating system", status: "passed", detail: expected },
      { label: "Node.js", status: "passed", detail: "24.19.0" },
      { label: "Git", status: "passed", detail: "2.43.0" },
      expect.objectContaining({ label: "Task tools and Git transport", status: "unverified" }),
      expect.objectContaining({ label: "Web Controller and native execution", status: "unverified" }),
    ]);
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.runCommand.mock.calls[0]![0]).toEqual({ file: "git", args: ["--version"], environment: { PATH: "/tools" }, cwd: "/work" });
  });

  it("reports independent OS, Node and Git failures with remedies", async () => {
    const f = fixture();
    f.runCommand.mockRejectedValue(new Error("git unavailable"));
    const checks = await inspectWorkerEnvironment(f.options, { ...f.dependencies, platform: "freebsd", nodeVersion: "20.20.0" });
    expect(checks.filter(({ status }) => status === "missing")).toEqual([
      expect.objectContaining({ label: "Operating system", detail: expect.stringContaining("freebsd"), remedy: expect.any(String) }),
      expect.objectContaining({ label: "Node.js", detail: expect.stringContaining("22"), remedy: expect.any(String) }),
      expect.objectContaining({ label: "Git", detail: "git unavailable", remedy: expect.any(String) }),
    ]);
    expect(checks.slice(-2).every(({ status }) => status === "unverified")).toBe(true);
  });

  it("reports an unrecognizable Git version", async () => {
    const f = fixture();
    f.runCommand.mockResolvedValue({ stdout: "unknown", stderr: "" });
    expect((await inspectWorkerEnvironment(f.options, f.dependencies)).find(({ label }) => label === "Git"))
      .toMatchObject({ status: "missing", detail: "Cannot identify the installed Git executable." });
  });

  it.each(["codex", "copilot", "claude"] as const)("defers %s authentication and capability checks to the Controller", async (agent) => {
    const f = fixture();
    const checks = await inspectWorkerEnvironment({ ...f.options, configuration: { agent, model: "custom", args: ["--example"] } }, f.dependencies);
    expect(checks).toEqual([{ label: `${agent} Web session runtime`, status: "unverified", agent,
      detail: "The Controller verifies native authentication, capabilities and working-directory identity before dispatching task input.",
      remedy: `Authenticate ${agent} before starting the Web worker.` }]);
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("does not start probes after cancellation", async () => {
    const f = fixture(); const controller = new AbortController(); const reason = new Error("stop setup"); controller.abort(reason);
    await expect(inspectWorkerEnvironment({ ...f.options, signal: controller.signal }, f.dependencies)).rejects.toBe(reason);
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("preserves wrapped command cleanup failure even during cancellation", async () => {
    const f = fixture(); const controller = new AbortController();
    const failure = new Error("probe failed", { cause: new OwnedCommandCleanupError([new Error("process did not close")], undefined) });
    f.runCommand.mockImplementation(async () => { controller.abort(new Error("cancel")); throw failure; });
    await expect(inspectWorkerEnvironment({ ...f.options, signal: controller.signal }, f.dependencies)).rejects.toBe(failure);
  });

  it("waits for the owned probe to settle before propagating cancellation", async () => {
    const f = fixture(); const controller = new AbortController();
    const started = deferred(), cleaning = deferred(), cleaned = deferred();
    f.runCommand.mockImplementation(async (_command, operation) => {
      started.resolve();
      await new Promise<void>((resolve) => operation.signal.addEventListener("abort", () => resolve(), { once: true }));
      cleaning.resolve(); await cleaned.promise; operation.check();
      throw new Error("unreachable");
    });
    let settled = false;
    const inspection = inspectWorkerEnvironment({ ...f.options, signal: controller.signal }, f.dependencies).finally(() => { settled = true; });
    await started.promise; controller.abort(new Error("cancel during probe")); await cleaning.promise;
    expect(settled).toBe(false);
    cleaned.resolve();
    await expect(inspection).rejects.toMatchObject({ name: "OperationError", kind: "cancelled" });
    expect(settled).toBe(true);
  });
});
