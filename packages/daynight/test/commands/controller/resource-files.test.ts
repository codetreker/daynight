import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dn-resource-files-")); roots.push(directory);
  return { journal: path.join(directory, "journal.sqlite"), sessionId: randomUUID() };
};
const descriptor = (bytes: Uint8Array) => ({ resourceId: randomUUID(), status: "available" as const, name: "原件.png", mediaType: "image/png", byteLength: String(bytes.byteLength), sha256: createHash("sha256").update(bytes).digest("hex"), error: null });
const name = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;

test("resource files open without a journal or timeline and preserve lease and pin protections", async () => {
  const { journal, sessionId } = await fixture(), bytes = Buffer.from("original bytes");
  const owner = openResourceFiles(journal, sessionId), resource = descriptor(bytes);
  expect(await readdir(owner.root)).not.toContain("timeline");
  expect(await readdir(owner.root)).not.toContain("entries");
  owner.writeResource(resource, bytes);
  expect(owner.descriptorBytes()).toBe(Buffer.byteLength(JSON.stringify(resource)));
  const lease = owner.acquireResource(resource.resourceId);
  expect(lease.read("2", 4)).toEqual(bytes.subarray(2, 6));
  expect(() => lease.read("01", 1)).toThrow();
  expect(() => lease.read("0", 524289)).toThrow();
  expect(() => owner.releaseResource(resource.resourceId)).toThrow(/lease|reference/);
  lease.close(); lease.close();
  expect(() => lease.read("0", 1)).toThrow(/closed/);
  owner.pinResource(resource.resourceId, "consumer");
  expect(() => owner.releaseResource(resource.resourceId)).toThrow(/lease|reference/);
  owner.unpinResource(resource.resourceId, "consumer");
  owner.releaseResource(resource.resourceId);
  expect(owner.descriptorBytes()).toBe(0);
  expect(openResourceFiles(journal, sessionId).resources.size).toBe(0);
  expect(() => openResourceFiles(journal, randomUUID())).toThrow(/another session/);
});

test("opening a legacy inline descriptor retains its exact source and verifies its published blob", async () => {
  const { journal, sessionId } = await fixture(), bytes = Buffer.from("legacy resource"), resource = descriptor(bytes);
  const owner = openResourceFiles(journal, sessionId), file = name(resource.resourceId);
  const original = Buffer.from(JSON.stringify({ resource, data: bytes.toString("base64") }, null, 2));
  await writeFile(path.join(owner.root, "resources", file), original);
  await writeFile(path.join(owner.root, "index.json"), JSON.stringify({ entries: [], resources: [file] }));
  const reopened = openResourceFiles(journal, sessionId);
  expect(await readFile(path.join(owner.root, "legacy-resources", file))).toEqual(original);
  expect(JSON.parse(await readFile(path.join(owner.root, "resources", file), "utf8"))).toEqual({ resource, data: null });
  expect(reopened.resources.get(resource.resourceId)).toEqual({ resource, data: null });
  const lease = reopened.acquireResource(resource.resourceId);
  try { expect(lease.read("0", bytes.length)).toEqual(bytes); } finally { lease.close(); }
});

test("unknown persistent pins survive release of another resource", async () => {
  const { journal, sessionId } = await fixture(), bytes = Buffer.from("pin source");
  const owner = openResourceFiles(journal, sessionId), resource = descriptor(bytes), unknown = randomUUID();
  await writeFile(path.join(owner.root, "resource-pins.json"), JSON.stringify({ [unknown]: ["unknown-reference"] }));
  const reopened = openResourceFiles(journal, sessionId);
  reopened.writeResource(resource, bytes);
  reopened.releaseResource(resource.resourceId);
  expect(JSON.parse(await readFile(path.join(owner.root, "resource-pins.json"), "utf8"))).toEqual({ [unknown]: ["unknown-reference"] });
  expect(() => reopened.releaseResource(unknown)).toThrow(/lease|reference/);
});

test("legacy index entries are checked even though resource files do not create a timeline", async () => {
  const { journal, sessionId } = await fixture();
  const owner = openResourceFiles(journal, sessionId), file = name(randomUUID());
  await writeFile(path.join(owner.root, "index.json"), JSON.stringify({ entries: [file], resources: [] }));
  expect(() => openResourceFiles(journal, sessionId)).toThrow(/incomplete/);
  await mkdir(path.join(owner.root, "timeline"));
  await writeFile(path.join(owner.root, "timeline", file), "{}");
  expect(() => openResourceFiles(journal, sessionId)).not.toThrow();
});

test("resource import refuses content with a different digest and retains no descriptor", async () => {
  const { journal, sessionId } = await fixture(), bytes = Buffer.from("original"), resource = descriptor(bytes);
  const owner = openResourceFiles(journal, sessionId), source = path.join(path.dirname(journal), "source");
  await writeFile(source, Buffer.from("replaced"), { mode: 0o600 });
  expect(() => owner.importResourceFile(resource, source)).toThrow(/corrupt/i);
  expect(owner.resources.size).toBe(0);
  expect(await readdir(path.join(owner.root, "resources"))).toEqual([]);
  expect(await readdir(path.join(owner.root, "blobs"))).toEqual([]);
});

test.skipIf(process.platform === "win32")("resource import refuses a non-private source file", async () => {
  const { journal, sessionId } = await fixture(), bytes = Buffer.from("original"), resource = descriptor(bytes);
  const owner = openResourceFiles(journal, sessionId), source = path.join(path.dirname(journal), "source");
  await writeFile(source, bytes, { mode: 0o600 });
  await chmod(source, 0o644);
  expect(() => owner.importResourceFile(resource, source)).toThrow(/private regular file/);
  expect(owner.resources.size).toBe(0);
});

test("reopening restores an indexed descriptor when deletion was interrupted", async () => {
  const { journal, sessionId } = await fixture(), bytes = Buffer.from("recover interrupted deletion"), resource = descriptor(bytes);
  const owner = openResourceFiles(journal, sessionId);
  owner.writeResource(resource, bytes);
  const lease = owner.acquireResource(resource.resourceId), blob = lease.path; lease.close();
  const descriptorPath = path.join(owner.root, "resources", name(resource.resourceId));
  const suffix = `.${randomUUID()}.removing`;
  await rename(descriptorPath, descriptorPath + suffix);
  const reopened = openResourceFiles(journal, sessionId);
  expect(reopened.resources.get(resource.resourceId)).toEqual({ resource, data: null });
  const restored = reopened.acquireResource(resource.resourceId);
  try { expect(restored.read("0", bytes.length)).toEqual(bytes); } finally { restored.close(); }
  expect(await readdir(path.dirname(blob))).toEqual([path.basename(blob)]);
  expect(await readdir(path.dirname(descriptorPath))).toEqual([path.basename(descriptorPath)]);
});

test("an unindexed staged descriptor prevents reusing or deleting its retained blob", async () => {
  const { journal, sessionId } = await fixture(), bytes = Buffer.from("committed deletion"), resource = descriptor(bytes);
  const owner = openResourceFiles(journal, sessionId);
  owner.writeResource(resource, bytes);
  const lease = owner.acquireResource(resource.resourceId), blob = lease.path; lease.close();
  const descriptorPath = path.join(owner.root, "resources", name(resource.resourceId)), suffix = `.${randomUUID()}.removing`;
  await rename(descriptorPath, descriptorPath + suffix);
  await writeFile(path.join(owner.root, "index.json"), JSON.stringify({ entries: [], resources: [] }));
  const reopened = openResourceFiles(journal, sessionId);
  expect(reopened.resources.size).toBe(0);
  const source = path.join(path.dirname(journal), "source");
  await writeFile(source, bytes, { mode: 0o600 });
  expect(() => reopened.releaseResource(resource.resourceId)).toThrow(/staged descriptor/);
  expect(() => reopened.saveResource({ resource, data: null }, bytes)).toThrow(/staged descriptor/);
  expect(() => reopened.importResourceFile(resource, source)).toThrow(/staged descriptor/);
  expect(await readdir(path.dirname(blob))).toEqual([path.basename(blob)]);
  expect(await readdir(path.dirname(descriptorPath))).toEqual([path.basename(descriptorPath + suffix)]);
  expect(await readFile(blob)).toEqual(bytes);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a descriptor deletion failure retains both the descriptor and its only blob", async () => {
  const { journal, sessionId } = await fixture(), bytes = Buffer.from("retained original"), resource = descriptor(bytes);
  const owner = openResourceFiles(journal, sessionId);
  owner.writeResource(resource, bytes);
  const descriptorPath = path.join(owner.root, "resources", name(resource.resourceId));
  const lease = owner.acquireResource(resource.resourceId), blob = lease.path; lease.close();
  const directory = path.dirname(descriptorPath);
  await chmod(directory, 0o500);
  try { expect(() => owner.releaseResource(resource.resourceId)).toThrow(); }
  finally { await chmod(directory, 0o700); }
  expect(JSON.parse(await readFile(descriptorPath, "utf8"))).toEqual({ resource, data: null });
  expect(await readFile(blob)).toEqual(bytes);
  const reopened = openResourceFiles(journal, sessionId).acquireResource(resource.resourceId);
  try { expect(reopened.read("0", bytes.length)).toEqual(bytes); } finally { reopened.close(); }
});
