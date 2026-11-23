import { expect, test } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch, type ResolvedToolLaunch } from "../../../src/platform/tool-executables.js";
import { codexExecutableDigest } from "../../../src/commands/controller/providers/codex-config-observation.js";

test.skipIf(process.platform !== "win32")("Codex observation uses the verified direct executable artifact, never a fallback or interpreter", async () => {
  const operation = createOperation();
  const launch = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: process.execPath }, cwd: process.cwd(), environment: process.env, workerNode: process.execPath }, operation).finally(() => operation.dispose());
  expect(codexExecutableDigest(launch, launch.command.file)).toBe(launch.artifacts.find(item => item.realPath === launch.executablePath)!.sha256);
  expect(codexExecutableDigest(undefined, launch.command.file)).toBeNull();
  expect(codexExecutableDigest(launch, "other.exe")).toBeNull();
  expect(codexExecutableDigest(launch, launch.command.file, "linux")).toBeNull();
  expect(codexExecutableDigest({ ...launch, interpreterPath: launch.command.file }, launch.command.file)).toBeNull();
  expect(codexExecutableDigest({ ...launch, command: { ...launch.command, prefixArgs: ["--config", "other"] } }, launch.command.file)).toBeNull();
});

const machOLaunch = (): ResolvedToolLaunch => {
  const real = "/Users/u/.codex/packages/standalone/releases/0.170.0-aarch64-apple-darwin/bin/codex";
  return { schemaVersion: 1, tool: "codex", context: "web", source: "path", entryPath: "/Users/u/.local/bin/codex", canonicalEntryPath: real, executablePath: real, interpreterPath: null,
    command: { file: real, prefixArgs: [] }, artifacts: [{ role: "entry", path: "/Users/u/.local/bin/codex", realPath: real, size: "1024", sha256: "a".repeat(64) }], selectionKey: "key" };
};

test("Codex observation on macOS uses the realpath of a verified direct Mach-O entry", () => {
  const launch = machOLaunch();
  expect(codexExecutableDigest(launch, launch.command.file, "darwin")).toBe("a".repeat(64));
});

test("Codex observation on macOS keeps every indirect or ambiguous launch unknown", () => {
  const launch = machOLaunch(), file = launch.command.file, artifact = launch.artifacts[0]!;
  const unknown: ResolvedToolLaunch[] = [
    { ...launch, tool: "copilot" },
    { ...launch, context: "cli" as unknown as ResolvedToolLaunch["context"] },
    { ...launch, interpreterPath: "/usr/local/bin/node" },
    { ...launch, command: { ...launch.command, prefixArgs: ["--config", "other"] } },
    { ...launch, runtimeProfile: {} as NonNullable<ResolvedToolLaunch["runtimeProfile"]> },
    { ...launch, artifacts: [] },
    { ...launch, artifacts: [{ ...artifact, role: "shim" }] },
    { ...launch, artifacts: [artifact, { ...artifact, role: "runtime", sha256: "b".repeat(64) }] },
    { ...launch, artifacts: [{ ...artifact, realPath: "/Users/u/.local/bin/codex" }] },
  ];
  for (const candidate of unknown) expect(codexExecutableDigest(candidate, file, "darwin")).toBeNull();
  expect(codexExecutableDigest(undefined, file, "darwin")).toBeNull();
  expect(codexExecutableDigest(launch, "/Users/u/.local/bin/codex", "darwin")).toBeNull();
  expect(codexExecutableDigest(launch, file, "linux")).toBeNull();
});

test("Codex observation on Windows still requires a direct .exe", () => {
  const file = "C:\\codex\\codex.exe", launch = { ...machOLaunch(), entryPath: file, canonicalEntryPath: file, executablePath: file, command: { file, prefixArgs: [] } };
  launch.artifacts = [{ ...launch.artifacts[0]!, path: file, realPath: file }];
  expect(codexExecutableDigest(launch, file, "win32")).toBe("a".repeat(64));
  const script = "C:\\codex\\codex";
  const extensionless = { ...launch, executablePath: script, command: { file: script, prefixArgs: [] }, artifacts: [{ ...launch.artifacts[0]!, realPath: script }] };
  expect(codexExecutableDigest(extensionless, script, "win32")).toBeNull();
  expect(codexExecutableDigest(launch, file, "linux")).toBeNull();
});
