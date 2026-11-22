import { afterEach, expect, it, vi } from "vitest";
import { createWorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
import { WorkerNetworkUnavailableError } from "../../../src/commands/worker/management-network.js";

afterEach(() => vi.restoreAllMocks());

it("permits a local Session owner without credentials and refuses every request before fetch", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected anonymous request"));
  const api = createWorkerSessionApi("https://daynight.example", undefined, { managementOnly: true });
  const signal = new AbortController().signal;
  await expect(api.supportsStartupReports(signal)).rejects.toBeInstanceOf(WorkerNetworkUnavailableError);
  await expect(api.verifySupport("codex", signal)).rejects.toBeInstanceOf(WorkerNetworkUnavailableError);
  await expect(api.verifyUnregistered({ projectId: "project", taskId: "task", claimId: "claim" }, signal)).rejects.toBeInstanceOf(WorkerNetworkUnavailableError);
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects missing Session credentials unless the caller explicitly constructs a management owner", () => {
  expect(() => createWorkerSessionApi("https://daynight.example", undefined)).toThrow(WorkerNetworkUnavailableError);
});
