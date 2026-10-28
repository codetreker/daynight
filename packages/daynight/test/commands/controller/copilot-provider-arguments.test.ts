import { expect, test } from "vitest";
import { parseProviderArguments } from "../../../src/commands/controller/providers/projection.js";

test("Copilot leaves reasoning effort unspecified and maps only its four native values", () => {
  expect(parseProviderArguments("copilot", [])).toEqual({});
  for (const effort of ["low", "medium", "high", "xhigh"]) expect(parseProviderArguments("copilot", ["--effort", effort])).toEqual({ effort });
});
test.each([["--effort", "max"], ["--allow-all"], ["--resume", "latest"], ["--permission-mode", "default"], ["--add-dir", "/tmp"]])("Copilot rejects unsupported native control arguments %j", (...args) => {
  expect(() => parseProviderArguments("copilot", args)).toThrow(/Unsupported/);
});
