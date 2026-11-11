import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createOperation, type Operation } from "../../api/operation.js";
import { fingerprintToolArtifact, toolCommand, toolSelectionKey, ToolSelectionError, verifyToolLaunch, type ResolvedToolLaunch } from "../../platform/tool-executables.js";
import { withinOperation } from "../../platform/tool-io.js";
import { readToolRuntimeText } from "../../platform/tool-runtime-io.js";
import { captureCopilotSupport, captureRuntimeTree, copilotMaterializationKey, copilotRuntimeCatalogue, isCopilotAuthoritySource,
  readRuntimeManifest, runtimeManifestLimit, runtimeTreeLimit, syncRuntimeTree, verifyPrivateRuntimeDirectory, type RuntimeManifest } from "../../platform/tool-runtime-profile.js";
import { readExtractionProof, runToolExtraction, stopExtraction } from "./tool-extraction.js";

export type ToolPreparation = { schemaVersion: 1; key: string; preparationId: string; state: "reserved" | "extracting" | "extracted" | "published" | "failed"; reservedBytes: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const totalLimit = 4 * runtimeTreeLimit;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
async function exists(file: string, operation: Operation): Promise<boolean> { try { await withinOperation(lstat(file), operation); return true; } catch (error) { if (missing(error)) return false; throw error; } }
async function syncDirectory(directory: string, operation: Operation): Promise<void> {
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const handle = await withinOperation(open(directory, flags), operation, late => late.close());
  try { await withinOperation(handle.sync(), operation); } finally { await withinOperation(handle.close(), operation); }
}

async function readRecordText(file: string, operation: Operation, limit = 4096): Promise<string> {
  return readToolRuntimeText(file, operation, { limit, private: true });
}

/** On an uncertain rename, only an exact observation can confirm the write. */
async function persistRecord(file: string, value: unknown, operation: Operation): Promise<void> {
  operation.check();
  const data = JSON.stringify(value), temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { operation.check(); await handle.writeFile(data); operation.check(); await handle.sync(); } finally { await handle.close(); }
    operation.check(); await rename(temp, file); await syncDirectory(path.dirname(file), operation);
    if (await readRecordText(file, operation, runtimeManifestLimit) !== data) throw new Error("Runtime preparation readback differs.");
  } catch (error) {
    if (await readRecordText(file, operation, runtimeManifestLimit).catch(() => undefined) !== data) throw error;
    await syncDirectory(path.dirname(file), operation);
  } finally { await rm(temp, { force: true }); }
}
async function readPreparation(file: string, operation: Operation): Promise<ToolPreparation> {
  const row = JSON.parse(await readRecordText(file, operation)) as ToolPreparation;
  if (!row || Object.keys(row).sort().join() !== "key,preparationId,reservedBytes,schemaVersion,state" || row.schemaVersion !== 1
    || !/^[a-f0-9]{64}$/.test(row.key) || path.basename(file) !== `${row.key}.json` || !uuid.test(row.preparationId)
    || !["reserved", "extracting", "extracted", "published", "failed"].includes(row.state) || row.reservedBytes !== runtimeTreeLimit && row.reservedBytes !== 0
    || (["published", "failed"].includes(row.state)) !== (row.reservedBytes === 0)) throw new Error("Invalid runtime preparation record.");
  return row;
}

/** Caller owns the existing Worker instance lock; all preparations share one queue. */
export function createCopilotToolMaterializer(options: { workerDirectory: string; workerNode?: string; environment: NodeJS.ProcessEnv }) {
  const root = path.join(options.workerDirectory, "tool-runtimes"), preparations = path.join(root, ".preparations");
  let queue: Promise<unknown> = Promise.resolve(), closing = false;
  const mutations = new Set<Promise<unknown>>();
  // Cancellation bounds the caller, not an already submitted filesystem write.
  // Keep the whole write alive until its descriptors and temporary paths settle.
  const mutate = <T>(action: () => Promise<T>, operation: Operation): Promise<T> => {
    operation.check();
    const pending = Promise.resolve().then(() => { operation.check(); return action(); });
    mutations.add(pending);
    void pending.then(() => mutations.delete(pending), () => mutations.delete(pending));
    return withinOperation(pending, operation);
  };
  const joinMutations = async (operation: Operation) => {
    operation.check();
    await withinOperation(Promise.allSettled([...mutations]), operation);
  };
  const writeRecord = (file: string, value: unknown, operation: Operation) => mutate(() => persistRecord(file, value, operation), operation);
  const records = async (operation: Operation) => {
    const result: ToolPreparation[] = [];
    for (const name of await withinOperation(readdir(preparations), operation)) {
      operation.check();
      if (name.endsWith(".json")) result.push(await readPreparation(path.join(preparations, name), operation));
    }
    return result;
  };
  const recordPath = (row: ToolPreparation) => path.join(preparations, `${row.key}.json`);
  const proofPath = (row: ToolPreparation) => path.join(preparations, `${row.key}-${row.preparationId}.proof`);
  const stagingPath = (row: ToolPreparation) => path.join(root, `.staging-${row.preparationId}`);
  const settle = async (row: ToolPreparation, operation: Operation) => {
    operation.check();
    // These states are written only after the original scope was confirmed
    // stopped. Rechecking an old PID later would mistake reuse for new debt.
    if (row.state === "extracted" || row.state === "published" || row.state === "failed") return;
    const proof = await withinOperation(readExtractionProof(proofPath(row), row.preparationId), operation);
    if (proof) await mutate(() => stopExtraction(proof), operation);
    else if (row.state !== "reserved") throw new Error("Runtime extraction lost its original process proof.");
  };
  const initialize = async (operation: Operation) => {
    await mutate(() => mkdir(root, { mode: 0o700, recursive: true }), operation); await mutate(() => mkdir(preparations, { mode: 0o700 }), operation);
    await verifyPrivateRuntimeDirectory(preparations, root, operation);
  };
  const init = async (operation: Operation) => {
    try { await initialize(operation); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await verifyPrivateRuntimeDirectory(preparations, root, operation); }
  };
  const capacity = async (operation: Operation) => {
    let used = 0;
    const all = await records(operation), reserved = new Set(all.filter(row => row.state !== "published").map(row => stagingPath(row)));
    for (const row of all) if (row.state !== "published") used += row.reservedBytes;
    for (const name of await withinOperation(readdir(root), operation)) {
      operation.check();
      if (name === ".preparations" || reserved.has(path.join(root, name))) continue;
      if (!/^[a-f0-9]{64}$/.test(name)) throw new Error("Unowned runtime staging requires reconciliation before preparing another runtime.");
      const manifest = await readRuntimeManifest(path.join(root, name), name, operation);
      used += manifest.entries.reduce((sum, item) => sum + Number(item.size), 0)
        + (await withinOperation(lstat(path.join(root, name, "manifest.json")), operation)).size;
    }
    if (used + runtimeTreeLimit > totalLimit) throw new Error("Copilot runtime storage has reached its 2 GiB limit; existing frozen runtimes are retained.");
  };
  const prepare = async (source: ResolvedToolLaunch, operation: Operation): Promise<ResolvedToolLaunch> => {
    if (!isCopilotAuthoritySource(source)) return source;
    await joinMutations(operation); await init(operation); await verifyToolLaunch(source, operation);
    const support = await captureCopilotSupport(options.workerNode ?? process.execPath, operation);
    const key = copilotMaterializationKey(source, support.artifacts), final = path.join(root, key), metadata = path.join(preparations, `${key}.json`);
    let row = await exists(metadata, operation) ? await readPreparation(metadata, operation) : undefined;
    if (row) await settle(row, operation);
    if (!await exists(final, operation)) {
      if (row) {
        if (row.state === "published") throw new Error("A published Copilot runtime is missing; it cannot be regenerated for an old recipe.");
        // A stopped incomplete attempt can be discarded. An unknown owner above
        // blocks this point, preserving its reservation and preparation identity.
        await mutate(() => rm(stagingPath(row!), { recursive: true, force: true }), operation);
        await mutate(() => rm(metadata), operation); await syncDirectory(preparations, operation); row = undefined;
      }
      await capacity(operation);
      row = { schemaVersion: 1, key, preparationId: randomUUID(), state: "reserved", reservedBytes: runtimeTreeLimit };
      await writeRecord(metadata, row, operation);
      const staging = stagingPath(row), extraction = path.join(staging, ".extract");
      await mutate(() => mkdir(staging, { mode: 0o700 }), operation); await mutate(() => mkdir(extraction, { mode: 0o700 }), operation); await syncDirectory(root, operation);
      const command = toolCommand(source, ["--binary-version", "--no-auto-update"]);
      await runToolExtraction({ node: support.artifacts[0]!.realPath, cwd: staging, proofPath: proofPath(row), preparationId: row.preparationId,
        ...command, environment: { ...options.environment, COPILOT_PKG_CACHE_HOME: extraction, COPILOT_SEA_EXTRACT_ONLY: "1", NODE_DISABLE_COMPILE_CACHE: "1", NODE_COMPILE_CACHE: undefined },
        commit: async () => { row = { ...row!, state: "extracting" }; await writeRecord(metadata, row, operation); },
      }, operation);
      await verifyToolLaunch(source, operation);
      const currentSupport = await captureCopilotSupport(options.workerNode ?? process.execPath, operation);
      if (copilotMaterializationKey(source, currentSupport.artifacts) !== key) throw new Error("Copilot runtime inputs changed during preparation.");
      row = { ...row, state: "extracted" }; await writeRecord(metadata, row, operation);
      await mutate(() => rename(path.join(extraction, "pkg", "darwin-arm64", "1.0.105"), path.join(staging, "distribution")), operation);
      await mutate(() => rm(extraction, { recursive: true }), operation);
      const entries = await captureRuntimeTree(path.join(staging, "distribution"), operation);
      for (const [file, digest] of Object.entries(copilotRuntimeCatalogue.files)) if (!entries.some(item => item.path === file && item.sha256 === digest)) throw new Error("Copilot extraction identity mismatch.");
      const manifest: RuntimeManifest = { schemaVersion: 1, kind: copilotRuntimeCatalogue.kind, materializationKey: key, entries };
      const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
      if (manifestBytes > runtimeManifestLimit || entries.reduce((sum, item) => sum + Number(item.size), 0) + manifestBytes > runtimeTreeLimit) throw new Error("Copilot runtime exceeds its reserved byte limit.");
      await writeRecord(path.join(staging, "manifest.json"), manifest, operation);
      await syncRuntimeTree(staging, operation);
      await mutate(() => rename(staging, final), operation); await syncDirectory(root, operation);
    }
    await verifyPrivateRuntimeDirectory(final, root, operation);
    await readRuntimeManifest(final, key, operation);
    if (!row) throw new Error("Published runtime has no preparation owner.");
    if (row.state !== "published") { row = { ...row, state: "published", reservedBytes: 0 }; await writeRecord(recordPath(row), row, operation); }
    const executablePath = path.join(final, "distribution", "index.js"), manifestPath = path.join(final, "manifest.json");
    const value = { ...source, executablePath, interpreterPath: support.artifacts[0]!.realPath,
      command: { file: support.artifacts[0]!.realPath, prefixArgs: ["--import", pathToFileURL(support.preloadPath).href, executablePath] },
      artifacts: [...source.artifacts, ...support.artifacts, await fingerprintToolArtifact({ role: "entry", path: executablePath }, operation), await fingerprintToolArtifact({ role: "manifest", path: manifestPath }, operation)],
      runtimeProfile: { kind: copilotRuntimeCatalogue.kind, sourceLaunch: source, materializationKey: key, root: final, manifestPath, preloadPath: support.preloadPath,
        sdkVersion: copilotRuntimeCatalogue.sdkVersion, authorityProtocol: copilotRuntimeCatalogue.authorityProtocol },
    };
    const result = { ...value, selectionKey: toolSelectionKey(value) };
    await verifyToolLaunch(result, operation, { trustedRuntimeRoot: root }); return result;
  };
  return {
    prepare(source: ResolvedToolLaunch, parent: Operation): Promise<ResolvedToolLaunch> {
      if (closing) return Promise.reject(new Error("Tool runtime materializer is closing."));
      const pending = queue.then(async () => {
        const operation = createOperation({ signal: parent.signal, limits: { totalMs: 60_000 } });
        try { return await prepare(source, operation); }
        catch (error) {
          // Reconcile all retained owners before releasing reservations. A failed
          // cleanup leaves its original record and full reservation untouched.
          let cleanupUnknown = false;
          const cleanup = createOperation({ limits: { totalMs: 10_000 } });
          try {
            await joinMutations(cleanup);
            if (await exists(preparations, cleanup)) for (const row of await records(cleanup)) if (row.state !== "published" && row.state !== "failed") {
              try {
                await settle(row, cleanup);
                if (await exists(path.join(root, row.key), cleanup)) continue;
                await mutate(() => rm(stagingPath(row), { recursive: true, force: true }), cleanup);
                await writeRecord(recordPath(row), { ...row, state: "failed", reservedBytes: 0 }, cleanup);
              } catch { cleanupUnknown = true; if (cleanup.signal.aborted) break; }
            }
          } catch { cleanupUnknown = true; }
          finally { cleanup.dispose(); }
          throw new ToolSelectionError(source.tool, source.context, "resolve", cleanupUnknown ? "cleanup_unknown" : parent.signal.aborted ? "cancelled" : "io_error", { cause: error });
        }
        finally { operation.dispose(); }
      });
      queue = pending.catch(() => {}); return pending;
    },
    async close(operation: Operation): Promise<void> {
      closing = true; await withinOperation(queue, operation); await joinMutations(operation);
      if (!await exists(preparations, operation)) return;
      const failures: unknown[] = [];
      for (const row of await records(operation)) {
        try {
          operation.check(); await settle(row, operation);
          // Published directories belong to durable executions. Failed owners
          // release only after original-scope cleanup and staging removal.
          if (row.state !== "published") {
            await mutate(() => rm(stagingPath(row), { recursive: true, force: true }), operation);
            await writeRecord(recordPath(row), { ...row, state: "failed", reservedBytes: 0 }, operation);
          }
        } catch (error) { failures.push(error); if (operation.signal.aborted) break; }
      }
      if (failures.length) throw new AggregateError(failures, "Copilot extraction cleanup remains unconfirmed.");
    },
  };
}
