import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openResourceFiles, retireLegacyTimelineReferences } from "../../../src/commands/controller/content/resource-files.js";
import { parseSessionResource, parseStoredSessionResource } from "../../../src/session/protocol.js";

const faults = vi.hoisted(() => ({ operation: "", target: "", publicationIndex: "", publicationFailed: false, rollbackAttempts: 0 }));
vi.mock("../../../src/platform/durable-json.js", async original => {
  const durable = await original<typeof import("../../../src/platform/durable-json.js")>();
  return { ...durable, writeDurableJson: (file: string, value: unknown) => {
    const inventory = value as { resources?: string[]; cleanup?: string[] };
    if (file === faults.publicationIndex && faults.publicationFailed && inventory.resources?.length) {
      faults.rollbackAttempts++; throw new Error("Controlled old inventory restoration failure");
    }
    durable.writeDurableJson(file, value);
    if (file === faults.publicationIndex && !faults.publicationFailed && inventory.cleanup?.length) {
      faults.publicationFailed = true; throw new Error("Controlled index publication acknowledgement failure");
    }
  } };
});
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    linkSync: (from: Parameters<typeof fs.linkSync>[0], to: Parameters<typeof fs.linkSync>[1]) => {
      if (faults.publicationFailed && String(from).endsWith(".delete")) { faults.rollbackAttempts++; throw new Error("Controlled original restoration failure"); }
      fs.linkSync(from, to);
    },
    unlinkSync: (file: Parameters<typeof fs.unlinkSync>[0]) => {
      if (faults.operation === "backup" && String(file).startsWith(faults.target + ".") && String(file).endsWith(".delete")) throw Object.assign(new Error("controlled backup cleanup failure"), { code: "EPERM" });
      if (faults.operation === "unlink" && String(file) === faults.target) { faults.operation = ""; throw new Error("controlled unlink failure"); }
      fs.unlinkSync(file);
    },
    renameSync: (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
      if (faults.operation === "rename" && String(to) === faults.target) { faults.operation = ""; throw new Error("controlled rename failure"); }
      fs.renameSync(from, to);
    },
  };
});
const roots: string[] = [];
afterEach(async () => { faults.operation = ""; faults.target = ""; faults.publicationIndex = ""; faults.publicationFailed = false; faults.rollbackAttempts = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/resource-files-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); roots.push(root);
  return { journal: path.join(root, "journal.sqlite"), sessionId: randomUUID() };
};
const descriptor = (bytes: Buffer) => ({ resourceId: randomUUID(), status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null });
const filename = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;

test.each([false, true])("persists committed cleanup across reopen without rolling back published deletion or deleting unknown files (lost publication acknowledgement: %s)", async lostPublication => {
  const { journal, sessionId } = await fixture(), files = openResourceFiles(journal, sessionId);
  const bytes = Buffer.from("tool-only original"), resource = descriptor(bytes);
  files.writeResource(resource, bytes);
  const stale = openResourceFiles(journal, sessionId);
  const blob = path.join(files.root, "blobs", filename(resource.resourceId).replace(/\.json$/, ".bin"));
  const unknown = path.join(files.root, "blobs", `${"f".repeat(64)}.bin.${randomUUID()}.delete`);
  await writeFile(unknown, "not registered by this owner");
  if (lostPublication) faults.publicationIndex = path.join(files.root, "index.json");
  faults.operation = "backup"; faults.target = blob;
  files.releaseResource(resource.resourceId);
  expect(faults.publicationFailed).toBe(lostPublication);
  expect(faults.rollbackAttempts).toBe(0);
  expect(() => files.retryCleanup()).toThrow("controlled backup cleanup failure");
  expect(files.resources.has(resource.resourceId)).toBe(false);
  const index = JSON.parse(await readFile(path.join(files.root, "index.json"), "utf8"));
  expect(index.resources).toEqual([]); expect(index.cleanup).toHaveLength(2);
  const backup = index.cleanup.find((file: string) => file.startsWith("blobs/"));
  expect(await readFile(path.join(files.root, backup))).toEqual(bytes);
  retireLegacyTimelineReferences(journal, sessionId);
  expect(JSON.parse(await readFile(path.join(files.root, "index.json"), "utf8")).cleanup).toEqual(index.cleanup);
  const reopened = openResourceFiles(journal, sessionId);
  expect(reopened.resources.size).toBe(0);
  expect(() => reopened.retryCleanup()).toThrow("controlled backup cleanup failure");
  faults.operation = "";
  expect(() => stale.retryCleanup()).toThrow(`Unregistered resource backups require recovery: ${unknown}`);
  await expect(readFile(path.join(files.root, backup))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(unknown, "utf8")).toBe("not registered by this owner");
  expect(JSON.parse(await readFile(path.join(files.root, "index.json"), "utf8"))).toEqual({ entries: [], resources: [] });
});

test.each(["resources", "blobs"])("strict cleanup detects unregistered zero-byte backups in %s without an index", async directory => {
  const { journal, sessionId } = await fixture(), files = openResourceFiles(journal, sessionId);
  const backup = path.join(files.root, directory, "unknown.delete");
  await writeFile(backup, ""); await rm(path.join(files.root, "index.json"));
  expect(() => files.retryCleanup()).toThrow(`Unregistered resource backups require recovery: ${backup}`);
  expect(await readFile(backup)).toEqual(Buffer.alloc(0));
});

test("cleanup refuses a registered symbolic link without following its target", async () => {
  const { journal, sessionId } = await fixture(), files = openResourceFiles(journal, sessionId);
  const relative = `blobs/${"a".repeat(64)}.bin.${randomUUID()}.delete`, target = path.join(path.dirname(journal), "outside");
  await mkdir(target); await writeFile(path.join(target, "sentinel"), "unrelated content");
  await symlink(target, path.join(files.root, relative), process.platform === "win32" ? "junction" : "dir");
  const index = { entries: [], resources: [], cleanup: [relative] };
  await writeFile(path.join(files.root, "index.json"), JSON.stringify(index));
  expect(() => files.retryCleanup()).toThrow("Invalid retained resource backup");
  expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe("unrelated content");
  expect(JSON.parse(await readFile(path.join(files.root, "index.json"), "utf8"))).toEqual(index);
});

test.each(["../outside.delete", "blobs/../outside.delete", "blobs/unknown.bin", "/absolute.delete"])("rejects unowned cleanup inventory path %s", async cleanup => {
  const { journal, sessionId } = await fixture(), files = openResourceFiles(journal, sessionId);
  await writeFile(path.join(files.root, "index.json"), JSON.stringify({ entries: [], resources: [], cleanup: [cleanup] }));
  expect(() => openResourceFiles(journal, sessionId)).toThrow("Invalid pending resource cleanup inventory");
});

test("stored extended descriptors retain values above current input limits", () => {
  const resource = { ...descriptor(Buffer.from("original")), name: "x".repeat(1025), byteLength: "10485761", revision: "1", width: 16385, height: 2049, frameCount: 257 };
  expect(parseStoredSessionResource(resource)).toEqual(resource);
  expect(() => parseSessionResource(resource)).toThrow();
  expect(() => parseStoredSessionResource({ ...resource, byteLength: "01" })).toThrow();
});

test("opens independently without body directories and accounts for descriptor bytes", async () => {
  const { journal, sessionId } = await fixture(), files = openResourceFiles(journal, sessionId);
  expect(await readdir(files.root)).toEqual(expect.not.arrayContaining(["timeline", "entries"]));
  const bytes = Buffer.from("original"), resource = descriptor(bytes);
  files.writeResource(resource, bytes);
  expect(files.descriptorBytes()).toBe(Buffer.byteLength(JSON.stringify(resource)));
  expect(files.resources.get(resource.resourceId)).toEqual({ resource, data: null });
  expect(openResourceFiles(journal, sessionId).resources.get(resource.resourceId)).toEqual({ resource, data: null });
  expect(() => openResourceFiles(journal, randomUUID())).toThrow("another session");
});

test("validates the shared legacy index and preserves the exact legacy resource source", async () => {
  const { journal, sessionId } = await fixture(), root = `${journal}.pending-content`, bytes = Buffer.from("legacy resource"), resource = descriptor(bytes);
  const entryFile = `${"a".repeat(64)}.json`, resourceFile = filename(resource.resourceId);
  await mkdir(path.join(root, "resources"), { recursive: true });
  const old = Buffer.from(JSON.stringify({ resource, data: bytes.toString("base64") }));
  await writeFile(path.join(root, "resources", resourceFile), old);
  await writeFile(path.join(root, "index.json"), JSON.stringify({ entries: [entryFile], resources: [resourceFile] }));
  expect(() => openResourceFiles(journal, sessionId)).toThrow("incomplete");
  await mkdir(path.join(root, "timeline")); await writeFile(path.join(root, "timeline", entryFile), "{}");
  const files = openResourceFiles(journal, sessionId);
  expect(await readFile(path.join(root, "legacy-resources", resourceFile))).toEqual(old);
  expect(JSON.parse(await readFile(path.join(root, "resources", resourceFile), "utf8"))).toEqual({ resource, data: null });
  const lease = files.acquireResource(resource.resourceId);
  try { expect(lease.read("0", 524288)).toEqual(bytes); } finally { lease.close(); }
  await rm(path.join(root, "resources", resourceFile));
  expect(() => openResourceFiles(journal, sessionId)).toThrow("incomplete");
});

test("retains unknown pins and refuses removal while pinned or leased", async () => {
  const { journal, sessionId } = await fixture(), root = `${journal}.pending-content`;
  await mkdir(root, { recursive: true });
  const unknown = randomUUID(); await writeFile(path.join(root, "resource-pins.json"), JSON.stringify({ [unknown]: ["unknown-reference"] }));
  const files = openResourceFiles(journal, sessionId), resource = descriptor(Buffer.from("original"));
  files.writeResource(resource, Buffer.from("original")); files.pinResource(resource.resourceId, "known-reference");
  expect(() => files.releaseResource(resource.resourceId)).toThrow("lease or reference");
  files.unpinResource(resource.resourceId, "known-reference");
  const lease = files.acquireResource(resource.resourceId);
  expect(() => files.releaseResource(resource.resourceId)).toThrow("lease or reference");
  expect(() => lease.read("01", 1)).toThrow(); expect(() => lease.read("0", 524289)).toThrow();
  lease.close(); lease.close(); expect(() => lease.read("0", 1)).toThrow("closed");
  files.releaseResource(resource.resourceId);
  expect(JSON.parse(await readFile(path.join(root, "resource-pins.json"), "utf8"))).toEqual({ [unknown]: ["unknown-reference"] });
  expect(() => files.releaseResource(unknown)).toThrow("lease or reference");
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a descriptor deletion refusal retains its descriptor and unique blob", async () => {
  const { journal, sessionId } = await fixture(), files = openResourceFiles(journal, sessionId), bytes = Buffer.from("original"), resource = descriptor(bytes);
  files.writeResource(resource, bytes);
  const directory = path.join(files.root, "resources"), descriptorPath = path.join(directory, filename(resource.resourceId));
  await chmod(directory, 0o500);
  try {
    expect(() => files.releaseResource(resource.resourceId)).toThrow();
    expect(JSON.parse(await readFile(descriptorPath, "utf8"))).toEqual({ resource, data: null });
    const lease = files.acquireResource(resource.resourceId);
    try { expect(lease.read("0", 100)).toEqual(bytes); } finally { lease.close(); }
  } finally { await chmod(directory, 0o700); }
});

test("refuses mismatched and non-private imports without publishing a resource", async () => {
  const { journal, sessionId } = await fixture(), files = openResourceFiles(journal, sessionId), bytes = Buffer.from("original"), resource = descriptor(bytes);
  const source = path.join(path.dirname(journal), "source.bin");
  await writeFile(source, Buffer.from("modified"), { mode: 0o600 });
  expect(() => files.importResourceFile(resource, source)).toThrow("Corrupt pending resource content");
  expect(files.resources.has(resource.resourceId)).toBe(false);
  expect(await readdir(path.join(files.root, "blobs"))).toEqual([]);
  await writeFile(source, bytes);
  if (process.platform !== "win32") {
    await chmod(source, 0o644);
    expect(() => files.importResourceFile(resource, source)).toThrow("private regular file");
    expect(files.resources.has(resource.resourceId)).toBe(false);
    await chmod(source, 0o600);
  }
  files.importResourceFile(resource, source);
  expect(await readFile(source)).toEqual(bytes);
  const lease = files.acquireResource(resource.resourceId);
  try { expect(lease.read("0", 100)).toEqual(bytes); } finally { lease.close(); }
});


test.each(["descriptor", "blob", "pins", "index"] as const)("a %s deletion failure preserves a readable original after reopening", async point => {
  const { journal, sessionId } = await fixture(), files = openResourceFiles(journal, sessionId), bytes = Buffer.from("original"), resource = descriptor(bytes);
  files.writeResource(resource, bytes);
  const descriptorPath = path.join(files.root, "resources", filename(resource.resourceId));
  const blobPath = path.join(files.root, "blobs", filename(resource.resourceId).replace(/\.json$/, ".bin"));
  faults.operation = point === "descriptor" || point === "blob" ? "unlink" : "rename";
  faults.target = point === "descriptor" ? descriptorPath : point === "blob" ? blobPath : path.join(files.root, point === "pins" ? "resource-pins.json" : "index.json");
  expect(() => files.releaseResource(resource.resourceId)).toThrow("controlled");
  expect(files.resources.get(resource.resourceId)).toEqual({ resource, data: null });
  expect(JSON.parse(await readFile(descriptorPath, "utf8"))).toEqual({ resource, data: null });
  expect(await readFile(blobPath)).toEqual(bytes);
  const reopened = openResourceFiles(journal, sessionId);
  const lease = reopened.acquireResource(resource.resourceId);
  try { expect(lease.read("0", 100)).toEqual(bytes); } finally { lease.close(); }
});

test.each(["root", "resources", "blobs"] as const)("resource ownership rejects a linked %s directory without following it", async kind => {
  const { journal, sessionId } = await fixture(), pending = `${journal}.pending-content`;
  const target = path.join(path.dirname(journal), "outside"); await mkdir(target, { mode: 0o700 });
  const sentinel = path.join(target, "sentinel"); await writeFile(sentinel, "retained outside bytes", { mode: 0o600 });
  if (kind !== "root") openResourceFiles(journal, sessionId);
  const linked = kind === "root" ? pending : path.join(pending, kind);
  if (kind !== "root") await rm(linked, { recursive: true });
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  expect(() => openResourceFiles(journal, sessionId)).toThrow(/directory/);
  expect(await readFile(sentinel, "utf8")).toBe("retained outside bytes");
});

test.skipIf(process.platform === "win32")("resource reads reject a linked blob even when its bytes match the saved descriptor", async () => {
  const { journal, sessionId } = await fixture(), files = openResourceFiles(journal, sessionId), bytes = Buffer.from("original"), resource = descriptor(bytes);
  files.writeResource(resource, bytes);
  const blob = path.join(files.root, "blobs", filename(resource.resourceId).replace(/\.json$/, ".bin"));
  const outside = path.join(path.dirname(journal), "outside.bin"); await writeFile(outside, bytes, { mode: 0o400 });
  await rm(blob); await symlink(outside, blob);
  expect(() => files.acquireResource(resource.resourceId)).toThrow("Corrupt pending resource content.");
  expect(await readFile(outside)).toEqual(bytes);
});
