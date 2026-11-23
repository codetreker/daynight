import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { createOperation, type Operation } from "../../src/api/operation.js";
import { readToolRuntimeText } from "../../src/platform/tool-runtime-io.js";

const barrier = vi.hoisted(() => ({ afterRead: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    // Keep the real descriptor and bytes; only control the replacement point.
    const read = handle.read.bind(handle);
    handle.read = (async (...values: Parameters<typeof read>) => {
      const result = await read(...values);
      const callback = barrier.afterRead; barrier.afterRead = undefined;
      await callback?.(); return result;
    }) as typeof handle.read;
    return handle;
  } };
});

const roots: string[] = [], operations: Operation[] = [];
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/runtime-io-tests");
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-")); roots.push(root);
  const file = path.join(root, "record.json"), operation = createOperation({ limits: { totalMs: 2000 } }); operations.push(operation);
  const read = () => readToolRuntimeText(file, operation, { limit: 32, private: true });
  return { root, file, operation, read };
};
afterEach(async () => {
  barrier.afterRead = undefined;
  for (const operation of operations.splice(0)) operation.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("runtime metadata reads private UTF-8 records and rejects oversized and malformed bytes", async () => {
  const f = await fixture();
  await writeFile(f.file, '{"value":"中文"}', { mode: 0o600 }); expect(await f.read()).toBe('{"value":"中文"}');
  await writeFile(f.file, "a".repeat(33)); await expect(f.read()).rejects.toMatchObject({ code: "not_executable" });
  await writeFile(f.file, Buffer.from([0xc3, 0x28])); await expect(f.read()).rejects.toThrow();
});

test.skipIf(process.platform === "win32")("runtime metadata refuses public modes, symlinks and writerless FIFOs", async () => {
  const f = await fixture();
  await writeFile(f.file, "{}", { mode: 0o600 }); await chmod(f.file, 0o644);
  await expect(f.read()).rejects.toMatchObject({ code: "not_executable" });
  const target = path.join(f.root, "target"); await rename(f.file, target); await chmod(target, 0o600); await symlink(target, f.file);
  await expect(f.read()).rejects.toThrow(); await rm(f.file);
  await promisify(execFile)("mkfifo", [f.file], { timeout: 1000 });
  // A blocking open never reaches the regular-file refusal and instead expires.
  await expect(f.read()).rejects.toMatchObject({ code: "not_executable" });
});

// Windows rejects replacement of the open file itself; POSIX permits it.
test.skipIf(process.platform === "win32")("runtime metadata rejects replacement after reading the original descriptor", async () => {
  const f = await fixture(), replacement = path.join(f.root, "replacement");
  await writeFile(f.file, "original", { mode: 0o600 }); await writeFile(replacement, "replaced", { mode: 0o600 });
  barrier.afterRead = async () => { await rename(replacement, f.file); };
  await expect(f.read()).rejects.toMatchObject({ code: "not_executable" });
});

test("runtime metadata rejects growth and honors cancellation before opening", async () => {
  const f = await fixture(); await writeFile(f.file, "original", { mode: 0o600 });
  barrier.afterRead = async () => { await writeFile(f.file, "b".repeat(33)); };
  await expect(f.read()).rejects.toMatchObject({ code: "not_executable" });
  f.operation.dispose(); await rm(f.file);
  await expect(f.read()).rejects.toMatchObject({ kind: "disposed" });
});
