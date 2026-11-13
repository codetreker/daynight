import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { ProcessProof } from "../../controller/process-proof.js";
import { parseResolvedToolLaunch } from "../../../platform/tool-launch-record.js";
import type { ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { replaceFileAtomically } from "../../../platform/files.js";
import type { WorkerPaths } from "../paths.js";
import type { FrozenToolObservation } from "../types.js";
import { parseFrozenToolObservation } from "../tool-observation.js";

export type HerdrSharedInstanceRecord = {
  schemaVersion: 1;
  current: { launch: ResolvedToolLaunch | null; observation: FrozenToolObservation | null; daemon: ProcessProof | null; phase: "starting" | "ready" | "stopping" | "stopped" } | null;
  pending: { launch: ResolvedToolLaunch; phase: "intent" | "old_stopped" | "starting" } | null;
};
type Paths = Pick<WorkerPaths, "herdrDirectory">;
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const invalid = (): never => { throw new Error("The original shared Herdr instance journal is invalid; its cleanup responsibility is retained."); };
const object = (value: unknown, fields: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== fields.sort().join()) return invalid();
  return value as Record<string, unknown>;
};
const proof = (value: unknown): ProcessProof => {
  const row = object(value, ["pid", "parentPid", "processGroupId", "startedAt", "commandHash"]);
  if (!Number.isSafeInteger(row.pid) || (row.pid as number) < 1 || !Number.isSafeInteger(row.parentPid) || (row.parentPid as number) < 0 || row.processGroupId !== null && (!Number.isSafeInteger(row.processGroupId) || (row.processGroupId as number) < 1)
    || typeof row.startedAt !== "string" || row.startedAt.length === 0 || typeof row.commandHash !== "string" || !/^[a-f0-9]{64}$/.test(row.commandHash)) return invalid();
  return row as unknown as ProcessProof;
};
const parse = (value: unknown): HerdrSharedInstanceRecord => {
  const row = object(value, ["schemaVersion", "current", "pending"]); if (row.schemaVersion !== 1) return invalid();
  let current: HerdrSharedInstanceRecord["current"] = null, pending: HerdrSharedInstanceRecord["pending"] = null;
  if (row.current !== null) {
    const item = object(row.current, ["launch", "observation", "daemon", "phase"]);
    if (!["starting", "ready", "stopping", "stopped"].includes(String(item.phase))) return invalid();
    current = { launch: item.launch === null ? null : parseResolvedToolLaunch(item.launch, { tool: "herdr", context: "herdr" }), observation: item.observation === null ? null : parseFrozenToolObservation(item.observation), daemon: item.daemon === null ? null : proof(item.daemon), phase: item.phase as NonNullable<HerdrSharedInstanceRecord["current"]>["phase"] };
    if (current.launch === null && current.observation !== null) return invalid();
  }
  if (row.pending !== null) {
    const item = object(row.pending, ["launch", "phase"]);
    if (!["intent", "old_stopped", "starting"].includes(String(item.phase))) return invalid();
    pending = { launch: parseResolvedToolLaunch(item.launch, { tool: "herdr", context: "herdr" }), phase: item.phase as NonNullable<HerdrSharedInstanceRecord["pending"]>["phase"] };
  }
  return { schemaVersion: 1, current, pending };
};
const ordinary = (file: string, directory: boolean): void => {
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) invalid();
};
/** Read only original instance facts. Current Worker targets never repair a missing journal. */
export const readHerdrSharedInstance = (paths: Paths): HerdrSharedInstanceRecord | null => {
  const file = path.join(paths.herdrDirectory, "tool-instance.json");
  try { ordinary(paths.herdrDirectory, true); ordinary(file, false); } catch (error) { if (absent(error)) return null; throw error; }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 1_048_576 || process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) invalid();
    return parse(JSON.parse(readFileSync(descriptor, "utf8")));
  } finally { closeSync(descriptor); }
};
/** The Worker instance lock and the shared adapter's mutex serialize journal transitions. */
export const writeHerdrSharedInstance = async (paths: Paths, value: HerdrSharedInstanceRecord): Promise<void> => {
  const record = parse(value), file = path.join(paths.herdrDirectory, "tool-instance.json");
  await mkdir(paths.herdrDirectory, { recursive: true, mode: 0o700 }); ordinary(paths.herdrDirectory, true);
  try { ordinary(file, false); } catch (error) { if (!absent(error)) throw error; }
  await replaceFileAtomically(file, `${JSON.stringify(record)}\n`, 0o600);
  if (process.platform !== "win32") { const directory = await open(paths.herdrDirectory, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } }
  if (JSON.stringify(readHerdrSharedInstance(paths)) !== JSON.stringify(record)) throw new Error("The shared Herdr instance journal readback differs from its submitted state.");
};
