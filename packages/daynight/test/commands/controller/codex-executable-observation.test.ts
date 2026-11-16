import { expect, test } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
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
