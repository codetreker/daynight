import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Operation } from "../../../api/operation.js";
import { resourceOwnerKey } from "../resource-owner.js";
import type { HerdrExecutionOwner } from "./agents.js";
import type { ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { createMappingProcessLifecycle } from "./tool-launch-lifecycle.js";
import { releaseHerdrJobObserver } from "./tool-launch-windows-job.js";
import { mappingFiles, optionalOwnedJson, parseToolManifest, parseToolReceipt } from "./tool-launch-protocol.js";
import type { HerdrToolLaunchManifest } from "./tool-launch-protocol.js";
import { parseToolStartRequest } from "./tool-launch-start.js";

export type HerdrToolLaunchMappingFact = { owner: HerdrExecutionOwner; launch: ResolvedToolLaunch; nonce: string; manifestPath: string; started: boolean; retired: boolean };
const missing = (cause: unknown): boolean => (cause as NodeJS.ErrnoException)?.code === "ENOENT";
const ownedDirectory = (directory: string): void => {
  const entry = lstatSync(directory);
  if (!path.isAbsolute(directory) || !entry.isDirectory() || entry.isSymbolicLink() || process.platform !== "win32" && ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.())) throw new Error("The original Herdr mapping inventory has an unowned directory.");
};
const read = (file: string): unknown | null => {
  let descriptor: number;
  try {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("The original Herdr inventory requires ordinary evidence files.");
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) { if (missing(cause)) return null; throw cause; }
  try {
    const entry = fstatSync(descriptor);
    if (!entry.isFile() || entry.size > 256 * 1024 || process.platform !== "win32" && ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.())) throw new Error("The original Herdr inventory requires bounded owner-only evidence.");
    const buffer = Buffer.alloc(256 * 1024 + 1), size = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (size > 256 * 1024) throw new Error("The original Herdr inventory evidence exceeded its supported bound.");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { closeSync(descriptor); }
};
const generations = (directory: string): { fact: HerdrToolLaunchMappingFact; manifest: HerdrToolLaunchManifest }[] => {
  const parent = path.join(directory, "tool-launch");
  try { ownedDirectory(parent); } catch (cause) { if (missing(cause)) return []; throw cause; }
  const result: { fact: HerdrToolLaunchMappingFact; manifest: HerdrToolLaunchManifest }[] = [];
  for (const key of readdirSync(parent)) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("The original Herdr registry has an unknown mapping responsibility.");
    const registry = path.join(parent, key); ownedDirectory(registry);
    const index = read(path.join(registry, "index.json"));
    const entries = readdirSync(registry).filter(name => name !== "index.json");
    if (index !== null && (typeof index !== "object" || Array.isArray(index) || Object.keys(index).join() !== "generation" || typeof (index as Record<string, unknown>).generation !== "string" || !entries.includes((index as Record<string, string>).generation!))) throw new Error("The original Herdr registry generation index is invalid.");
    for (const generation of entries) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generation)) throw new Error("The original Herdr registry contains an unknown generation responsibility.");
      const root = path.join(registry, generation); ownedDirectory(root);
      const manifestPath = path.join(root, "manifest.json"), manifest = parseToolManifest(read(manifestPath));
      const expectedKey = createHash("sha256").update(resourceOwnerKey(manifest.owner)).update(manifest.launch.selectionKey).digest("hex");
      if (expectedKey !== key) throw new Error("The original Herdr registry belongs to another execution owner or selection.");
      const files = mappingFiles(manifestPath), intent = read(files.intent), receipt = read(files.receipt), retired = read(path.join(root, "retired.json")), requestValue = read(files.nativeStart);
      const request = requestValue === null ? null : parseToolStartRequest(requestValue, { nonce: manifest.nonce, selectionKey: manifest.launch.selectionKey, owner: manifest.owner });
      if (intent !== null) parseToolReceipt(intent, manifest, false);
      if (receipt !== null) {
        const { childPid: _child, ...original } = parseToolReceipt(receipt, manifest);
        if (intent === null || JSON.stringify(original) !== JSON.stringify(intent)) throw new Error("The original Herdr inventory receipt has no matching launch intent.");
      }
      if (retired !== null && JSON.stringify(retired) !== JSON.stringify({ nonce: manifest.nonce, selectionKey: manifest.launch.selectionKey, owner: manifest.owner })) throw new Error("The original Herdr inventory retirement proof is invalid.");
      result.push({ fact: { owner: manifest.owner, launch: manifest.launch, nonce: manifest.nonce, manifestPath, started: intent !== null || request?.state === "reserved", retired: retired !== null }, manifest });
    }
  }
  return result;
};

/** Enumerate every immutable generation, including generations not committed by an index. */
export const readToolLaunchMappingInventory = (directory: string): HerdrToolLaunchMappingFact[] => generations(directory).map(value => value.fact);

/** Old executable files are irrelevant to proving that their original processes stopped. */
export const confirmToolLaunchMappingsStopped = async (directory: string, environment: NodeJS.ProcessEnv, operation: Operation): Promise<boolean> => {
  for (const { fact, manifest } of generations(directory)) {
    operation.check();
    // Retirement already durably proved complete closure for this immutable generation.
    if (fact.retired) {
      if (manifest.platform === "win32") releaseHerdrJobObserver(fact.manifestPath, manifest);
      continue;
    }
    const processRecord = await optionalOwnedJson(path.join(path.dirname(fact.manifestPath), "processes.json"));
    if (processRecord === null && !fact.started) continue;
    if (!await createMappingProcessLifecycle(fact.manifestPath, manifest, environment).confirmStopped(operation)) return false;
  }
  return true;
};
