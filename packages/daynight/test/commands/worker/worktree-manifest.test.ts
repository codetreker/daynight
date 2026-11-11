import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { bindingForManifest, managedNamespace, manifestPath } from "../../../src/commands/worker/worktrees/paths.js";

const fault = vi.hoisted(() => ({ syncPath: "", syncRegular: false, whenPresent: "", readPath: "", writeDirectory: "", listPath: "" }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      if (fault.syncRegular && fs.fstatSync(fd).isFile()) throw new Error("controlled file flush failure");
      if (fault.syncPath && (!fault.whenPresent || fs.existsSync(fault.whenPresent))) {
        const stat = fs.fstatSync(fd);
        try {
          const target = fs.statSync(fault.syncPath);
          if (stat.dev === target.dev && stat.ino === target.ino) throw new Error("controlled barrier failure");
        } catch (error) {
          if (error instanceof Error && error.message === "controlled barrier failure") throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      fs.fsyncSync(fd);
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === fault.readPath) throw Object.assign(new Error("controlled read failure"), { code: "EACCES" });
      if (fault.writeDirectory && String(args[0]).startsWith(`${fault.writeDirectory}${path.sep}`) && args[1] === "wx") throw Object.assign(new Error("controlled write failure"), { code: "EACCES" });
      return fs.openSync(...args);
    },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === fault.listPath) throw Object.assign(new Error("controlled list failure"), { code: "EACCES" });
      return fs.readdirSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fault.syncPath = ""; fault.syncRegular = false; fault.whenPresent = ""; fault.readPath = ""; fault.writeDirectory = ""; fault.listPath = "";
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/worktree-manifest");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-")); roots.push(root);
  const common = path.join(root, "common"), repository = path.join(root, "repository");
  mkdirSync(common); mkdirSync(repository);
  return { common, repository, directory: path.join(common, "daynight", "worktrees"), store: createWorktreeManifestStore(common) };
};
const manifest = () => ({ schemaVersion: 1 as const, projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID(), directoryName: randomUUID() });
const claim = (value: ReturnType<typeof manifest>) => ({ projectId: value.projectId, taskId: value.taskId, claimId: value.claimId });

test("publishes and reads the current manifest without activating or changing the old runtime format", () => {
  const f = fixture(), value = manifest();
  expect(f.store.read(value.worktreeId)).toBeNull();
  expect(f.store.findClaim(claim(value))).toBeNull();
  expect(f.store.list()).toEqual([]);
  expect(f.store.publish(value)).toEqual(value);
  expect(JSON.parse(readFileSync(path.join(f.directory, `${value.worktreeId}.json`), "utf8"))).toEqual(value);
  expect(f.store.read(value.worktreeId)).toEqual(value);
  expect(f.store.findClaim(claim(value))).toEqual(value);
  expect(f.store.list()).toEqual([value]);
  expect(f.store.publish(value)).toEqual(value);
  expect(existsSync(path.join(f.directory, "format.json"))).toBe(false);
  expect(managedNamespace(f.repository)).toBe(path.join(f.repository, ".worktrees", "daynight"));
  expect(manifestPath(f.common, value.worktreeId)).toBe(path.join(f.directory, `${value.worktreeId}.json`));
  expect(bindingForManifest(f.repository, f.common, value)).toEqual({ repositoryPath: f.repository, commonDirectory: f.common, worktreePath: path.join(f.repository, ".worktrees", "daynight", value.directoryName), branch: `daynight/${value.taskId}` });
});

test("enforces all three uniqueness rules without overwriting existing ownership", () => {
  const f = fixture(), first = manifest(); f.store.publish(first);
  const another = manifest();
  for (const conflict of [
    { ...another, worktreeId: first.worktreeId },
    { ...another, ...claim(first) },
    { ...another, directoryName: first.directoryName },
  ]) expect(() => f.store.publish(conflict)).toThrow();
  expect(f.store.list()).toEqual([first]);
  const second = { ...manifest(), projectId: first.projectId, taskId: first.taskId };
  expect(f.store.publish(second)).toEqual(second);
  expect(f.store.list()).toHaveLength(2);
});

test("removes only a semantically matching manifest and is idempotent on absence", () => {
  const f = fixture(), value = manifest(); f.store.publish(value);
  expect(() => f.store.remove({ ...value, directoryName: randomUUID() })).toThrow();
  expect(f.store.read(value.worktreeId)).toEqual(value);
  f.store.remove(value);
  expect(f.store.read(value.worktreeId)).toBeNull();
  expect(() => f.store.remove(value)).not.toThrow();
});

test("reuses a semantically identical manifest without depending on JSON byte order", () => {
  const f = fixture(), value = manifest(); f.store.publish(value);
  const { directoryName, worktreeId, claimId, taskId, projectId, schemaVersion } = value;
  writeFileSync(path.join(f.directory, `${worktreeId}.json`), JSON.stringify({ directoryName, worktreeId, claimId, taskId, projectId, schemaVersion }, null, 2));
  expect(f.store.publish(value)).toEqual(value);
  f.store.remove(value);
  expect(f.store.read(worktreeId)).toBeNull();
});

test.each(["claim", "directory"] as const)("detects duplicate %s in existing on-disk records", duplicate => {
  const f = fixture(), first = manifest(); f.store.publish(first);
  const second = { ...manifest(), ...(duplicate === "claim" ? claim(first) : { directoryName: first.directoryName }) };
  writeFileSync(path.join(f.directory, `${second.worktreeId}.json`), JSON.stringify(second));
  expect(() => f.store.list()).toThrow();
  expect(() => f.store.findClaim(claim(first))).toThrow();
  expect(() => f.store.publish(manifest())).toThrow();
});

test("ignores only the format marker and known temporary publications", () => {
  const f = fixture(), value = manifest(); f.store.publish(value);
  writeFileSync(path.join(f.directory, "format.json"), '{"version":1}');
  writeFileSync(path.join(f.directory, `${randomUUID()}.json.${randomUUID()}.tmp`), "incomplete");
  expect(f.store.list()).toEqual([value]);
  writeFileSync(path.join(f.directory, "unexpected.json"), "{}");
  expect(() => f.store.list()).toThrow();
});

test.each([
  ["missing field", (v: ReturnType<typeof manifest>) => { const { claimId: _, ...rest } = v; return rest; }],
  ["extra field", (v: ReturnType<typeof manifest>) => ({ ...v, extra: true })],
  ["unknown version", (v: ReturnType<typeof manifest>) => ({ ...v, schemaVersion: 2 })],
  ["noncanonical UUID", (v: ReturnType<typeof manifest>) => ({ ...v, projectId: v.projectId.toUpperCase() })],
  ["path traversal", (v: ReturnType<typeof manifest>) => ({ ...v, directoryName: "../outside" })],
  ["filename mismatch", (v: ReturnType<typeof manifest>) => ({ ...v, worktreeId: randomUUID() })],
])("rejects %s in an existing manifest instead of returning absence", (_name, corrupt) => {
  const f = fixture(), value = manifest(); mkdirSync(f.directory, { recursive: true });
  writeFileSync(path.join(f.directory, `${value.worktreeId}.json`), JSON.stringify(corrupt(value)));
  expect(() => f.store.read(value.worktreeId)).toThrow();
  expect(() => f.store.list()).toThrow();
  expect(() => f.store.findClaim(claim(value))).toThrow();
  expect(() => f.store.publish(value)).toThrow();
});

test("rejects malformed JSON and nonregular manifest files", () => {
  const f = fixture(), value = manifest(), file = path.join(f.directory, `${value.worktreeId}.json`);
  mkdirSync(f.directory, { recursive: true }); writeFileSync(file, "{");
  expect(() => f.store.read(value.worktreeId)).toThrow();
  rmSync(file); mkdirSync(file);
  expect(() => f.store.read(value.worktreeId)).toThrow();
  expect(() => f.store.list()).toThrow();
});

test.skipIf(process.platform === "win32")("does not follow a manifest symlink", () => {
  const f = fixture(), value = manifest(), target = path.join(f.common, "outside.json");
  mkdirSync(f.directory, { recursive: true }); writeFileSync(target, JSON.stringify(value));
  symlinkSync(target, path.join(f.directory, `${value.worktreeId}.json`));
  expect(() => f.store.read(value.worktreeId)).toThrow();
  expect(() => f.store.list()).toThrow();
  expect(() => f.store.remove(value)).toThrow();
  expect(existsSync(target)).toBe(true);
});

test("propagates read and enumeration failures rather than treating them as absence", () => {
  const f = fixture(), value = manifest(); f.store.publish(value);
  fault.readPath = path.join(f.directory, `${value.worktreeId}.json`);
  expect(() => f.store.read(value.worktreeId)).toThrow("controlled read failure");
  fault.readPath = ""; fault.listPath = f.directory;
  expect(() => f.store.list()).toThrow("controlled list failure");
  expect(() => f.store.findClaim(claim(value))).toThrow("controlled list failure");
  expect(() => f.store.publish(manifest())).toThrow("controlled list failure");
});

test("propagates a publication permission failure and permits a later retry", () => {
  const f = fixture(), value = manifest(); fault.writeDirectory = f.directory;
  expect(() => f.store.publish(value)).toThrow("controlled write failure");
  expect(f.store.read(value.worktreeId)).toBeNull();
  fault.writeDirectory = "";
  expect(f.store.publish(value)).toEqual(value);
});

test.skipIf(process.platform === "win32").each(["common", "daynight"] as const)("retries the %s namespace parent barrier even when the child directory is visible", parent => {
  const f = fixture(), value = manifest(), daynight = path.join(f.common, "daynight");
  fault.syncPath = parent === "common" ? f.common : daynight;
  fault.whenPresent = parent === "common" ? daynight : f.directory;
  expect(() => f.store.publish(value)).toThrow("controlled barrier failure");
  expect(existsSync(fault.whenPresent)).toBe(true);
  expect(existsSync(path.join(f.directory, `${value.worktreeId}.json`))).toBe(false);
  expect(() => f.store.publish(value)).toThrow("controlled barrier failure");
  fault.syncPath = "";
  expect(f.store.publish(value)).toEqual(value);
});

test.skipIf(process.platform === "win32")("a visible final file after directory flush failure is not accepted until its barrier succeeds", () => {
  const f = fixture(), value = manifest(), file = path.join(f.directory, `${value.worktreeId}.json`);
  fault.syncPath = f.directory; fault.whenPresent = file;
  expect(() => f.store.publish(value)).toThrow("controlled barrier failure");
  expect(f.store.read(value.worktreeId)).toEqual(value);
  expect(() => f.store.publish(value)).toThrow("controlled barrier failure");
  fault.syncPath = "";
  expect(f.store.publish(value)).toEqual(value);
  expect(f.store.list()).toEqual([value]);
});

test("file flush failures prevent publication and are retried for an existing semantic match", () => {
  const f = fixture(), value = manifest(), file = path.join(f.directory, `${value.worktreeId}.json`);
  fault.syncRegular = true;
  expect(() => f.store.publish(value)).toThrow("controlled file flush failure");
  expect(existsSync(file)).toBe(false);
  fault.syncRegular = false;
  expect(f.store.publish(value)).toEqual(value);
  fault.syncRegular = true;
  expect(f.store.read(value.worktreeId)).toEqual(value);
  expect(f.store.list()).toEqual([value]);
  expect(() => f.store.publish(value)).toThrow("controlled file flush failure");
  fault.syncRegular = false;
  expect(f.store.publish(value)).toEqual(value);
});

test.skipIf(process.platform === "win32")("a failed retirement directory flush is retried when the manifest is already absent", () => {
  const f = fixture(), value = manifest(); f.store.publish(value);
  fault.syncPath = f.directory;
  expect(() => f.store.remove(value)).toThrow("controlled barrier failure");
  expect(f.store.read(value.worktreeId)).toBeNull();
  expect(() => f.store.remove(value)).toThrow("controlled barrier failure");
  fault.syncPath = "";
  expect(() => f.store.remove(value)).not.toThrow();
});
