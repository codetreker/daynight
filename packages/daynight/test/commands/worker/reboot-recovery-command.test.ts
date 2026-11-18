import path from "node:path";
import { expect, test, vi } from "vitest";
import { runWorkerCommand } from "../../../src/commands/worker/index.js";
import type { CliContext } from "../../../src/cli/context.js";

const run = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../src/commands/worker/reboot-recovery.js", () => ({ runWorkerRebootRecovery: run }));
const context: CliContext = { version: "1.0.0", packageDirectory: path.resolve("package"), homeDirectory: () => { throw new Error("Unexpected home read"); }, workingDirectory: () => { throw new Error("Unexpected cwd read"); }, stdout: () => {}, stderr: () => {}, stdoutBytes: async () => {} };
const target = { taskId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", projectId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", claimId: "cccccccc-cccc-cccc-cccc-cccccccccccc", sessionId: "dddddddd-dddd-dddd-dddd-dddddddddddd", worktreeId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" };
const args = ["reboot-recovery", target.taskId, "--project", target.projectId, "--claim-id", target.claimId, "--session-id", target.sessionId, "--worktree-id", target.worktreeId];

test("requires every original identity and routes prepare separately from confirmation", async () => {
  for (const index of [2, 4, 6, 8]) {
    run.mockClear();
    await expect(runWorkerCommand(args.filter((_, i) => i !== index && i !== index + 1), context)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  }
  await runWorkerCommand([...args, "--prepare"], context);
  expect(run).toHaveBeenLastCalledWith({ ...target, prepare: true }, context);
  await runWorkerCommand(args, context);
  expect(run).toHaveBeenLastCalledWith({ ...target, prepare: false }, context);
  run.mockClear();
  await expect(runWorkerCommand([...args, "--force"], context)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
