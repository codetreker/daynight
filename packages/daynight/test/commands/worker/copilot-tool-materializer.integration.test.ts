import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import { createCopilotToolMaterializer } from "../../../src/commands/worker/copilot-tool-materializer.js";
import { fingerprintToolArtifact, resolveToolLaunch, type ToolArtifact } from "../../../src/platform/tool-executables.js";
import { parseResolvedToolLaunch } from "../../../src/platform/tool-launch-record.js";

// Qualification is controlled. Publication, ownership, complete tree reads and the
// extraction subprocess are real; this does not qualify a native Copilot build.
const controlled = vi.hoisted(() => ({
  beforeOpen: undefined as ((file: string) => Promise<void>) | undefined,
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined,
  afterRead: undefined as ((file: string, operation: Operation) => void) | undefined,
  source: "", support: [] as ToolArtifact[], preload: "", supportFailure: false, cleanup: undefined as ((proof: { pid: number }) => Promise<void>) | undefined }));
// Keep real filesystem descriptors and mutations; gates control only the race window.
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => { await controlled.beforeOpen?.(String(args[0])); return actual.open(...args); },
    rename: async (...args: Parameters<typeof actual.rename>) => { await controlled.beforeRename?.(String(args[0]), String(args[1])); return actual.rename(...args); },
  };
});
vi.mock("../../../src/platform/tool-runtime-io.js", async original => {
  const actual = await original<typeof import("../../../src/platform/tool-runtime-io.js")>();
  return { ...actual, readToolRuntimeText: async (...args: Parameters<typeof actual.readToolRuntimeText>) => {
    const result = await actual.readToolRuntimeText(...args); controlled.afterRead?.(args[0], args[1]); return result;
  } };
});
const files = { "index.js": "export const fixture = true;\n", "cli-main.js": "export const main = true;\n", "prebuilds/darwin-arm64/runtime.node": "fixture-addon\n", "data/resource.txt": "complete distribution\n" };
vi.mock("../../../src/platform/tool-runtime-profile.js", async original => {
  const actual = await original<typeof import("../../../src/platform/tool-runtime-profile.js")>();
  const { createHash } = await import("node:crypto");
  const content = { "index.js": "export const fixture = true;\n", "cli-main.js": "export const main = true;\n", "prebuilds/darwin-arm64/runtime.node": "fixture-addon\n" };
  return { ...actual, copilotRuntimeCatalogue: { ...actual.copilotRuntimeCatalogue, files: Object.fromEntries(Object.entries(content).map(([name, text]) => [name, createHash("sha256").update(text).digest("hex")])) },
    isCopilotAuthoritySource: (source: { executablePath: string }) => source.executablePath === controlled.source,
    captureCopilotSupport: async () => { if (controlled.supportFailure) throw new Error("fixture support unavailable"); return { artifacts: controlled.support, preloadPath: controlled.preload }; },
  };
});
vi.mock("../../../src/commands/worker/tool-extraction.js", async original => {
  const actual = await original<typeof import("../../../src/commands/worker/tool-extraction.js")>();
  return { ...actual, stopExtraction: (proof: import("../../../src/commands/controller/process-proof.js").ProcessProof) => controlled.cleanup ? controlled.cleanup(proof) : actual.stopExtraction(proof) };
});
vi.mock("../../../src/platform/tool-executables.js", async original => {
  const actual = await original<typeof import("../../../src/platform/tool-executables.js")>();
  return { ...actual, verifyToolLaunch: async (launch: import("../../../src/platform/tool-executables.js").ResolvedToolLaunch, operation: Operation, options?: { trustedRuntimeRoot?: string }) => {
    if (!launch.runtimeProfile) return actual.verifyToolLaunch(launch, operation, options);
    // The test catalogue controls native qualification only. Keep the final
    // strict record, private root and full filesystem manifest validation real.
    const { parseResolvedToolLaunch } = await import("../../../src/platform/tool-launch-record.js");
    const { verifyPrivateRuntimeDirectory, readRuntimeManifest } = await import("../../../src/platform/tool-runtime-profile.js");
    parseResolvedToolLaunch(launch);
    await actual.verifyToolLaunch(launch.runtimeProfile.sourceLaunch, operation);
    await verifyPrivateRuntimeDirectory(launch.runtimeProfile.root, options!.trustedRuntimeRoot!, operation);
    await readRuntimeManifest(launch.runtimeProfile.root, launch.runtimeProfile.materializationKey, operation);
  } };
});
const execute = promisify(execFile), roots: string[] = [], operations: Operation[] = [];
const op = () => { const value = createOperation({ limits: { totalMs: 30_000 } }); operations.push(value); return value; };
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-materializer-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  const native = path.join(root, "extract-fixture"), source = path.join(root, "extract.c"), marker = path.join(root, "runs");
  const declarations = Object.entries(files).map(([name, text]) => `write_data(base, ${JSON.stringify(name)}, ${JSON.stringify(text)});`).join("\n");
  await writeFile(source, `#include <sys/stat.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <errno.h>\nvoid directory(const char *p){if(mkdir(p,0700)&&errno!=EEXIST)exit(21);}\nvoid write_data(const char *base,const char *name,const char *data){char p[8192];snprintf(p,sizeof(p),"%s/%s",base,name);FILE*f=fopen(p,"wb");if(!f)exit(22);fwrite(data,1,strlen(data),f);fclose(f);}\nint main(int argc,char **argv){if(argc!=3||strcmp(argv[1],"--binary-version")||strcmp(argv[2],"--no-auto-update"))return 23;FILE*m=fopen(getenv("FIXTURE_MARKER"),"a");if(!m)return 24;fputs("extract\\n",m);fclose(m);if(getenv("FIXTURE_FAIL"))return 25;const char*cache=getenv("COPILOT_PKG_CACHE_HOME");if(!cache||!getenv("COPILOT_SEA_EXTRACT_ONLY"))return 26;char p[8192],base[8192];snprintf(p,sizeof(p),"%s/pkg",cache);directory(p);snprintf(p,sizeof(p),"%s/pkg/darwin-arm64",cache);directory(p);snprintf(base,sizeof(base),"%s/pkg/darwin-arm64/1.0.105",cache);directory(base);snprintf(p,sizeof(p),"%s/prebuilds",base);directory(p);snprintf(p,sizeof(p),"%s/prebuilds/darwin-arm64",base);directory(p);snprintf(p,sizeof(p),"%s/data",base);directory(p);${declarations}\nreturn 0;}\n`);
  await execute("/usr/bin/cc", [source, "-o", native], { timeout: 15_000 }); await chmod(native, 0o755);
  const launch = await resolveToolLaunch({ tool: "copilot", context: "web", choice: { kind: "path", path: native }, cwd: root, environment: process.env }, op());
  controlled.source = launch.executablePath;
  const preload = path.join(root, "preload.mjs"); await writeFile(preload, "// controlled adapter\n"); controlled.preload = await realpath(preload);
  controlled.support = [await fingerprintToolArtifact({ role: "interpreter", path: await realpath(process.execPath) }, op()), await fingerprintToolArtifact({ role: "support", path: controlled.preload }, op())];
  const workerDirectory = path.join(root, "worker"), environment = { ...process.env, FIXTURE_MARKER: marker };
  const create = (extra: NodeJS.ProcessEnv = {}) => createCopilotToolMaterializer({ workerDirectory, environment: { ...environment, ...extra } });
  const count = async () => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { root, launch, native, workerDirectory, create, count };
};
beforeEach(() => { controlled.source = ""; controlled.support = []; controlled.preload = ""; controlled.supportFailure = false; controlled.cleanup = undefined; controlled.beforeOpen = undefined; controlled.beforeRename = undefined; controlled.afterRead = undefined; });
afterEach(async () => { controlled.beforeOpen = undefined; controlled.beforeRename = undefined; controlled.afterRead = undefined; for (const operation of operations.splice(0)) operation.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const supported = process.platform === "darwin";
const rejectHistoricalCleanup = () => {
  const cleanup = vi.fn(async () => { throw new Error("The historical extraction PID now belongs to another process."); });
  controlled.cleanup = cleanup; return cleanup;
};

test.skipIf(!supported)("materialization reuses the complete publication across instances and aliases without reclaiming a historical process", async () => {
  const f = await fixture(), materializer = f.create();
  try {
    const launch = await materializer.prepare(f.launch, op()); expect(parseResolvedToolLaunch(launch)).toEqual(launch);
    expect(launch.runtimeProfile?.sourceLaunch).toEqual(f.launch);
    expect(await readFile(path.join(launch.runtimeProfile!.root, "distribution/data/resource.txt"), "utf8")).toBe(files["data/resource.txt"]);
    const manifest = JSON.parse(await readFile(launch.runtimeProfile!.manifestPath, "utf8"));
    expect(manifest.entries.find((item: { path: string }) => item.path === "data/resource.txt").sha256).toBe(createHash("sha256").update(files["data/resource.txt"]).digest("hex"));
    const cleanup = rejectHistoricalCleanup();
    await materializer.close(op());
    const alias = path.join(f.root, "alias"); await symlink(f.native, alias);
    const aliased = await resolveToolLaunch({ tool: "copilot", context: "web", choice: { kind: "path", path: alias }, cwd: f.root, environment: process.env }, op());
    const restarted = f.create();
    try {
      const restored = await restarted.prepare(aliased, op());
      expect(restored.runtimeProfile!.root).toBe(launch.runtimeProfile!.root);
      expect(restored.selectionKey).not.toBe(launch.selectionKey); expect(await f.count()).toBe(1);
    } finally { await restarted.close(op()); }
    expect(await readFile(launch.runtimeProfile!.manifestPath, "utf8")).toContain("data/resource.txt");
    expect(cleanup).not.toHaveBeenCalled();
  } finally { await materializer.close(op()); }
}, 30_000);

test.skipIf(!supported)("confirmed failed extraction releases its reservation and never reclaims its historical process on retry", async () => {
  const f = await fixture(), materializer = f.create({ FIXTURE_FAIL: "1" });
  try {
    controlled.supportFailure = true;
    await expect(materializer.prepare(f.launch, op())).rejects.toMatchObject({ code: "io_error" }); expect(await f.count()).toBe(0);
    controlled.supportFailure = false;
    await expect(materializer.prepare(f.launch, op())).rejects.toMatchObject({ code: "io_error" }); expect(await f.count()).toBe(1);
    const cleanup = rejectHistoricalCleanup();
    await materializer.close(op());
    const records = path.join(f.workerDirectory, "tool-runtimes/.preparations");
    const names = (await readdir(records)).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(records, names[0]!), "utf8"))).toMatchObject({ state: "failed", reservedBytes: 0 });
    const recovered = f.create(); try { await recovered.prepare(f.launch, op()); expect(await f.count()).toBe(2); } finally { await recovered.close(op()); }
    expect(cleanup).not.toHaveBeenCalled();
  } finally { await materializer.close(op()); }
}, 30_000);

test.skipIf(!supported)("an extracted publication reconciles without extraction or historical cleanup, while corruption is rejected", async () => {
  const f = await fixture(), materializer = f.create();
  const launch = await materializer.prepare(f.launch, op()); await materializer.close(op());
  const profile = launch.runtimeProfile!, record = path.join(f.workerDirectory, `tool-runtimes/.preparations/${profile.materializationKey}.json`);
  const row = JSON.parse(await readFile(record, "utf8"));
  await writeFile(record, JSON.stringify({ ...row, state: "extracted", reservedBytes: 536_870_912 }), { mode: 0o600 });
  const cleanup = rejectHistoricalCleanup();
  const restarted = f.create();
  try {
    expect((await restarted.prepare(f.launch, op())).selectionKey).toBe(launch.selectionKey);
    expect(await f.count()).toBe(1); expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({ state: "published", reservedBytes: 0 });
    await writeFile(path.join(profile.root, "distribution/unlisted"), "corrupt");
    await expect(restarted.prepare(f.launch, op())).rejects.toMatchObject({ code: "io_error" }); expect(await f.count()).toBe(1);
    expect(cleanup).not.toHaveBeenCalled();
  } finally { await restarted.close(op()); }
}, 30_000);

test.skipIf(!supported)("all durable reservations count before another extraction and confirmed shutdown releases failed staging", async () => {
  const f = await fixture(), root = path.join(f.workerDirectory, "tool-runtimes"), records = path.join(root, ".preparations");
  await mkdir(records, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  for (let index = 0; index < 4; index++) {
    const key = String(index).repeat(64);
    await writeFile(path.join(records, `${key}.json`), JSON.stringify({ schemaVersion: 1, key, preparationId: randomUUID(), state: "reserved", reservedBytes: 536_870_912 }), { mode: 0o600 });
  }
  const materializer = f.create();
  await expect(materializer.prepare(f.launch, op())).rejects.toMatchObject({ code: "io_error", cause: expect.objectContaining({ message: expect.stringContaining("2 GiB") }) });
  expect(await f.count()).toBe(0); await materializer.close(op());
  const restarted = f.create(); try { await restarted.prepare(f.launch, op()); expect(await f.count()).toBe(1); } finally { await restarted.close(op()); }
}, 30_000);


const preparation = async (directory: string, key: string, pid: number) => {
  const preparationId = randomUUID(), root = path.join(directory, "tool-runtimes"), records = path.join(root, ".preparations");
  await mkdir(records, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const row = { schemaVersion: 1, key, preparationId, state: "extracting", reservedBytes: 536_870_912 };
  await writeFile(path.join(records, `${key}.json`), JSON.stringify(row), { mode: 0o600 });
  await writeFile(path.join(records, `${key}-${preparationId}.proof`), JSON.stringify({ schemaVersion: 1, preparationId, proof: { pid, parentPid: 123, processGroupId: pid, startedAt: "fixture-birth", commandHash: "a".repeat(64) } }), { mode: 0o600 });
  return { row, file: path.join(records, `${key}.json`) };
};

test.skipIf(!supported)("shutdown joins every historical extraction owner when an earlier owner remains unknown", async () => {
  const f = await fixture(), first = await preparation(f.workerDirectory, "a".repeat(64), 100001), second = await preparation(f.workerDirectory, "b".repeat(64), 100002);
  const cleanup = vi.fn(async ({ pid }: { pid: number }) => { if (pid === 100001) throw new Error("original scope is unknown"); }); controlled.cleanup = cleanup;
  const materializer = f.create();
  await expect(materializer.close(op())).rejects.toThrow();
  expect(cleanup.mock.calls.map(([proof]) => proof.pid)).toEqual([100001, 100002]);
  expect(JSON.parse(await readFile(first.file, "utf8"))).toEqual(first.row);
  expect(JSON.parse(await readFile(second.file, "utf8"))).toMatchObject({ state: "failed", reservedBytes: 0 });
});

test.skipIf(!supported)("an unconfirmed extraction retains its preparation and reservation instead of starting another helper", async () => {
  const f = await fixture();
  const { copilotMaterializationKey } = await import("../../../src/platform/tool-runtime-profile.js");
  const key = copilotMaterializationKey(f.launch, controlled.support), existing = await preparation(f.workerDirectory, key, 100003);
  controlled.cleanup = async () => { throw new Error("original scope is unknown"); };
  const materializer = f.create();
  try {
    await expect(materializer.prepare(f.launch, op())).rejects.toMatchObject({ code: "cleanup_unknown" });
    expect(await f.count()).toBe(0);
    expect(JSON.parse(await readFile(existing.file, "utf8"))).toEqual(existing.row);
  } finally { controlled.cleanup = async () => {}; await materializer.close(op()); }
});


const recordFixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-materializer-tests");
  await mkdir(base, { recursive: true }); const workerDirectory = await mkdtemp(path.join(base, "records-")); roots.push(workerDirectory);
  const records = path.join(workerDirectory, "tool-runtimes/.preparations"); await mkdir(records, { recursive: true, mode: 0o700 });
  const record = async (key: string) => {
    const row = { schemaVersion: 1, key, preparationId: randomUUID(), state: "reserved", reservedBytes: 536_870_912 };
    const file = path.join(records, `${key}.json`); await writeFile(file, JSON.stringify(row), { mode: 0o600 }); return { file, row };
  };
  return { workerDirectory, record, materializer: createCopilotToolMaterializer({ workerDirectory, environment: process.env }) };
};
const cancellableOperation = (signal: AbortSignal) => {
  const result = createOperation({ signal, limits: { totalMs: 5000 } }); operations.push(result); return result;
};
const deferred = () => {
  let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve };
};

test("shutdown record enumeration shares its caller budget and stops before reading the next owner", async () => {
  const f = await recordFixture(), first = await f.record("a".repeat(64)); await f.record("b".repeat(64));
  const controller = new AbortController(), reads: string[] = [];
  controlled.afterRead = (file, operation) => { if (!file.endsWith(".json")) return; reads.push(file); expect(operation.signal.aborted).toBe(false); controller.abort(); };
  await expect(f.materializer.close(cancellableOperation(controller.signal))).rejects.toMatchObject({ kind: "cancelled" });
  expect(reads).toEqual([first.file]);
  expect(JSON.parse(await readFile(first.file, "utf8"))).toEqual(first.row);
});

test.skipIf(process.platform === "win32")("runtime fsync rejects a writerless FIFO swapped after lstat without blocking an open", async () => {
  const f = await recordFixture(), file = path.join(f.workerDirectory, "sync-target"); await writeFile(file, "original");
  controlled.beforeOpen = async target => {
    if (target !== file) return; controlled.beforeOpen = undefined;
    await rm(file); await execute("mkfifo", [file], { timeout: 1000 });
  };
  const { syncRuntimeTree } = await import("../../../src/platform/tool-runtime-profile.js");
  const operation = createOperation({ limits: { totalMs: 1000 } }); operations.push(operation);
  await expect(syncRuntimeTree(file, operation)).rejects.toThrow("Copilot frozen runtime identity is invalid.");
});

test.skipIf(process.platform === "win32")("an unconfirmed record rename blocks later cleanup and retains its reservation until observed", async () => {
  const f = await recordFixture(), existing = await f.record("a".repeat(64));
  const entered = deferred(), release = deferred(), controller = new AbortController(); let writes = 0, reads = 0;
  controlled.afterRead = file => { if (file === existing.file) reads++; };
  controlled.beforeRename = async (_from, to) => { if (to !== existing.file) return; writes++; entered.resolve(); await release.promise; };
  const first = f.materializer.close(cancellableOperation(controller.signal)); void first.catch(() => {});
  try {
    await entered.promise; controller.abort(); await expect(first).rejects.toThrow();
    const readsBeforeRetry = reads;
    expect(JSON.parse(await readFile(existing.file, "utf8"))).toEqual(existing.row);
    const retryController = new AbortController(), retry = f.materializer.close(cancellableOperation(retryController.signal)); void retry.catch(() => {});
    await new Promise<void>(resolve => setImmediate(resolve)); retryController.abort();
    await expect(retry).rejects.toMatchObject({ kind: "cancelled" });
    expect(writes).toBe(1); expect(reads).toBe(readsBeforeRetry);
    expect(JSON.parse(await readFile(existing.file, "utf8"))).toEqual(existing.row);
  } finally {
    controlled.beforeRename = undefined; release.resolve(); await first.catch(() => {});
    await f.materializer.close(op());
  }
  expect(JSON.parse(await readFile(existing.file, "utf8"))).toMatchObject({ state: "failed", reservedBytes: 0 });
});
