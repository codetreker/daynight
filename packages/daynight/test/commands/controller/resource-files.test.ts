import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";

const faults = vi.hoisted(() => ({ operation: "", target: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    unlinkSync: (file: Parameters<typeof fs.unlinkSync>[0]) => {
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
afterEach(async () => { faults.operation = ""; faults.target = ""; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-resource-files-")); roots.push(root);
  return { journal: path.join(root, "journal.sqlite"), sessionId: randomUUID() };
};
const descriptor = (bytes: Buffer) => ({ resourceId: randomUUID(), status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null });
const filename = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;

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
