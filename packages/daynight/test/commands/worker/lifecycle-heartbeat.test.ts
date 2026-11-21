import { describe, expect, it, vi } from "vitest";
import { runLifecycleHeartbeat } from "../../../src/commands/worker/lifecycle-heartbeat.js";
import type { WorkerReport } from "../../../src/api/types.js";

describe("management heartbeat", () => {
  it("reports unavailable probes without inventing a complete task inventory", async () => {
    const cancellation = new AbortController(), reportError = vi.fn();
    let report: WorkerReport | undefined;
    await runLifecycleHeartbeat({ signal: cancellation.signal, machine: { id: "11111111-1111-4111-8111-111111111111", name: "test" },
      platform: "macos", workingDirectory: "/test", version: "0.71.0", executionReporterActive: () => false, reportError,
      send: async input => { report = input; cancellation.abort(); return { observedAt: input.sampledAt, lastReportedAt: input.sampledAt }; } });
    expect(report).toMatchObject({ taskInventory: null, versions: { daynight: "0.71.0", codex: { state: "error", code: "unavailable" }, copilot: { state: "error", code: "unavailable" } },
      cpu: { state: "error", code: "unavailable" }, disk: { state: "error", code: "unavailable" } });
    expect(reportError).not.toHaveBeenCalled();
  });
  it("joins an in-flight heartbeat when the management root is cancelled", async () => {
    const cancellation = new AbortController(), started = Promise.withResolvers<void>(), reportError = vi.fn();
    const pending = runLifecycleHeartbeat({ signal: cancellation.signal, machine: { id: "11111111-1111-4111-8111-111111111111", name: "test" },
      platform: "macos", workingDirectory: "/test", version: "0.71.0", executionReporterActive: () => false, reportError,
      send: async (_report, operation) => {
        started.resolve();
        return new Promise((_, reject) => operation.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true }));
      } });
    await started.promise; cancellation.abort(); await pending;
    expect(reportError).not.toHaveBeenCalled();
  });
});
