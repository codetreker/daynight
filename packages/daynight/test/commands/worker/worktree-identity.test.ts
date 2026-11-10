import path from "node:path";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import * as platform from "../../../src/platform/directory-identity.js";
import { bootstrapWorktreeIdentity, inspectWorktreeIdentity } from "../../../src/commands/worker/worktree-identity.js";
import type { WorktreeIdentityContext } from "../../../src/commands/worker/worktree-identity.js";

const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/worktree-identity-tests");
const roots: string[] = [], operations: Operation[] = [];
const owner = { projectId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", claimId: "33333333-3333-4333-8333-333333333333", worktreeId: "44444444-4444-4444-8444-444444444444" };
const fixture = async () => {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, "identity-")); roots.push(root);
  const paths = { root, common: path.join(root, "common"), admin: path.join(root, "common/admin"), leaf: path.join(root, "leaf") };
  await mkdir(paths.admin, { recursive: true }); await mkdir(paths.leaf);
  const id = async (target: string) => { const s = await lstat(target, { bigint: true }); return `${s.dev}:${s.ino}`; };
  const runtime = { root: await id(root), common: await id(paths.common), leaf: await id(paths.leaf) };
  const marker = `daynight-worker:${JSON.stringify({ ...owner, ...runtime })}`;
  await writeFile(path.join(paths.admin, "locked"), `${marker}\n`);
  const operation = createOperation(); operations.push(operation);
  const context: WorktreeIdentityContext = { owner, paths, runtime, marker, verifyLeaf: true };
  const inspect = () => inspectWorktreeIdentity(context, operation);
  const target = path.join(paths.admin, "daynight-identity.json");
  const evidence = await inspect();
  if (evidence.candidate === null) throw new Error("This mechanism test requires APFS stable identity support.");
  const expected = evidence.candidate;
  const publish = () => bootstrapWorktreeIdentity(paths.admin, expected, operation, inspect);
  return { paths, context, inspect, target, expected, publish, operation };
};
afterEach(async () => { vi.restoreAllMocks(); operations.splice(0).forEach(op => op.dispose()); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });

describe.skipIf(process.platform !== "darwin")("immutable worktree identity publication", () => {
  it("joins two publishers at the absent-to-present boundary without replacing either result", async () => {
    const f = await fixture(); const original = platform.publishDirectoryFile; let arrivals = 0;
    let release!: () => void; const both = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(platform, "publishDirectoryFile").mockImplementation(async (...args) => { if (++arrivals === 2) release(); await both; return original(...args); });
    await Promise.all([f.publish(), f.publish()]);
    const bytes = await readFile(f.target); const stat = await lstat(f.target, { bigint: true });
    expect(JSON.parse(bytes.toString())).toEqual(f.expected);
    expect(stat.mode & 0o777n).toBe(0o600n); expect(stat.nlink).toBe(1n);
    await f.publish(); expect((await lstat(f.target, { bigint: true })).ino).toBe(stat.ino);
    expect(await readFile(f.target)).toEqual(bytes);
    expect((await readdir(f.paths.admin)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });
  it("leaves no published record when pre-publication validation fails", async () => {
    const f = await fixture(); let observations = 0;
    const verify = async () => { if (++observations === 2) await writeFile(path.join(f.paths.admin, "locked"), "foreign marker\n"); return f.inspect(); };
    await expect(bootstrapWorktreeIdentity(f.paths.admin, f.expected, f.operation, verify)).rejects.toThrow("marker changed");
    await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.paths.admin, "locked"), "utf8")).toBe("foreign marker\n");
  });
  it("does not overwrite a conflicting record appearing at publication", async () => {
    const f = await fixture(), original = platform.publishDirectoryFile;
    vi.spyOn(platform, "publishDirectoryFile").mockImplementationOnce(async (...args) => { await writeFile(f.target, "conflict", { mode: 0o600 }); await original(...args); });
    await expect(f.publish()).rejects.toThrow();
    expect(await readFile(f.target, "utf8")).toBe("conflict");
  });
  it("reconciles an unknown successful publication using actual immutable bytes", async () => {
    const f = await fixture(), original = platform.publishDirectoryFile, lost = new Error("lost publication result");
    vi.spyOn(platform, "publishDirectoryFile").mockImplementationOnce(async (...args) => { await original(...args); throw lost; });
    await expect(f.publish()).rejects.toThrow();
    const before = await readFile(f.target), inode = (await lstat(f.target, { bigint: true })).ino;
    await f.publish();
    expect(await readFile(f.target)).toEqual(before); expect((await lstat(f.target, { bigint: true })).ino).toBe(inode);
  });
  it.each(["file", "directory"])("does not report success when the %s durability barrier fails", async kind => {
    const f = await fixture(); const probe = await open(f.paths.admin); const prototype = Object.getPrototypeOf(probe); await probe.close();
    const original = prototype.sync;
    const failure = new Error(`${kind} sync failed`);
    vi.spyOn(prototype, "sync").mockImplementation(async function(this: Awaited<ReturnType<typeof open>>) {
      if ((await this.stat()).isDirectory() === (kind === "directory")) throw failure;
      await original.call(this);
    });
    await expect(f.publish()).rejects.toThrow(failure);
    if (kind === "file") await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(f.expected);
    vi.restoreAllMocks(); await f.publish(); expect((await f.inspect()).sidecar).not.toBeNull();
  });
  it("repeats the durability barrier when a prior publication is already visible", async () => {
    const f = await fixture(); await f.publish(); const probe = await open(f.paths.admin); const prototype = Object.getPrototypeOf(probe); await probe.close();
    vi.spyOn(prototype, "sync").mockRejectedValue(new Error("unconfirmed directory persistence"));
    await expect(f.publish()).rejects.toThrow("unconfirmed directory persistence");
  });
  it.each(["symlink", "hardlink", "permissions", "oversized"])("rejects a %s sidecar without rewriting its contents", async kind => {
    const f = await fixture(); await f.publish();
    if (kind === "symlink") { await rename(f.target, `${f.target}.original`); await symlink(`${f.target}.original`, f.target); }
    if (kind === "hardlink") await link(f.target, `${f.target}.alias`);
    if (kind === "permissions") await chmod(f.target, 0o644);
    if (kind === "oversized") await writeFile(f.target, " ".repeat(32769));
    const before = await readFile(f.target); await expect(f.inspect()).rejects.toThrow(); await expect(f.publish()).rejects.toThrow();
    expect(await readFile(f.target)).toEqual(before);
  });
  it("does not accept a copied record from another administrative directory", async () => {
    const first = await fixture(), second = await fixture(); await first.publish();
    const record = JSON.parse(await readFile(first.target, "utf8"));
    record.markerSha256 = createHash("sha256").update(await readFile(path.join(second.paths.admin, "locked"))).digest("hex");
    await writeFile(second.target, JSON.stringify(record), { mode: 0o600 });
    await expect(second.inspect()).rejects.toThrow("volume or object identity changed");
  });
  it("does not publish after cancellation", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort(); const op = createOperation({ signal: controller.signal }); operations.push(op);
    await expect(bootstrapWorktreeIdentity(f.paths.admin, f.expected, op, f.inspect)).rejects.toThrow();
    await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
