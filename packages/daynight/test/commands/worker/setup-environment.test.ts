import path from "node:path";
import { expect, it, vi } from "vitest";
import { inspectWorkerEnvironment } from "../../../src/commands/worker/setup-environment.js";
import { OwnedCommandCleanupError } from "../../../src/commands/worker/owned-command.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const homeDirectory = path.resolve(".tmp/setup-test");
const options = () => ({ homeDirectory, workingDirectory: homeDirectory, paths: resolveWorkerPaths(homeDirectory), signal: new AbortController().signal });

it("reports independent OS, Node and Git prerequisites and preserves unverified execution", async () => {
  const runCommand = vi.fn(async () => ({ stdout: "git version 2.45.0\n", stderr: "" }));
  const results = await inspectWorkerEnvironment(options(), { platform: "linux", nodeVersion: "24.0.0", runCommand });
  expect(results.slice(0, 3)).toMatchObject([{ label: "Operating system", status: "passed" }, { label: "Node.js", status: "passed" }, { label: "Git", status: "passed" }]);
  expect(results.slice(3).every(result => result.status === "unverified")).toBe(true);
  expect(runCommand).toHaveBeenCalledOnce();
});

it("reports independent missing prerequisites with remedies", async () => {
  const runCommand = vi.fn(async () => { throw new Error("Git missing"); });
  const results = await inspectWorkerEnvironment(options(), { platform: "freebsd", nodeVersion: "20.0.0", runCommand });
  expect(results.slice(0, 3).every(result => result.status === "missing" && result.remedy)).toBe(true);
});

it("does not claim provider authentication from a configuration check", async () => {
  const result = await inspectWorkerEnvironment({ ...options(), configuration: { agent: "codex", model: null, args: [] } });
  expect(result).toMatchObject([{ agent: "codex", status: "unverified" }]);
});

it("propagates cancellation and unconfirmed process cleanup", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(inspectWorkerEnvironment({ ...options(), signal: controller.signal })).rejects.toBe(controller.signal.reason);
  const failure = new OwnedCommandCleanupError([new Error("owned process remains")], undefined);
  await expect(inspectWorkerEnvironment(options(), { runCommand: async () => { throw failure; } })).rejects.toBe(failure);
});
