import type { WorkerTelemetry } from "../../src/api/types.js";

export const workerTelemetryTime = "2026-10-29T00:00:00.000Z";
export const workerTelemetry: WorkerTelemetry = {
  machine: { id: "00000000-0000-4000-8000-000000000001", name: "worker" }, platform: "linux", workingDirectory: "/worker", sampledAt: workerTelemetryTime,
  os: { state: "ok", checkedAt: workerTelemetryTime, value: { type: "Linux", release: "6", version: "kernel", arch: "x64" } },
  cpu: { state: "ok", checkedAt: workerTelemetryTime, value: { model: "CPU", logicalProcessors: 4, usagePercent: 12 } },
  memory: { state: "ok", checkedAt: workerTelemetryTime, value: { usedBytes: 100, totalBytes: 200 } },
  disk: { state: "ok", checkedAt: workerTelemetryTime, value: { availableBytes: 300, totalBytes: 400 } },
  versions: { daynight: "0.26.1", herdr: { state: "not_running", checkedAt: workerTelemetryTime }, codex: { state: "not_installed", checkedAt: workerTelemetryTime }, copilot: { state: "not_installed", checkedAt: workerTelemetryTime } },
};
