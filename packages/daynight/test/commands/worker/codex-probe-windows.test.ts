import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { BotCliProbeCleanupError } from "../../../src/commands/worker/bots/cli-probe.js";
import { captureCodexProbeEnvironment, createCodexProbeOwner } from "../../../src/commands/worker/codex-probe-owner.js";
import { withinOperation } from "../../../src/platform/tool-io.js";
import { hasHerdrCommandCleanupFailure, hasUnconfirmedHerdrCommandCleanup, HerdrCommandCleanupError } from "../../../src/commands/worker/herdr/command.js";

// Exercise the locked launcher sources while replacing every filesystem and process effect.
const require = createRequire(import.meta.url);
const spawnRoot = path.dirname(require.resolve("cross-spawn/package.json"));
const requireSpawn = createRequire(path.join(spawnRoot, "index.js"));
const pathKey = requireSpawn("path-key") as (options: { env: NodeJS.ProcessEnv; platform: string }) => string;
type FakeProcess = { platform: string; env: NodeJS.ProcessEnv; cwd(): string; chdir(value: string): void };
const loadCommonJS = (filename: string, dependencies: Record<string, unknown>, process: FakeProcess): unknown => {
  const context = { module: { exports: {} }, process, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected launcher dependency: ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(readFileSync(filename, "utf8"), context, { filename });
  return context.module.exports;
};
type Launch = { command: string; args: string[]; options: { env: NodeJS.ProcessEnv }; target: string };
const launcher = (kind: "native" | "shebang") => {
  const paths = path.win32;
  let cwd = "C:\\fixture";
  const process: FakeProcess = { platform: "win32", env: { PATHEXT: kind === "shebang" ? ".EXE;.JS" : ".EXE" }, cwd: () => cwd, chdir: value => { cwd = value; } };
  const files = new Set(["shared", "ignored", "ordinary", "assistant"].flatMap(directory => [paths.join("C:\\", directory, kind === "shebang" ? "codex.js" : "codex.exe"), paths.join("C:\\", directory, "node.exe")]).map(file => file.toLowerCase()));
  const which = loadCommonJS(requireSpawn.resolve("which"), { path: paths, isexe: { sync: (file: string) => files.has(file.toLowerCase()) } }, process);
  const resolveCommand = loadCommonJS(path.join(spawnRoot, "lib/util/resolveCommand.js"), { path: paths, which, "path-key": (options: { env: NodeJS.ProcessEnv }) => pathKey({ ...options, platform: "win32" }) }, process);
  const parse = loadCommonJS(path.join(spawnRoot, "lib/parse.js"), {
    path: paths, "./util/resolveCommand": resolveCommand,
    "./util/readShebang": (file: string) => kind === "shebang" && file.toLowerCase().endsWith("codex.js") ? "node" : null,
    "./util/escape": { command: (value: string) => value, argument: (value: string) => value },
  }, process);
  let actual!: Omit<Launch, "target">;
  const spawn = loadCommonJS(path.join(spawnRoot, "index.js"), {
    child_process: { spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => { actual = { command, args: [...args], options }; return {}; } },
    "./lib/parse": parse, "./lib/enoent": { hookChildProcess: () => {} },
  }, process) as (file: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => void;
  return (env: NodeJS.ProcessEnv): Launch => {
    spawn("codex", ["--version"], { env, cwd: "C:\\fixture" });
    // Node's Windows spawn keeps the alphabetically first spelling of each environment key.
    const nodePathKey = Object.keys(env).filter(key => key.toUpperCase() === "PATH").sort()[0]!;
    return { ...actual, target: kind === "shebang" ? actual.args[0]! : paths.join(env[nodePathKey]!, "codex.exe") };
  };
};
const ownerSource = readFileSync(new URL("../../../src/commands/worker/codex-probe-owner.ts", import.meta.url), "utf8")
  .split("\n").filter(line => !line.startsWith("import ") && !line.startsWith("export { ")).join("\n").replaceAll("export ", "");
const windows = vm.runInNewContext(`${stripTypeScriptTypes(ownerSource)}\n({ createCodexProbeOwner, captureCodexProbeEnvironment });`, {
  process: { platform: "win32" }, BotCliProbeCleanupError, hasHerdrCommandCleanupFailure, hasUnconfirmedHerdrCommandCleanup, withinOperation,
  captureCodexProbeEnvironment: (environment: NodeJS.ProcessEnv) => captureCodexProbeEnvironment(environment, "win32"),
}) as { createCodexProbeOwner: typeof createCodexProbeOwner; captureCodexProbeEnvironment: typeof captureCodexProbeEnvironment };

const scenarios = [
  { name: "same uppercase winner despite a later mixed-case alias", ordinary: { PATH: "C:\\ordinary" }, assistant: { PATH: "C:\\ordinary", Path: "C:\\assistant" }, same: true },
  { name: "different uppercase winner despite a later shared alias", ordinary: { Path: "C:\\shared" }, assistant: { PATH: "C:\\ignored", Path: "C:\\shared" }, same: false },
  { name: "same selected path with differently spelled keys", ordinary: { Path: "C:\\shared" }, assistant: { PATH: "C:\\shared", Path: "C:\\ignored" }, same: true },
  { name: "different selected scripts", ordinary: { PATH: "C:\\ordinary" }, assistant: { PATH: "C:\\assistant", Path: "C:\\ordinary" }, same: false },
];

describe("captured Windows Codex launcher inputs", () => {
  it("retains Node-selected keys without mutating inputs or changing non-Windows environments", () => {
    const original = { Path: "C:\\later", PATH: "C:\\first", Pathext: ".JS", PATHEXT: ".EXE", FIXTURE: "retained" };
    expect(captureCodexProbeEnvironment(original, "win32")).toEqual({ PATH: "C:\\first", PATHEXT: ".EXE", FIXTURE: "retained" });
    expect(original.Path).toBe("C:\\later");
    expect(captureCodexProbeEnvironment(original, "linux")).toEqual(original);
    expect(captureCodexProbeEnvironment({ Path: undefined, PATHEXT: undefined, Pathext: ".JS" }, "win32")).toEqual({ PATH: undefined, PATHEXT: undefined });
  });
  for (const kind of ["native", "shebang"] as const) {
    it.each(scenarios)(`${kind} launcher and owner agree: $name`, async ({ ordinary, assistant, same }) => {
      const extension = kind === "shebang" ? ".EXE;.JS" : ".EXE";
      const rawOrdinary = { ...ordinary, PATHEXT: extension, Pathext: ".IGNORED" };
      const rawAssistant = { ...assistant, Pathext: ".IGNORED", PATHEXT: extension };
      const capturedOrdinary = windows.captureCodexProbeEnvironment(rawOrdinary);
      const capturedAssistant = windows.captureCodexProbeEnvironment(rawAssistant);
      const launch = launcher(kind);
      const first = launch(capturedOrdinary); const second = launch(capturedAssistant);
      expect(first.target === second.target).toBe(same);
      if (kind === "native") {
        expect(first.target).toBe(launch(rawOrdinary).target);
        expect(second.target).toBe(launch(rawAssistant).target);
        expect(first.command).toBe("codex"); expect(first.args).toEqual(["--version"]);
      } else {
        expect(first.args[0]).toBe(path.win32.join(capturedOrdinary.PATH!, "codex.JS"));
        expect(second.args[0]).toBe(path.win32.join(capturedAssistant.PATH!, "codex.JS"));
      }
      expect(Object.keys(first.options.env).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
      expect(Object.keys(second.options.env).filter(key => key.toUpperCase() === "PATHEXT")).toEqual(["PATHEXT"]);
      const owner = windows.createCodexProbeOwner(capturedOrdinary, "C:\\fixture");
      const failure = new HerdrCommandCleanupError([new Error("owned fixture cleanup")], undefined);
      const operation = { check: () => {} } as Parameters<typeof owner.observe>[1];
      await expect(owner.observe({ file: "codex", environment: capturedOrdinary, workingDirectory: "C:\\fixture" }, operation, async () => { launch(capturedOrdinary); throw failure; })).rejects.toBe(failure);
      let callbacks = 0;
      const pending = owner.observe({ file: "codex", environment: capturedAssistant, workingDirectory: "C:\\fixture" }, operation, async () => { callbacks++; return launch(capturedAssistant).target; });
      if (same) { await expect(pending).rejects.toBe(failure); expect(callbacks).toBe(0); }
      else { expect(await pending).toBe(second.target); expect(callbacks).toBe(1); }
    });
  }
});
