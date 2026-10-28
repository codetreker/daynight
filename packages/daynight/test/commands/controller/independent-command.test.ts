import { beforeEach, expect, test, vi } from "vitest";
const launch = vi.hoisted(() => vi.fn());
vi.mock("../../../src/commands/controller/independent.js", () => ({ runIndependentController: launch }));
import { runControllerCommand } from "../../../src/commands/controller/index.js";
import type { CliContext } from "../../../src/cli/context.js";
const context: CliContext = { version: "test", packageDirectory: "/package", homeDirectory: () => "/home", workingDirectory: () => "/cwd", stdout: () => {}, stderr: () => {}, stdoutBytes: async () => {} };
beforeEach(() => launch.mockClear());
test.each(["codex", "claude", "copilot"])("%s starts without a prompt or worker config", async provider => {
  await runControllerCommand([provider], context);
  expect(launch).toHaveBeenCalledWith({ provider, model: null, args: [], prompt: null }, context);
});
test("native options and a single prompt are forwarded without shell splitting", async () => {
  await runControllerCommand(["codex", "-m", "native", "-s", "workspace-write", "-a", "on-request", "hello 中文"], context);
  expect(launch).toHaveBeenCalledWith({ provider: "codex", model: "native", args: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"], prompt: "hello 中文" }, context);
});
test.each([["--cwd", "/tmp"], ["--open"], ["--permission-mode", "default"], ["--sandbox", "danger-full-access"], ["one", "two"], ["--launch-id", "11111111-1111-4111-8111-111111111111", "prompt"]])("rejects unsupported or mixed launch arguments %j", async (...args) => {
  await expect(runControllerCommand(["codex", ...args], context)).rejects.toThrow();
  expect(launch).not.toHaveBeenCalled();
});

test.each(['codex', 'claude', 'copilot'])('%s resume selects a local saved Test Session without replaying a prompt', async provider => {
  const id = '11111111-1111-4111-8111-111111111111';
  await runControllerCommand([provider, 'resume', id], context);
  expect(launch).toHaveBeenCalledWith({ provider, model: null, args: [], prompt: null, resume: { sessionId: id } }, context);
  await runControllerCommand([provider, 'resume'], context);
  expect(launch).toHaveBeenLastCalledWith({ provider, model: null, args: [], prompt: null, resume: { sessionId: null } }, context);
});
test('resume help is side-effect free and a literal resume prompt remains available', async () => {
  const stdout = vi.fn();
  await runControllerCommand(['codex', 'resume', '--help'], { ...context, stdout });
  expect(stdout.mock.calls[0]![0]).toContain('test-session-id'); expect(launch).not.toHaveBeenCalled();
  await runControllerCommand(['codex', '--', 'resume'], context);
  expect(launch).toHaveBeenCalledWith({ provider: 'codex', model: null, args: [], prompt: 'resume' }, context);
});
test.each([['bogus'], ['../secret'], ['--model', 'native'], ['--launch-id', '11111111-1111-4111-8111-111111111111'], ['11111111-1111-4111-8111-111111111111', 'prompt']])('resume rejects invalid IDs and options %j', async (...args) => {
  await expect(runControllerCommand(['codex', 'resume', ...args], context)).rejects.toThrow(); expect(launch).not.toHaveBeenCalled();
});
