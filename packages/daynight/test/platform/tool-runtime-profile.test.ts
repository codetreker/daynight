import path from "node:path";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createOperation } from "../../src/api/operation.js";
import { captureCopilotSupport, captureRuntimeTree, copilotPreloadFiles, readRuntimeManifest, verifyPrivateRuntimeDirectory } from "../../src/platform/tool-runtime-profile.js";

test("runtime manifest covers every file and empty directory and rejects mutation and extra files", async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/runtime-tree-tests");
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, "tree-"));
  const operation = createOperation();
  try {
    const distribution = path.join(root, "distribution"); await mkdir(distribution); await mkdir(path.join(distribution, "empty"));
    const entry = path.join(distribution, "index.js"); await writeFile(entry, "hello");
    const entries = await captureRuntimeTree(distribution, operation);
    expect(entries.map(item => [item.path, item.type])).toEqual([["empty", "directory"], ["index.js", "file"]]);
    const key = "a".repeat(64), manifest = { schemaVersion: 1, kind: "copilot-read-authority-v1", materializationKey: key, entries };
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const frozenManifestDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    expect(await readRuntimeManifest(root, key, operation, frozenManifestDigest)).toEqual(manifest);
    await writeFile(entry, "HELLO"); await expect(readRuntimeManifest(root, key, operation)).rejects.toThrow();
    // Replacing both the file and manifest after the frozen fingerprint still
    // must not grant an old recipe a different internally consistent tree.
    const replacement = { ...manifest, entries: await captureRuntimeTree(distribution, operation) };
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(replacement));
    expect(await readRuntimeManifest(root, key, operation)).toEqual(replacement);
    await expect(readRuntimeManifest(root, key, operation, frozenManifestDigest)).rejects.toThrow();
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
    await writeFile(entry, "hello"); await writeFile(path.join(distribution, "extra"), "extra");
    await expect(readRuntimeManifest(root, key, operation)).rejects.toThrow(); await rm(path.join(distribution, "extra"));
    await chmod(entry, 0o700); await expect(readRuntimeManifest(root, key, operation)).rejects.toThrow();
    await rm(entry); await symlink(path.join(root, "manifest.json"), entry); await expect(captureRuntimeTree(distribution, operation)).rejects.toThrow();
  } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("runtime admission rejects self-declared roots and symlink/private-directory violations", async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/runtime-tree-tests");
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, "private-")), operation = createOperation();
  try {
    const child = path.join(root, "a".repeat(64)); await mkdir(child, { mode: 0o700 });
    await verifyPrivateRuntimeDirectory(child, root, operation);
    await expect(verifyPrivateRuntimeDirectory(child, path.join(root, "other"), operation)).rejects.toThrow();
    await chmod(child, 0o755); await expect(verifyPrivateRuntimeDirectory(child, root, operation)).rejects.toThrow();
    await rm(child, { recursive: true }); await symlink(root, child); await expect(verifyPrivateRuntimeDirectory(child, root, operation)).rejects.toThrow();
  } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); }
});


test("frozen preload closure remains at its original path and refuses dynamic dependencies", async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/runtime-tree-tests");
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, "support-")), operation = createOperation();
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    const controller = path.join(root, "controller");
    for (const file of copilotPreloadFiles) {
      await mkdir(path.dirname(path.join(controller, file)), { recursive: true });
      await writeFile(path.join(controller, file), await readFile(path.resolve(import.meta.dirname, "../../dist/commands/controller", file)));
    }
    const sdkManifestPath = path.join(root, "sdk", "package.json"); await mkdir(path.dirname(sdkManifestPath));
    await writeFile(sdkManifestPath, JSON.stringify({ name: "@github/copilot-sdk", version: "1.0.11" }));
    const preloadPath = path.join(controller, copilotPreloadFiles[0]);
    const support = await captureCopilotSupport(process.execPath, operation, { preloadPath, sdkManifestPath });
    expect(support.preloadPath).toBe(preloadPath);
    expect(support.artifacts.filter(item => item.role === "support")).toHaveLength(8);
    const server = path.join(controller, copilotPreloadFiles[1]), original = await readFile(server, "utf8");
    await writeFile(server, original + "\nawait import(process.env.UNFROZEN_MODULE);\n");
    await expect(captureCopilotSupport(process.execPath, operation, { preloadPath, sdkManifestPath })).rejects.toThrow();
    await writeFile(server, original); await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "commonjs" }));
    await expect(captureCopilotSupport(process.execPath, operation, { preloadPath, sdkManifestPath })).rejects.toThrow();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await truncate(server, 1_048_577);
    await expect(captureCopilotSupport(process.execPath, operation, { preloadPath, sdkManifestPath })).rejects.toThrow();
    if (process.platform !== "win32") {
      await rm(server); await promisify(execFile)("mkfifo", [server], { timeout: 5000 });
      await expect(captureCopilotSupport(process.execPath, operation, { preloadPath, sdkManifestPath })).rejects.toMatchObject({ code: "not_executable" });
    }
  } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); }
});


test("compiled authority adapters have only the declared static runtime imports", async () => {
  const controller = path.resolve(import.meta.dirname, "../../dist/commands/controller");
  const files = copilotPreloadFiles.map(file => path.join(controller, file)), allowed = new Set(files);
  // V8 parses the built modules without linking or evaluating the preload.
  const code = `import {SourceTextModule} from 'node:vm'; import {readFile} from 'node:fs/promises';
    const result=[]; for(const file of process.argv.slice(1)) result.push(new SourceTextModule(await readFile(file,'utf8')).dependencySpecifiers);
    process.stdout.write(JSON.stringify(result));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", code, ...files], { timeout: 10_000, maxBuffer: 65536 });
  const dependencies = JSON.parse(stdout) as string[][];
  expect(dependencies).toHaveLength(files.length);
  for (const [index, specifiers] of dependencies.entries()) for (const specifier of specifiers) {
    expect(specifier.startsWith("node:") || allowed.has(path.resolve(path.dirname(files[index]!), specifier)), `${files[index]}: ${specifier}`).toBe(true);
  }
});
