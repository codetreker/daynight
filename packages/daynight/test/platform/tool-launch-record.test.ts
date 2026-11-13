import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { pathToFileURL } from "node:url";
import { createOperation } from "../../src/api/operation.js";
import { resolveToolLaunch, toolSelectionKey, verifyToolLaunch, probeResourceKey } from "../../src/platform/tool-executables.js";
import { parseResolvedToolLaunch } from "../../src/platform/tool-launch-record.js";

test("persisted tool recipes strictly preserve identity and provider context", async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/tool-record-tests");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "record-")), entry = path.join(root, "codex.cjs"), operation = createOperation();
  try {
    await writeFile(entry, "console.log('fixture');\n");
    const launch = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: entry }, cwd: root, environment: process.env }, operation);
    expect(parseResolvedToolLaunch(JSON.parse(JSON.stringify(launch)), { tool: "codex", context: "web" })).toEqual(launch);
    const reordered = { ...launch, command: { prefixArgs: launch.command.prefixArgs, file: launch.command.file }, artifacts: launch.artifacts.map(item => ({ sha256: item.sha256, size: item.size, realPath: item.realPath, path: item.path, role: item.role })) };
    expect(parseResolvedToolLaunch(reordered)).toEqual(launch);
    await expect(verifyToolLaunch(reordered, operation)).resolves.toBeUndefined();
    expect(probeResourceKey(reordered, { cwd: root, environment: process.env })).toBe(probeResourceKey(launch, { cwd: root, environment: process.env }));
    expect(() => parseResolvedToolLaunch(launch, { tool: "copilot", context: "web" })).toThrow();
    expect(() => parseResolvedToolLaunch({ ...launch, unknown: true })).toThrow();
    expect(() => parseResolvedToolLaunch({ ...launch, command: { ...launch.command, prefixArgs: ["--eval", "wrong"] } })).toThrow();
    const relative = { ...launch, entryPath: "relative.cjs" }; relative.selectionKey = toolSelectionKey(relative);
    expect(() => parseResolvedToolLaunch(relative)).toThrow();
    const extra = { ...launch, artifacts: [...launch.artifacts, launch.artifacts[0]!] }; extra.selectionKey = toolSelectionKey(extra);
    expect(() => parseResolvedToolLaunch(extra)).toThrow();
  } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("authority records bind the source recipe and exact Node/preload command without recursive profiles", async () => {
  const operation = createOperation();
  try {
    const sourceLaunch = await resolveToolLaunch({ tool: "copilot", context: "web", choice: { kind: "path", path: process.execPath }, cwd: process.cwd(), environment: process.env }, operation);
    const root = path.resolve("authority-root", "a".repeat(64)), entry = path.join(root, "distribution", "index.js"), preload = path.resolve("preload.js");
    const launch = { ...sourceLaunch, executablePath: entry, interpreterPath: sourceLaunch.executablePath,
      command: { file: sourceLaunch.executablePath, prefixArgs: ["--import", pathToFileURL(preload).href, entry] },
      artifacts: [...sourceLaunch.artifacts,
        { role: "interpreter" as const, path: sourceLaunch.executablePath, realPath: sourceLaunch.executablePath, size: sourceLaunch.artifacts[0]!.size, sha256: sourceLaunch.artifacts[0]!.sha256 },
        { role: "entry" as const, path: entry, realPath: entry, size: "1", sha256: "b".repeat(64) },
        { role: "support" as const, path: preload, realPath: preload, size: "1", sha256: "c".repeat(64) },
        { role: "manifest" as const, path: path.join(root, "manifest.json"), realPath: path.join(root, "manifest.json"), size: "1", sha256: "d".repeat(64) }],
      runtimeProfile: { kind: "copilot-read-authority-v1" as const, sourceLaunch, materializationKey: "a".repeat(64), root, manifestPath: path.join(root, "manifest.json"), preloadPath: preload, sdkVersion: "1.0.11" as const, authorityProtocol: "daynight.copilot.read.v1" as const } };
    launch.selectionKey = toolSelectionKey(launch);
    expect(parseResolvedToolLaunch(launch)).toEqual(launch);
    const changed = structuredClone(launch); changed.runtimeProfile.sourceLaunch.source = "path";
    expect(toolSelectionKey(changed)).toBe(launch.selectionKey);
    expect(() => parseResolvedToolLaunch({ ...launch, runtimeProfile: { ...launch.runtimeProfile, sourceLaunch: launch } })).toThrow();
    const wrong = { ...launch, command: { ...launch.command, prefixArgs: [entry] } }; wrong.selectionKey = toolSelectionKey(wrong);
    expect(() => parseResolvedToolLaunch(wrong)).toThrow();
  } finally { operation.dispose(); }
});
