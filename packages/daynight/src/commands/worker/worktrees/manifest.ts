import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ensureDurableDirectory, syncDurableDirectory } from "../../../platform/durable-directory.js";
import { writeDurableJson } from "../../../platform/durable-json.js";
import { decodeStrictSessionJson } from "../../../session/v2/values.js";
import type { ClaimIdentity, ResourceOwner } from "../types.js";
import { canonicalWorktreeId, manifestPath } from "./paths.js";

export type WorktreeManifest = ResourceOwner & { schemaVersion: 1; directoryName: string };
export type WorktreeManifestStore = {
  read(worktreeId: string): WorktreeManifest | null;
  list(): WorktreeManifest[];
  findClaim(identity: ClaimIdentity): WorktreeManifest | null;
  publish(manifest: WorktreeManifest): WorktreeManifest;
  remove(expected: WorktreeManifest): void;
};

const fields = ["schemaVersion", "projectId", "taskId", "claimId", "worktreeId", "directoryName"] as const;
const parse = (input: unknown): WorktreeManifest => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid worktree manifest.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)) || value.schemaVersion !== 1) throw new Error("Invalid worktree manifest fields or version.");
  const id = (field: typeof fields[number]): string => canonicalWorktreeId(value[field] as string);
  return { schemaVersion: 1, projectId: id("projectId"), taskId: id("taskId"), claimId: id("claimId"), worktreeId: id("worktreeId"), directoryName: id("directoryName") };
};
const same = (left: WorktreeManifest, right: WorktreeManifest): boolean => fields.every(field => left[field] === right[field]);
const claimKey = (identity: ClaimIdentity): string => [identity.projectId, identity.taskId, identity.claimId].map(canonicalWorktreeId).join("/");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const ordinaryDirectory = (directory: string): boolean => {
  let stat;
  try { stat = lstatSync(directory); } catch (error) { if (missing(error)) return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Worktree manifest directory is not an ordinary directory: ${directory}`);
  return true;
};

/** A synchronous store. Callers must hold the existing repository ownership and task gate. */
export const createWorktreeManifestStore = (commonDirectory: string): WorktreeManifestStore => {
  if (!path.isAbsolute(commonDirectory)) throw new Error("The Git common directory must be absolute.");
  const parent = path.join(commonDirectory, "daynight"), directory = path.join(parent, "worktrees");
  const hasDirectory = (): boolean => ordinaryDirectory(parent) && ordinaryDirectory(directory);
  const readFile = (file: string, durable: boolean): WorktreeManifest => {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Worktree manifest is not an ordinary file: ${file}`);
    const fd = openSync(file, (durable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error(`Worktree manifest changed during read: ${file}`);
      const result = parse(decodeStrictSessionJson(readFileSync(fd), 16384));
      if (durable) fsyncSync(fd);
      return result;
    } finally { closeSync(fd); }
  };
  const list = (): WorktreeManifest[] => {
    if (!hasDirectory()) return [];
    const entries = readdirSync(directory).sort();
    const manifests: WorktreeManifest[] = [], claims = new Set<string>(), locations = new Set<string>();
    for (const name of entries) {
      if (name === "format.json" || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/.test(name)) continue;
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/.test(name)) throw new Error(`Unexpected worktree manifest entry: ${name}`);
      const value = readFile(path.join(directory, name), false);
      if (`${value.worktreeId}.json` !== name) throw new Error(`Worktree manifest filename does not match its owner: ${name}`);
      const key = claimKey(value);
      if (claims.has(key) || locations.has(value.directoryName)) throw new Error("Conflicting worktree manifests.");
      claims.add(key); locations.add(value.directoryName); manifests.push(value);
    }
    return manifests;
  };
  const read = (worktreeId: string): WorktreeManifest | null => {
    canonicalWorktreeId(worktreeId);
    return list().find(value => value.worktreeId === worktreeId) ?? null;
  };
  return {
    read, list,
    findClaim: identity => { const key = claimKey(identity); return list().find(value => claimKey(value) === key) ?? null; },
    publish: input => {
      const value = parse(input);
      ensureDurableDirectory(parent);
      ensureDurableDirectory(directory);
      const existing = list();
      for (const other of existing) {
        if (other.worktreeId === value.worktreeId || claimKey(other) === claimKey(value) || other.directoryName === value.directoryName) {
          if (!same(other, value)) throw new Error("Conflicting worktree manifest.");
          const observed = readFile(manifestPath(commonDirectory, value.worktreeId), true);
          if (!same(observed, value)) throw new Error("Worktree manifest changed during publication.");
          syncDurableDirectory(directory);
          return observed;
        }
      }
      writeDurableJson(manifestPath(commonDirectory, value.worktreeId), value);
      return value;
    },
    remove: input => {
      const value = parse(input), existing = read(value.worktreeId);
      if (existing === null) { if (hasDirectory()) syncDurableDirectory(directory); return; }
      if (!same(existing, value)) throw new Error("Worktree manifest does not match expected owner.");
      try { unlinkSync(manifestPath(commonDirectory, value.worktreeId)); } catch (error) { if (!missing(error)) throw error; }
      syncDurableDirectory(directory);
    },
  };
};
