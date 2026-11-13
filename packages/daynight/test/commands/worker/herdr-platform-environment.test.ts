import { expect, it } from "vitest";
import { platformSystemEnvironment } from "./herdr-tool-platform.fixtures.js";

it.each(["upper", "lower", "mixed"] as const)("canonicalizes %s Windows system keys without inheriting user configuration", casing => {
  const expected = { SystemRoot: "C:\\Windows", SystemDrive: "C:", ComSpec: "C:\\Windows\\system32\\cmd.exe", WINDIR: "C:\\Windows", OS: "Windows_NT" };
  const source = Object.fromEntries(Object.entries(expected).map(([key, value]) => [casing === "upper" ? key.toUpperCase() : casing === "lower" ? key.toLowerCase() : key, value]));
  Object.assign(source, { PATH: "user-path", HOME: "user-home", OPENAI_API_KEY: "user-key" });
  expect(platformSystemEnvironment(source)).toEqual(expected);
});
