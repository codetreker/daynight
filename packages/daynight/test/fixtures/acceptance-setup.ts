import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { createInstalledCli } from "./installed-cli.js";

const packageDigest = async (directory: string): Promise<string> => {
  const hash = createHash("sha256");
  const entries = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  for (const filename of entries) {
    hash.update(path.relative(directory, filename));
    hash.update("\0");
    hash.update(await readFile(filename));
  }
  return hash.digest("hex");
};

export default async (project: TestProject): Promise<() => Promise<void>> => {
  const commands: { file: string; args: readonly string[] }[] = [];
  const evidencePath = path.resolve(import.meta.dirname, "../../../../.tmp/installed-cli-preparation.json");
  await rm(evidencePath, { force: true });
  const started = performance.now();
  const installed = await createInstalledCli({ defaultCommandShims: true, onSpawn: (child) => { commands.push({ file: child.spawnfile, args: child.spawnargs }); } });
  try {
    const packageDirectory = await realpath(path.dirname(path.dirname(installed.receipt.entryPath)));
    const originalDigest = await packageDigest(packageDirectory);
    if (commands.length !== 2) throw new Error("Shared installed acceptance must execute exactly one pack and one production install.");
    const preparation = { schemaVersion: 1, platform: process.platform, nodeVersion: process.version, elapsedMs: performance.now() - started, commands, artifact: installed.receipt };
    await writeFile(evidencePath, `${JSON.stringify({ ...preparation, cleanup: { completed: false } }, null, 2)}\n`);
    console.log(`Installed acceptance preparation: one pack and one production install (${Math.round(preparation.elapsedMs)}ms).`);
    project.provide("installedCli", installed.receipt);
    return async () => {
      const failures: unknown[] = [];
      let packageUnchanged = false;
      let installationRemoved = false;
      try {
        packageUnchanged = await packageDigest(packageDirectory) === originalDigest;
        if (!packageUnchanged) throw new Error("Shared installed CLI package was modified by an acceptance consumer.");
      } catch (cause) { failures.push(cause); }
      try { await installed.cleanup(); } catch (cause) { failures.push(cause); }
      try { await lstat(installed.receipt.root); failures.push(new Error("Shared installed CLI directory remains after cleanup.")); }
      catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") installationRemoved = true; else failures.push(cause); }
      try { await writeFile(evidencePath, `${JSON.stringify({ ...preparation, cleanup: { completed: true, installationRemoved, packageUnchanged, errors: failures.length } }, null, 2)}\n`); }
      catch (cause) { failures.push(cause); }
      if (failures.length !== 0) throw new AggregateError(failures, "Shared installed CLI validation or cleanup failed.");
    };
  } catch (cause) {
    try { await installed.cleanup(); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], "Shared installed CLI setup and cleanup failed."); }
    throw cause;
  }
};
