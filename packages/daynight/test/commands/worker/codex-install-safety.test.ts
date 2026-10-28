import { describe, expect, it } from "vitest";
import { assertCodexInstallConfigurationSafe, projectCodexInstallConfiguration } from "../../../src/commands/worker/herdr/codex-install-safety.js";

describe("audited Codex installer projection", () => {
  it.each([
    ["", "[features]\nhooks = true\n"],
    ["[features]\nhooks=false", "[features]\nhooks = true"],
    ["[features]\r\nhooks=false\r\n", "[features]\nhooks = true\n"],
    ["model='native'\r", "model='native'\r\n\n[features]\nhooks = true\n"],
    ["[features]\r", "[features]\r\nhooks = true"],
    ["\u0085[features]\nhooks=false\n", "\u0085[features]\nhooks = true\n"],
    ["\ufeff[features]\nhooks=false\n", "\ufeff[features]\nhooks=false\n\n[features]\nhooks = true\n"],
    ["[features]\ncodex_hooks=true\nhooks=false\n", "[features]\nhooks = true\n"],
  ])("matches Rust line and whitespace behavior for %j", (source, expected) => {
    expect(projectCodexInstallConfiguration(source)).toBe(expected);
  });

  it.each([
    "1979-05-27", "1979-05-27T07:32:00.123456789", "07:32:00.123456789", "1979-05-27T07:32:00.123456789Z",
  ])("refuses lossy temporal values before comparison (%s)", (date) => {
    expect(() => assertCodexInstallConfigurationSafe(`nested = [{ created = ${date} }]\n`)).toThrow("unsupported semantic values");
  });

  it("refuses deeply nested tables without exposing parser diagnostics", () => {
    const source = `[${Array.from({ length: 102 }, (_, index) => `level${index}`).join(".")}]\nprivate = true\n`;
    let failure: unknown;
    try { assertCodexInstallConfigurationSafe(source); } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBeUndefined();
    expect((failure as Error).message).not.toContain("level0");
  });
});
