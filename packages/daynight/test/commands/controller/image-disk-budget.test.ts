import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, open, link, symlink } from "node:fs/promises";
import path from "node:path";
import { controllerMediaDiskBytes } from "../../../src/commands/controller/media/disk-budget.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("private inode accounting includes orphan files and outstanding preparation or capture reservations", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-disk-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "d-")); roots.push(root);
  const original = path.join(root, "original.bin"), pending = path.join(root, "pending.part"), orphan = path.join(root, "orphan.part"), capture = path.join(root, "capture.part");
  for (const [filename, size] of [[original, 1073741824], [pending, 3], [orphan, 17]] as const) { const file = await open(filename, "wx", 0o400); try { await file.truncate(size); } finally { await file.close(); } }
  await link(original, path.join(root, "native.bin"));
  const reservations = new Map([[pending, 10485760], [capture, 10485760]]);
  expect(controllerMediaDiskBytes([root], reservations)).toBe(1073741824 + 2 * 10485760 + 17);
  const runningCapture = await open(capture, "wx", 0o400); try { await runningCapture.truncate(524288); } finally { await runningCapture.close(); }
  expect(controllerMediaDiskBytes([root], reservations)).toBe(1073741824 + 2 * 10485760 + 17);
  await symlink(original, path.join(root, "untrusted.bin"));
  expect(() => controllerMediaDiskBytes([root], reservations)).toThrow("symbolic link");
});
