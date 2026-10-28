import { test, expect } from "vitest";
import { runControllerCommand } from "../../../src/commands/controller/index.js";
import type { CliContext } from "../../../src/cli/context.js";
const context = (stdout: (text: string) => void): CliContext => ({ version: "0.22.0", packageDirectory: "/package", homeDirectory: () => "/unavailable", workingDirectory: () => "/unavailable", stdout, stderr: () => {}, stdoutBytes: async () => {} });
test.each(["codex", "claude", "copilot"])("%s controller help describes worker-issued launches", async (provider) => { let output = ""; await runControllerCommand([provider, "--help"], context(text => { output += text; })); expect(output).toContain("--launch-id"); expect(output).toContain("worker"); });
test("controller rejects arbitrary launch paths before reading a ticket", async () => { await expect(runControllerCommand(["claude", "--launch-id", "../../secrets"], context(() => {}))).rejects.toThrow("UUID"); });
