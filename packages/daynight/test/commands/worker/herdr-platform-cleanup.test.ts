import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

const project = path.resolve(import.meta.dirname, "../../../../..");
const withCleanup = async (change: (evidence: Record<string, unknown>, directory: string) => Promise<void>, verify: (status: number | null, result: { failures: string[] }) => void) => {
  const scratch = path.join(project, ".tmp/herdr-tools/research-platform/cleanup-script-tests");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "checker-")), scripts = path.join(root, "packages/daynight/scripts"), directory = path.join(root, ".tmp/herdr-tools/research-platform");
  try {
    await mkdir(scripts, { recursive: true }); await mkdir(directory, { recursive: true });
    const script = path.join(scripts, "check-herdr-platform-cleanup.mjs");
    await copyFile(path.join(project, "packages/daynight/scripts/check-herdr-platform-cleanup.mjs"), script);
    const completed = JSON.stringify({ cleanup: { runtimeDirectoryRemoved: true, originalProcesses: [] } });
    for (const name of ["codex", "copilot", "argv-codex"]) await writeFile(path.join(directory, `acceptance-${name}-fixture.json`), completed);
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 5000 });
    expect(child.status).toBe(0);
    const evidence = { schemaVersion: 1, source: "isolated-ps5-dotnet-oracle", platform: "win32", pid: Number(child.stdout), directory: path.join(directory, "removed-oracle"), closed: true, runtimeDirectoryRemoved: true };
    await change(evidence, directory);
    const record = path.join(directory, "acceptance-windows-metadata-fixture.json");
    await writeFile(record, JSON.stringify(evidence));
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 5000 });
    verify(run.status, JSON.parse(await readFile(path.join(directory, "cleanup.json"), "utf8")));
  } finally { await rm(root, { recursive: true, force: true }); }
};

test("independently accepts a closed original oracle process and a removed private directory", async () => {
  await withCleanup(async () => {}, (status, result) => { expect(status).toBe(0); expect(result.failures).toEqual([]); });
});

test.each(["live", "close-unknown", "retained", "directory-present", "identity-missing"])("fails independent cleanup for %s native metadata evidence", async kind => {
  await withCleanup(async evidence => {
    if (kind === "live") evidence.pid = process.pid;
    if (kind === "close-unknown") evidence.closed = false;
    if (kind === "retained") evidence.runtimeDirectoryRemoved = false;
    if (kind === "directory-present") await mkdir(evidence.directory as string);
    if (kind === "identity-missing") evidence.pid = null;
  }, (status, result) => { expect(status).not.toBe(0); expect(result.failures).toContain("acceptance-windows-metadata-fixture.json"); });
});

test.each(["closed", "close-unknown", "cleanup-unknown"])("independently checks %s query cleanup alongside formal resources", async kind => {
  await withCleanup(async (_evidence, directory) => {
    const file = path.join(directory, "acceptance-codex-fixture.json"), run = JSON.parse(await readFile(file, "utf8"));
    run.cleanup.windowsQueries = [{ stage: "external-script", closed: kind !== "close-unknown", cleanupConfirmed: kind !== "cleanup-unknown" }];
    await writeFile(file, JSON.stringify(run));
  }, (status, result) => {
    if (kind === "closed") { expect(status).toBe(0); expect(result.failures).toEqual([]); }
    else { expect(status).not.toBe(0); expect(result.failures).toContain("acceptance-codex-fixture.json"); }
  });
});
