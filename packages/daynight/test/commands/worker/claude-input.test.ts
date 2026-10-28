import { expect, it } from "vitest";
import { claudeInputSurface } from "../../../src/commands/worker/herdr/claude-input.js";
import { buildHerdrAgentArguments, validateHerdrAgentArguments } from "../../../src/commands/worker/herdr/arguments.js";
it("requires an empty Claude composer between its borders and a current footer", () => {
  expect(claudeInputSurface("Claude Code\n─────────────────\n❯ \n─────────────────\n  ? for shortcuts")).toBe("composer");
  expect(claudeInputSurface("Claude Code\n❯\nIdle")).toBe("unknown");
  expect(claudeInputSurface("─────────────────\n❯ user draft\n─────────────────\n? for shortcuts")).toBe("unknown");
  expect(claudeInputSurface("Do you trust the files in this folder?\n❯ 1. Yes\n2. No\nEnter to confirm · Esc to cancel")).toBe("blocked");
  expect(claudeInputSurface("─────────────────\n❯\n─────────────────\nEnter to select · Esc to cancel")).toBe("blocked");
});
it("owns Claude resume and model arguments while refusing print, prompt, and settings overrides", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  expect(buildHerdrAgentArguments({ agent: "claude", model: "sonnet", args: ["--permission-mode", "default"] }, "/tmp/daynight", id)).toEqual(["--resume", id, "--model", "sonnet", "--permission-mode", "default", "--dangerously-skip-permissions"]);
  for (const arg of ["--print", "--resume", "--session-id", "--settings", "--setting-sources", "business prompt"]) expect(() => validateHerdrAgentArguments("claude", [arg])).toThrow();
});
