import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { decodeWindowsReparsePoint } from "../../../../src/commands/controller/markdown/local-source-windows.js";
import { copyLocalImage, createLocalImageContext, type LocalImageContext } from "../../../../src/commands/controller/markdown/local-source.js";
import type { LocalImageCheckpoint } from "../../../../src/commands/controller/markdown/local-source-proof.js";

const reparse = (target: string, junction = false, relative = false) => {
  const text = Buffer.from(target, "utf16le"), base = junction ? 16 : 20, bytes = Buffer.alloc(base + text.length);
  bytes.writeUInt32LE(junction ? 0xa0000003 : 0xa000000c); bytes.writeUInt16LE(bytes.length - 8, 4);
  bytes.writeUInt16LE(text.length, 10); if (!junction) bytes.writeUInt32LE(relative ? 1 : 0, 16); text.copy(bytes, base); return bytes;
};
describe("Windows reparse data", () => {
  it("keeps relative symlink parent components and accepts only disk junction names", () => {
    expect(decodeWindowsReparsePoint(reparse("a\\b\\..\\image", false, true))).toEqual({ target: "a\\b\\..\\image", relative: true });
    expect(decodeWindowsReparsePoint(reparse("\\??\\C:\\root\\image", true))).toEqual({ target: "C:\\root\\image", relative: false });
  });
  it.each(["\\??\\UNC\\host\\share", "\\??\\Volume{bad}\\x", "\\\\?\\C:\\x", "\\Device\\HarddiskVolume1\\x", "C:relative", "C:\\NUL.png", "C:\\a:stream", "C:\\a.\\image", "C:\\a*", "C:\\x\u0000y", "C:\\x\ud800"])("refuses unsupported substitution %s", target => {
    expect(() => decodeWindowsReparsePoint(reparse(target, true))).toThrow();
  });
  it("rejects unknown tags, flags, truncated fields and invalid UTF-16 ranges", () => {
    const tag = reparse("C:\\root", true); tag.writeUInt32LE(0x8000001b);
    const flags = reparse("a", false, true); flags.writeUInt32LE(2, 16);
    const offset = reparse("a", false, true); offset.writeUInt16LE(1, 8);
    const size = reparse("a", false, true); size.writeUInt16LE(200, 10);
    const print = reparse("a", false, true); print.writeUInt16LE(200, 14);
    for (const bytes of [tag, flags, offset, size, print, Buffer.alloc(7), reparse("a", false, true).subarray(0, 20)]) expect(() => decodeWindowsReparsePoint(bytes)).toThrow();
  });
});
it.skipIf(process.platform === "win32")("loads the source Windows helper before refusing another platform", async () => {
  const child = fork(fileURLToPath(new URL("../../../../src/commands/controller/markdown/local-source-windows-helper.ts", import.meta.url)), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], env: { ...process.env, NODE_OPTIONS: "" } });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  try {
    const reply = new Promise<unknown>((resolve, reject) => { child.once("message", resolve); child.once("close", () => reject(new Error("Windows source helper exited before its policy reply."))); });
    child.send({ type: "init", cwd: process.cwd() });
    await expect(reply).resolves.toMatchObject({ type: "error", code: "policy_restricted" });
  } finally { child.kill("SIGKILL"); await closed; }
});

const contexts: LocalImageContext[] = [], roots: string[] = [];
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = await mkdtemp(fileURLToPath(new URL("../../../../../../.tmp/windows-image-", import.meta.url))); roots.push(base);
  const cwd = path.join(base, "root"), outputPath = path.join(base, "reserved"); await mkdir(cwd); await writeFile(outputPath, "");
  const root = await stat(cwd, { bigint: true });
  const context = await createLocalImageContext({ cwd, policyRevision: "windows-test", nativeReadAllowed: true, expectedRoot: { dev: String(root.dev), ino: String(root.ino) } }); contexts.push(context);
  return { base, cwd, context, outputPath };
};
const allowed = async () => {};
describe.skipIf(process.platform !== "win32")("Windows local image source native handles", () => {
  it("proves real root and file IDs across a junction and parent traversal", async () => {
    const f = await fixture(); await mkdir(path.join(f.cwd, "a", "b"), { recursive: true }); await writeFile(path.join(f.cwd, "a", "image"), Buffer.alloc(524_289, 7));
    await symlink(path.join(f.cwd, "a", "b"), path.join(f.cwd, "link"), "junction");
    const nativeIdentity = async (filename: string) => {
      const observed = await stat(filename, { bigint: true }), koffi = await import("koffi"), kernel = koffi.load("kernel32.dll");
      const open = kernel.func("intptr_t __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, intptr_t template)");
      const info = kernel.func("int __stdcall GetFileInformationByHandleEx(intptr_t file, int kind, void *data, uint32_t length)");
      const close = kernel.func("int __stdcall CloseHandle(intptr_t file)");
      const handle = open(filename, 0x80, 7, null, 3, 0x02000000, 0) as number | bigint;
      expect(handle).not.toBe(-1); expect(handle).not.toBe(-1n);
      try { const bytes = Buffer.alloc(24); expect(info(handle, 18, bytes, bytes.length)).toBe(1); return { kind: "windows", dev: String(observed.dev), ino: String(observed.ino), fileId: bytes.toString("hex") }; }
      finally { expect(close(handle)).toBe(1); }
    };
    const root = await nativeIdentity(f.cwd), source = await nativeIdentity(path.join(f.cwd, "a", "image")), checks: LocalImageCheckpoint[] = [];
    await copyLocalImage({ ...f, path: "link/%2e%2e/image", checkPolicy: checkpoint => { checks.push(checkpoint); } });
    expect(checks.map(check => check.stage)).toEqual(["initial", "opened", "block", "block", "final"]);
    expect(checks[0]!.proof).toMatchObject({ requested: { locator: "link/%2e%2e/image", path: "link/../image" }, root: { cwd: f.cwd, identity: root }, opened: null, traversal: [] });
    expect(checks[1]!.proof.opened).toEqual(source);
    expect(checks[1]!.proof.traversal).toContainEqual(expect.objectContaining({ kind: "link", name: "link", target: path.join(f.cwd, "a", "b"), relative: false }));
    expect(checks[1]!.proof.traversal.some(step => step.kind === "parent")).toBe(true);
    expect(checks.slice(2).every(check => JSON.stringify(check.proof) === JSON.stringify(checks[1]!.proof))).toBe(true);
  });
  it("refuses an opened object without exporting bytes and releases its locks", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), "private");
    await expect(copyLocalImage({ ...f, path: "image", checkPolicy: checkpoint => { if (checkpoint.stage === "opened") throw new Error("object denied"); } })).rejects.toThrow("object denied");
    expect(await readFile(f.outputPath)).toHaveLength(0); await rename(f.cwd, `${f.cwd}-closed`);
  });
  it("bounds traversal evidence before exporting bytes", async () => {
    const f = await fixture(); await mkdir(path.join(f.cwd, "d")); await writeFile(path.join(f.cwd, "image"), "private");
    await expect(copyLocalImage({ ...f, path: `${"d/../".repeat(1000)}image`, checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" });
    expect(await readFile(f.outputPath)).toHaveLength(0);
  });
  it("copies relative, absolute and file-URI sources under the pinned root", async () => {
    const f = await fixture(), bytes = Buffer.from("original"); await writeFile(path.join(f.cwd, "image"), bytes);
    for (const source of ["image", path.join(f.cwd, "image"), `file:///${path.join(f.cwd, "image").replaceAll("\\", "/")}`]) {
      await writeFile(f.outputPath, ""); const result = await copyLocalImage({ ...f, path: source, checkPolicy: allowed });
      expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex")); expect(await readFile(f.outputPath)).toEqual(bytes);
    }
  });
  it("uses held directory ancestry for a junction followed by parent traversal", async () => {
    const f = await fixture(); await mkdir(path.join(f.cwd, "a", "b"), { recursive: true }); await writeFile(path.join(f.cwd, "a", "image"), "correct"); await writeFile(path.join(f.cwd, "image"), "wrong");
    await symlink(path.join(f.cwd, "a", "b"), path.join(f.cwd, "link"), "junction");
    await copyLocalImage({ ...f, path: "link\\..\\image", checkPolicy: allowed }); expect(await readFile(f.outputPath, "utf8")).toBe("correct");
  });
  it("binds a junction cwd alias to the same original root and accepts its physical pathname", async () => {
    const f = await fixture(), alias = path.join(f.base, "alias"); await writeFile(path.join(f.cwd, "image"), "original"); await symlink(f.cwd, alias, "junction");
    const identity = await stat(f.cwd, { bigint: true });
    const context = await createLocalImageContext({ cwd: alias, policyRevision: "windows-alias", nativeReadAllowed: true, expectedRoot: { dev: String(identity.dev), ino: String(identity.ino) } }); contexts.push(context);
    for (const source of ["image", path.join(alias, "image"), path.join(f.cwd, "image")]) {
      await writeFile(f.outputPath, ""); await copyLocalImage({ ...f, context, path: source, checkPolicy: allowed }); expect(await readFile(f.outputPath, "utf8")).toBe("original");
    }
    await writeFile(f.outputPath, ""); await expect(copyLocalImage({ ...f, context, path: `${alias}\\..\\outside`, checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" });
  });
  it("resolves a relative directory symlink without lexically collapsing its parent", async () => {
    const f = await fixture(); await mkdir(path.join(f.cwd, "a", "b"), { recursive: true }); await writeFile(path.join(f.cwd, "a", "image"), "correct");
    await symlink("a\\b", path.join(f.cwd, "link"), "dir");
    await copyLocalImage({ ...f, path: "link\\..\\image", checkPolicy: allowed }); expect(await readFile(f.outputPath, "utf8")).toBe("correct");
  });
  it("refuses an outside junction, sibling prefix and parent escape without bytes", async () => {
    const f = await fixture(); await mkdir(path.join(f.base, "outside")); await writeFile(path.join(f.base, "outside", "secret"), "secret"); await symlink(path.join(f.base, "outside"), path.join(f.cwd, "link"), "junction");
    for (const source of ["link\\secret", "..\\outside\\secret", path.join(f.base, "outside", "secret")]) await expect(copyLocalImage({ ...f, path: source, checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" });
    expect(await readFile(f.outputPath)).toHaveLength(0);
  });
  it("blocks replacement of the root and every opened ancestor until close", async () => {
    const f = await fixture(); await mkdir(path.join(f.cwd, "a")); await writeFile(path.join(f.cwd, "a", "image"), "authorized"); let checks = 0;
    await expect(rename(f.cwd, `${f.cwd}-old`)).rejects.toThrow();
    await copyLocalImage({ ...f, path: "a\\image", checkPolicy: async () => { if (++checks === 2) await expect(rename(path.join(f.cwd, "a"), path.join(f.cwd, "moved"))).rejects.toThrow(); } });
    await f.context.close(); await rename(f.cwd, `${f.cwd}-old`);
  });
  it("does not follow a held root changed into a junction through an attribute-only handle", async () => {
    const f = await fixture(), outside = path.join(f.base, "outside");
    await mkdir(outside); await writeFile(path.join(outside, "secret"), "outside bytes");
    const koffi = await import("koffi"), kernel = koffi.load("kernel32.dll");
    const create = kernel.func("intptr_t __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, intptr_t template)");
    const control = kernel.func("int __stdcall DeviceIoControl(intptr_t file, uint32_t code, void *input, uint32_t inputLength, void *output, uint32_t outputLength, void *count, void *overlapped)");
    const info = kernel.func("int __stdcall GetFileInformationByHandleEx(intptr_t file, int kind, void *data, uint32_t length)");
    const close = kernel.func("int __stdcall CloseHandle(intptr_t file)");
    const handle = create(f.cwd, 0x180, 7, null, 3, 0x02200000, 0) as number | bigint;
    expect(handle).not.toBe(-1); expect(handle).not.toBe(-1n);
    let changed = false;
    try {
      const before = Buffer.alloc(24), after = Buffer.alloc(24), count = Buffer.alloc(4);
      expect(info(handle, 18, before, before.length)).toBe(1);
      const substitute = Buffer.from(`\\??\\${outside}`, "utf16le"), display = Buffer.from(outside, "utf16le");
      const bytes = Buffer.alloc(16 + substitute.length + display.length + 4);
      bytes.writeUInt32LE(0xa0000003); bytes.writeUInt16LE(bytes.length - 8, 4);
      bytes.writeUInt16LE(substitute.length, 10); bytes.writeUInt16LE(substitute.length + 2, 12); bytes.writeUInt16LE(display.length, 14);
      substitute.copy(bytes, 16); display.copy(bytes, 18 + substitute.length);
      // FILE_SHARE_READ does not exclude FILE_WRITE_ATTRIBUTES. This mutation
      // preserves file identity, so ID checks cannot protect pathname opens.
      expect(control(handle, 0x900a4, bytes, bytes.length, null, 0, count, null)).toBe(1); changed = true;
      expect(info(handle, 18, after, after.length)).toBe(1); expect(after).toEqual(before);
      await expect(copyLocalImage({ ...f, path: "secret", checkPolicy: allowed })).rejects.toThrow();
      expect(await readFile(f.outputPath)).toHaveLength(0);
    } finally {
      try { if (changed) { const bytes = Buffer.alloc(8); bytes.writeUInt32LE(0xa0000003); expect(control(handle, 0x900ac, bytes, bytes.length, null, 0, Buffer.alloc(4), null)).toBe(1); } }
      finally { expect(close(handle)).toBe(1); }
    }
  });
  it("checks per-block policy and joins a cancelled helper before returning", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), Buffer.alloc(1_048_576)); const controller = new AbortController(); let notify!: () => void, checks = 0;
    const checkpoint = new Promise<void>(resolve => { notify = resolve; });
    const copying = copyLocalImage({ ...f, path: "image", signal: controller.signal, checkPolicy: async () => { if (++checks === 3) { notify(); await new Promise(() => {}); } } });
    await checkpoint; controller.abort(); await expect(copying).rejects.toMatchObject({ code: "source_cancelled" });
    await rename(f.cwd, `${f.cwd}-closed`); expect(await readFile(f.outputPath)).toHaveLength(0);
  });
  it("refuses existing writable source handles and blocks source modification during copy", async () => {
    const f = await fixture(), source = path.join(f.cwd, "image"); await writeFile(source, "original");
    const writer = await open(source, "r+");
    try { await expect(copyLocalImage({ ...f, path: "image", checkPolicy: allowed })).rejects.toMatchObject({ code: "source_busy" }); }
    finally { await writer.close(); }
    let checks = 0;
    await copyLocalImage({ ...f, path: "image", checkPolicy: async () => { if (++checks === 2) await expect(writeFile(source, "changed")).rejects.toThrow(); } });
    expect(await readFile(f.outputPath, "utf8")).toBe("original");
  });
  it("delivers no block after policy revocation and releases all opened file handles", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), Buffer.alloc(1_048_576)); let checks = 0;
    await expect(copyLocalImage({ ...f, path: "image", checkPolicy: async () => { if (++checks === 3) throw new Error("revoked"); } })).rejects.toThrow("revoked");
    expect(await readFile(f.outputPath)).toHaveLength(0); await rename(f.cwd, `${f.cwd}-released`);
  });
  it("allows forty junction expansions and refuses the forty-first or a loop", async () => {
    const f = await fixture(); await mkdir(path.join(f.cwd, "target")); await writeFile(path.join(f.cwd, "target", "image"), "original");
    for (let index = 40; index >= 0; index--) await symlink(path.join(f.cwd, index === 40 ? "target" : `link${index + 1}`), path.join(f.cwd, `link${index}`), "junction");
    await expect(copyLocalImage({ ...f, path: "link0\\image", checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" });
    await copyLocalImage({ ...f, path: "link1\\image", checkPolicy: allowed }); expect(await readFile(f.outputPath, "utf8")).toBe("original");
    await writeFile(f.outputPath, ""); await symlink(path.join(f.cwd, "cycle"), path.join(f.cwd, "cycle"), "junction");
    await expect(copyLocalImage({ ...f, path: "cycle\\image", checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" });
  });
  it("copies exactly ten MiB in policy-checked blocks and rejects the next byte", async () => {
    const f = await fixture(), bytes = Buffer.alloc(10_485_760, 3); await writeFile(path.join(f.cwd, "image"), bytes); let checks = 0;
    expect((await copyLocalImage({ ...f, path: "image", checkPolicy: async () => { checks++; } })).sha256).toBe(createHash("sha256").update(bytes).digest("hex")); expect(checks).toBe(23);
    await writeFile(f.outputPath, ""); await writeFile(path.join(f.cwd, "image"), Buffer.alloc(10_485_761));
    await expect(copyLocalImage({ ...f, path: "image", checkPolicy: allowed })).rejects.toMatchObject({ code: "source_too_large" }); expect(await readFile(f.outputPath)).toHaveLength(0);
  });
  it("refuses an output junction before following it to another file", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), "original"); await mkdir(path.join(f.base, "private")); await writeFile(path.join(f.base, "private", "reserved"), "secret");
    await symlink(path.join(f.base, "private"), path.join(f.base, "redirect"), "junction");
    await expect(copyLocalImage({ ...f, outputPath: path.join(f.base, "redirect", "reserved"), path: "image", checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" }); expect(await readFile(path.join(f.base, "private", "reserved"), "utf8")).toBe("secret");
  });
  it("rejects a root replaced before context creation under the original identity", async () => {
    const f = await fixture(), root = await stat(f.cwd, { bigint: true }); await f.context.close();
    await rename(f.cwd, `${f.cwd}-old`); await mkdir(f.cwd);
    await expect(createLocalImageContext({ cwd: f.cwd, policyRevision: "windows-test", nativeReadAllowed: true, expectedRoot: { dev: String(root.dev), ino: String(root.ino) } })).rejects.toMatchObject({ code: "source_forbidden" });
  });
});
