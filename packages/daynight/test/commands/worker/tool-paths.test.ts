import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseWorkerConfiguration } from "../../../src/commands/worker/config.js";
import { parseWorkerCloudBootstrap, parseWorkerLocalConfiguration } from "../../../src/commands/worker/configuration-source.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const paths = resolveWorkerPaths("/home/worker", path.posix);
const automatic = { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } };

describe.each([
  ["runtime", (source: string) => parseWorkerConfiguration(source, paths, path.posix)],
  ["local source", (source: string) => parseWorkerLocalConfiguration(source, paths, path.posix)],
] as const)("%s tool path configuration", (_name, parse) => {
  it.each([undefined, {}, { codex: null, copilot: null, herdr: null }])("fills all omitted or null choices with auto: %j", toolPaths => {
    expect(parse(stringify({ worker: { toolPaths } })).toolPaths).toEqual(automatic);
    expect(parse("{}").toolPaths).toEqual(automatic);
  });

  it("preserves every path byte without trimming, splitting, expansion or filesystem lookup", () => {
    const codex = "/missing tools/工具 $(printf x) '$HOME'/codex ";
    const herdr = "/missing/../$HOME/~herdr";
    expect(parse(stringify({ worker: { toolPaths: { codex, copilot: null, herdr } } })).toolPaths).toEqual({
      codex: { kind: "path", path: codex }, copilot: { kind: "auto" }, herdr: { kind: "path", path: herdr },
    });
  });

  it.each([null, [], "codex", 7, false, { claude: null }, { Codex: null }, { codex: { kind: "auto" } }, { herdr: false }].map(value => [value]))(
    "rejects malformed mappings and unsupported tool keys: %j", toolPaths => {
      expect(() => parse(stringify({ worker: { toolPaths } }))).toThrow("worker.toolPaths");
    },
  );

  it.each(["", "   ", "codex", "../codex", "~/bin/codex", "$HOME/bin/codex", " /bin/codex", "C:\\tools\\codex.exe", "/bin/co\u0000dex", "/bin/co\ndex", "/bin/co\rdex", "/bin/co\tdex", "/bin/co\u007fdex", "/bin/co\u0085dex", "/bin/co\ud800dex", "/bin/co\udfffdex"])(
    "rejects invalid POSIX path %j", codex => {
      expect(() => parse(stringify({ worker: { toolPaths: { codex } } }))).toThrow("worker.toolPaths.codex");
    },
  );

  it("limits UTF-8 bytes rather than UTF-16 code units", () => {
    const codex = `/${"界".repeat(1365)}`;
    expect(parse(stringify({ worker: { toolPaths: { codex } } })).toolPaths.codex).toEqual({ kind: "path", path: codex });
    expect(() => parse(stringify({ worker: { toolPaths: { codex: `${codex}x` } } }))).toThrow("4096");
    const copilot = `/${"🦉".repeat(1023)}abc`;
    expect(parse(stringify({ worker: { toolPaths: { copilot } } })).toolPaths.copilot).toEqual({ kind: "path", path: copilot });
    expect(() => parse(stringify({ worker: { toolPaths: { copilot: `${copilot}x` } } }))).toThrow("4096");
  });
});

describe.each([
  ["runtime", parseWorkerConfiguration],
  ["local source", parseWorkerLocalConfiguration],
] as const)("%s Windows tool path syntax", (_name, parse) => {
  const windows = resolveWorkerPaths("C:\\Users\\worker", path.win32);
  it.each(["C:\\Program Files\\工具\\codex.cmd", "D:/工具/copilot.ps1", "\\\\server\\share\\Herdr tools\\herdr.exe", "\\\\?\\C:\\tools\\codex.exe"])("keeps fully qualified path %s", codex => {
    expect(parse(stringify({ worker: { toolPaths: { codex } } }), windows, path.win32).toolPaths.codex).toEqual({ kind: "path", path: codex });
  });
  it.each(["C:codex.cmd", "\\tools\\codex.exe", "/tools/codex.exe", "codex.cmd", "~/codex.cmd", "\\\\server"])("rejects paths requiring a current drive or directory: %s", codex => {
    expect(() => parse(stringify({ worker: { toolPaths: { codex } } }), windows, path.win32)).toThrow("worker.toolPaths.codex");
  });
});

it("keeps local choices outside the existing cloud bootstrap protocol", async () => {
  const source = stringify({ worker: { toolPaths: { codex: path.resolve("/tools/codex") } } });
  const bootstrap = await parseWorkerCloudBootstrap(source, paths, async () => { throw new Error("No Projects configured."); }, new AbortController().signal);
  expect(bootstrap).toEqual({
    agentControlMode: "herdr", maxConcurrent: 1, pollIntervalMs: 60_000, recoveryLimit: 3,
    preferPlatformSpecificTasks: false, native: { agent: "copilot", model: null, args: [] }, projects: [],
  });
});
