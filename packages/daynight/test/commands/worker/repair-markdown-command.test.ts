import path from "node:path";
import { expect, test, vi } from "vitest";
import { runWorkerCommand } from "../../../src/commands/worker/index.js";
import type { CliContext } from "../../../src/cli/context.js";

const runRepair = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../src/commands/worker/repair-markdown.js", () => ({ runWorkerMarkdownRepair: runRepair }));
const context: CliContext = { version: "1.0.0", packageDirectory: path.resolve("package"), homeDirectory: () => { throw new Error("Unexpected home read"); }, workingDirectory: () => { throw new Error("Unexpected cwd read"); }, stdout: () => {}, stderr: () => {}, stdoutBytes: async () => {} };
const target = { taskId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", projectId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", claimId: "cccccccc-cccc-cccc-cccc-cccccccccccc", sessionId: "dddddddd-dddd-dddd-dddd-dddddddddddd", worktreeId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" };
const args = ["repair-markdown", target.taskId, "--project", target.projectId, "--claim-id", target.claimId, "--session-id", target.sessionId, "--worktree-id", target.worktreeId];

test("repair requires all original identities before loading execution resources", async () => {
  for (const index of [2, 4, 6, 8]) {
    runRepair.mockClear();
    await expect(runWorkerCommand(args.filter((_, i) => i !== index && i !== index + 1), context)).rejects.toThrow();
    expect(runRepair).not.toHaveBeenCalled();
  }
  await runWorkerCommand(args, context);
  expect(runRepair).toHaveBeenCalledExactlyOnceWith(target, context);
});

test("repair help describes retained sources and does not open the Worker", async () => {
  runRepair.mockClear();
  const output: string[] = [];
  await runWorkerCommand(["repair-markdown", "--help"], { ...context, stdout: value => { output.push(value); } });
  expect(output.join("")).toContain("Worker may remain running");
  expect(output.join("")).toContain("never starts an Agent");
  expect(runRepair).not.toHaveBeenCalled();
});

test("repair refuses malformed identity and destructive options", async () => {
  for (const input of [[...args, "--force"], [...args, "--delete"], [...args.slice(0, -1), "not-a-worktree"]]) {
    runRepair.mockClear();
    await expect(runWorkerCommand(input, context)).rejects.toThrow();
    expect(runRepair).not.toHaveBeenCalled();
  }
});
