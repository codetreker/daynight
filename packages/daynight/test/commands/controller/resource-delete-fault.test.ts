import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";

const faults = vi.hoisted(() => ({ unlink: "", restore: "", firstLink: "", cleanup: false, hook: null as (() => void) | null, syncDir: "", syncCount: 0 }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    unlinkSync: (file: Parameters<typeof fs.unlinkSync>[0]) => {
      if (String(file) === faults.unlink) { faults.unlink = ""; throw new Error("controlled deletion failure"); }
      if (faults.cleanup && String(file).endsWith(".delete")) throw new Error("controlled cleanup failure");
      if (faults.hook && String(file).endsWith(".json") && String(file).includes(`${path.sep}resources${path.sep}`)) { const hook = faults.hook; faults.hook = null; hook(); }
      fs.unlinkSync(file);
    },
    linkSync: (from: Parameters<typeof fs.linkSync>[0], to: Parameters<typeof fs.linkSync>[1]) => {
      if (String(from) === faults.firstLink && String(to).endsWith(".delete")) { faults.firstLink = ""; throw new Error("controlled backup failure"); }
      if (String(to) === faults.restore && String(from).endsWith(".delete")) throw new Error("controlled restoration failure");
      fs.linkSync(from, to);
    },
  };
});
vi.mock("../../../src/platform/durable-json.js", async original => {
  const durable = await original<typeof import("../../../src/platform/durable-json.js")>();
  return { ...durable, syncDirectory: (directory: string) => {
    if (directory === faults.syncDir && --faults.syncCount === 0) { faults.syncDir = ""; throw new Error("controlled directory sync failure"); }
    durable.syncDirectory(directory);
  } };
});
const roots: string[] = [];
afterEach(async () => { faults.unlink = ""; faults.restore = ""; faults.firstLink = ""; faults.cleanup = false; faults.hook = null; faults.syncDir = ""; vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-resource-delete-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), sessionId = randomUUID(), files = openResourceFiles(journal, sessionId);
  const bytes = Buffer.from("original"), resource = { resourceId: randomUUID(), status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
  files.writeResource(resource, bytes);
  const hash = createHash("sha256").update(resource.resourceId).digest("hex");
  return { journal, sessionId, files, bytes, resource, descriptor: path.join(files.root, "resources", `${hash}.json`), blob: path.join(files.root, "blobs", `${hash}.bin`) };
};

test("another opener leaves backups alone during deletion", async () => {
  const f = await fixture();
  faults.hook = () => {
    const other = openResourceFiles(f.journal, f.sessionId);
    expect(other.resources.has(f.resource.resourceId)).toBe(true);
    expect(readdirSync(path.dirname(f.blob)).some(name => name.endsWith(".delete"))).toBe(true);
  };
  f.files.releaseResource(f.resource.resourceId);
  expect(openResourceFiles(f.journal, f.sessionId).resources.has(f.resource.resourceId)).toBe(false);
});

test("a backup hard link does not consume an extra resource at the count limit", async () => {
  const f = await fixture(), directory = path.dirname(f.blob);
  for (let i = 0; i < 999; i++) await writeFile(path.join(directory, `${i.toString(16).padStart(64, "0")}.bin`), "");
  await link(f.blob, `${f.blob}.${randomUUID()}.delete`);
  expect(openResourceFiles(f.journal, f.sessionId).resources.has(f.resource.resourceId)).toBe(true);
});

test("the owner retries a committed deletion's failed backup cleanup", async () => {
  const f = await fixture();
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  faults.cleanup = true;
  f.files.releaseResource(f.resource.resourceId);
  expect(warning).toHaveBeenCalled();
  expect((await readdir(path.dirname(f.blob))).some(name => name.endsWith(".delete"))).toBe(true);
  faults.cleanup = false;
  const next = { ...f.resource, resourceId: randomUUID() };
  f.files.writeResource(next, f.bytes);
  expect((await readdir(path.dirname(f.blob))).some(name => name.endsWith(".delete"))).toBe(false);
});

test("a directory sync error restores both original files", async () => {
  const f = await fixture();
  faults.syncDir = path.dirname(f.blob); faults.syncCount = 2;
  expect(() => f.files.releaseResource(f.resource.resourceId)).toThrow("controlled directory sync failure");
  expect(await readFile(f.blob)).toEqual(f.bytes);
  expect(JSON.parse(await readFile(f.descriptor, "utf8")).resource).toEqual(f.resource);
  expect(openResourceFiles(f.journal, f.sessionId).resources.has(f.resource.resourceId)).toBe(true);
});

test("a failed restoration reports both failures and retains original sources", async () => {
  const f = await fixture();
  faults.unlink = f.blob; faults.restore = f.descriptor;
  let error: unknown;
  try { f.files.releaseResource(f.resource.resourceId); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.map((value: Error) => value.message)).toEqual(expect.arrayContaining(["controlled deletion failure", "controlled restoration failure"]));
  const descriptorBackups = (await readdir(path.dirname(f.descriptor))).filter(name => name.endsWith(".delete"));
  const blobBackups = (await readdir(path.dirname(f.blob))).filter(name => name.endsWith(".delete"));
  expect(descriptorBackups).toHaveLength(1); expect(blobBackups).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(path.dirname(f.descriptor), descriptorBackups[0]!), "utf8")).resource).toEqual(f.resource);
  expect(await readFile(path.join(path.dirname(f.blob), blobBackups[0]!))).toEqual(f.bytes);
  expect(String(error)).toContain(descriptorBackups[0]);
  expect(() => openResourceFiles(f.journal, f.sessionId)).toThrow("incomplete");
});


test("a backup failure leaves the legacy timeline index untouched", async () => {
  const f = await fixture(), entry = `${"a".repeat(64)}.json`, timeline = path.join(f.files.root, "timeline");
  await mkdir(timeline); await writeFile(path.join(timeline, entry), "{}");
  const indexPath = path.join(f.files.root, "index.json"), current = JSON.parse(await readFile(indexPath, "utf8"));
  const original = JSON.stringify({ ...current, entries: [entry] });
  await writeFile(indexPath, original);
  faults.firstLink = f.descriptor;
  expect(() => f.files.releaseResource(f.resource.resourceId)).toThrow("controlled backup failure");
  expect(await readFile(indexPath, "utf8")).toBe(original);
  expect(openResourceFiles(f.journal, f.sessionId).resources.has(f.resource.resourceId)).toBe(true);
});

test("a late failure restores legacy timeline entries in the shared index", async () => {
  const f = await fixture(), entry = `${"b".repeat(64)}.json`, timeline = path.join(f.files.root, "timeline");
  await mkdir(timeline); await writeFile(path.join(timeline, entry), "{}");
  const indexPath = path.join(f.files.root, "index.json"), current = JSON.parse(await readFile(indexPath, "utf8"));
  await writeFile(indexPath, JSON.stringify({ ...current, entries: [entry] }));
  faults.syncDir = path.dirname(f.blob); faults.syncCount = 2;
  expect(() => f.files.releaseResource(f.resource.resourceId)).toThrow("controlled directory sync failure");
  expect(JSON.parse(await readFile(indexPath, "utf8"))).toEqual({ ...current, entries: [entry] });
  expect(openResourceFiles(f.journal, f.sessionId).resources.has(f.resource.resourceId)).toBe(true);
});
