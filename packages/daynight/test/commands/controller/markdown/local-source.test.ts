import { afterEach, describe, expect, it } from "vitest";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLocalImageContext, copyLocalImage, parseLocalImagePath, type LocalImageContext } from "../../../../src/commands/controller/markdown/local-source.js";

const contexts: LocalImageContext[] = [], directories: string[] = [];
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const base = await mkdtemp(fileURLToPath(new URL("../../../../../../.tmp/local-image-", import.meta.url))); directories.push(base);
  const cwd = path.join(base, "root"), outputPath = path.join(base, "reserved");
  await mkdir(cwd); await writeFile(outputPath, Buffer.alloc(0), { mode: 0o600 });
  const context = await createLocalImageContext({ cwd, policyRevision: "1", nativeReadAllowed: true }); contexts.push(context);
  return { base, cwd, context, outputPath };
}
const allowed = async () => {};
describe("local image source path parsing", () => {
  it("decodes paths once while retaining parent components and POSIX backslashes", () => {
    expect(parseLocalImagePath("sub/../x%252e%20a%3F%23\\b", "linux")).toBe("sub/../x%2e a?#\\b");
    expect(parseLocalImagePath("file://localhost/a/link/%2e%2e/x", "linux")).toBe("/a/link/../x");
  });
  it.each(["//host/x", "file://host/a", "file:///x?y", "file:///x#y", "file://user@localhost/a", "file:///a%2fb", "a%5Cb", "a%00", "%zz", "a?b", "a#b", "https://example.com/a", "data:xxx", "a\u0000b", "a\u0085b", "a%C2%85b", "file:///a\\b", "\ud800"])("rejects forbidden path %s", value => {
    expect(() => parseLocalImagePath(value, "linux")).toThrow();
  });
  it.each(["C:foo", "\\foo", "\\\\host\\x", "\\\\?\\C:\\x", "C:\\a:stream", "C:\\NUL.png", "C:\\a.\\x", "C:\\a \\x", "C:\\CONIN$", "C:\\CONOUT$", "C:\\CLOCK$", "C:\\NUL .png"])("rejects ambiguous Windows path %s", value => {
    expect(() => parseLocalImagePath(value, "win32")).toThrow();
  });
});
describe.skipIf(process.platform === "win32")("local image source handles", () => {
  it("copies an authorized regular file to an existing reserved file", async () => {
    const f = await fixture(), bytes = Buffer.from("original"); await writeFile(path.join(f.cwd, "image"), bytes);
    expect(await copyLocalImage({ path: "image", ...f, checkPolicy: allowed })).toEqual({ inputPath: f.outputPath, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(await readFile(f.outputPath)).toEqual(bytes);
  });
  it("resolves symlink parents using the held directory stack", async () => {
    const f = await fixture(); await mkdir(path.join(f.cwd, "a")); await mkdir(path.join(f.cwd, "a", "b"));
    await writeFile(path.join(f.cwd, "a", "image"), "correct"); await writeFile(path.join(f.cwd, "image"), "wrong"); await symlink("a/b", path.join(f.cwd, "link"));
    await copyLocalImage({ ...f, path: "link/../image", checkPolicy: allowed }); expect(await readFile(f.outputPath, "utf8")).toBe("correct");
  });
  it("allows an absolute symlink only inside the authorized root", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), "inside"); await symlink(path.join(f.cwd, "image"), path.join(f.cwd, "link"));
    await copyLocalImage({ ...f, path: path.join(f.cwd, "link"), checkPolicy: allowed }); expect(await readFile(f.outputPath, "utf8")).toBe("inside");
  });
  it("accepts the verified physical spelling of a cwd with an ancestor alias", async () => {
    const f = await fixture(), alias = path.join(f.base, "alias"); await symlink(f.base, alias);
    const context = await createLocalImageContext({ cwd: path.join(alias, "root"), policyRevision: "1", nativeReadAllowed: true }); contexts.push(context);
    await writeFile(path.join(f.cwd, "image"), "physical"); await copyLocalImage({ ...f, context, path: path.join(f.cwd, "image"), checkPolicy: allowed });
    expect(await readFile(f.outputPath, "utf8")).toBe("physical");
  });
  it("refuses parent traversal and symlinks outside the root", async () => {
    const f = await fixture(); await writeFile(path.join(f.base, "secret"), "secret"); await symlink("../secret", path.join(f.cwd, "link"));
    for (const candidate of ["../secret", "link", path.join(f.base, "secret")]) await expect(copyLocalImage({ ...f, path: candidate, checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" });
    expect(await readFile(f.outputPath)).toHaveLength(0);
  });
  it("rejects a root replaced before creating a helper when the execution identity is pinned", async () => {
    const f = await fixture(), original = await stat(f.cwd, { bigint: true });
    await rename(f.cwd, `${f.cwd}-old`); await mkdir(f.cwd); await writeFile(path.join(f.cwd, "image"), "replacement");
    const creating = createLocalImageContext({ cwd: f.cwd, policyRevision: "1", nativeReadAllowed: true, expectedRoot: { dev: String(original.dev), ino: String(original.ino) } });
    void creating.then(context => { contexts.push(context); }, () => {});
    await expect(creating).rejects.toMatchObject({ code: "source_forbidden" });
  });
  it("does not adopt a replacement root directory", async () => {
    const f = await fixture(); await rename(f.cwd, `${f.cwd}-old`); await mkdir(f.cwd); await writeFile(path.join(f.cwd, "image"), "replacement");
    await expect(copyLocalImage({ ...f, path: "image", checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" }); expect(await readFile(f.outputPath)).toHaveLength(0);
  });
  it("checks policy before opening and between every delivered block", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), Buffer.alloc(1_048_576, 7)); let checks = 0;
    await expect(copyLocalImage({ ...f, path: "image", checkPolicy: async () => { if (++checks === 3) throw new Error("revoked"); } })).rejects.toThrow("revoked");
    expect((await readFile(f.outputPath)).length).toBeLessThanOrEqual(524_288);
  });
  it("detects a source change after the first delivered block", async () => {
    const f = await fixture(), source = path.join(f.cwd, "image"); await writeFile(source, Buffer.alloc(1_048_576, 7)); let checks = 0;
    await expect(copyLocalImage({ ...f, path: "image", checkPolicy: async () => { if (++checks === 3) await writeFile(source, Buffer.alloc(1_048_576, 8)); } })).rejects.toMatchObject({ code: "source_changed" });
  });
  it("cancels a blocked policy checkpoint and joins the helper before returning", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), Buffer.alloc(1_048_576)); const controller = new AbortController(); let notify!: () => void;
    const checkpoint = new Promise<void>(resolve => { notify = resolve; }); let checks = 0;
    const result = copyLocalImage({ ...f, path: "image", signal: controller.signal, checkPolicy: async () => { if (++checks === 3) { notify(); await new Promise(() => {}); } } });
    await checkpoint; controller.abort(); await expect(result).rejects.toMatchObject({ code: "source_cancelled" });
    const before = (await readFile(f.outputPath)).length; await new Promise(resolve => setTimeout(resolve, 30)); expect((await readFile(f.outputPath)).length).toBe(before);
    await expect(copyLocalImage({ ...f, path: "image", checkPolicy: allowed })).rejects.toMatchObject({ code: "context_unavailable" });
  });
  it("refuses an unreserved output without creating it", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), "original"); const target = `${f.outputPath}-missing`;
    await expect(copyLocalImage({ ...f, path: "image", outputPath: target, checkPolicy: allowed })).rejects.toThrow(); await expect(open(target, constants.O_RDONLY)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects empty and oversized files without delivering bytes", async () => {
    const f = await fixture();
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(10_485_761)]) { await writeFile(path.join(f.cwd, "image"), bytes); await expect(copyLocalImage({ ...f, path: "image", checkPolicy: allowed })).rejects.toThrow(); expect(await readFile(f.outputPath)).toHaveLength(0); }
  });
});
it("refuses unknown native policy and unsupported platform contexts", async () => {
  await expect(createLocalImageContext({ cwd: process.cwd(), policyRevision: "1", nativeReadAllowed: undefined })).rejects.toMatchObject({ code: "policy_restricted" });
  await expect(createLocalImageContext({ cwd: "C:\\project", platform: "win32", policyRevision: "1", nativeReadAllowed: true })).rejects.toMatchObject({ code: "policy_restricted" });
});

describe.skipIf(process.platform === "win32")("local image source races and special objects", () => {
  it("keeps the authorized object when an opened ancestor becomes a symlink", async () => {
    const f = await fixture(); await mkdir(path.join(f.cwd, "directory")); await writeFile(path.join(f.cwd, "directory", "image"), "authorized");
    const outside = path.join(f.base, "outside"); await mkdir(outside); await writeFile(path.join(outside, "image"), "secret"); let checks = 0;
    await copyLocalImage({ ...f, path: "directory/image", checkPolicy: async () => {
      if (++checks === 2) { await rename(path.join(f.cwd, "directory"), path.join(f.cwd, "held")); await symlink(outside, path.join(f.cwd, "directory")); }
    } });
    expect(await readFile(f.outputPath, "utf8")).toBe("authorized");
  });
  it("refuses a link switched outside before source traversal", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), "authorized"); await writeFile(path.join(f.base, "secret"), "secret"); await symlink("image", path.join(f.cwd, "link"));
    await expect(copyLocalImage({ ...f, path: "link", checkPolicy: async () => { await rm(path.join(f.cwd, "link")); await symlink("../secret", path.join(f.cwd, "link")); } })).rejects.toMatchObject({ code: "source_forbidden" });
    expect(await readFile(f.outputPath)).toHaveLength(0);
  });
  it("allows forty symlink expansions and refuses the forty-first", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), "authorized");
    for (let index = 40; index >= 0; index--) await symlink(index === 40 ? "image" : `link${index + 1}`, path.join(f.cwd, `link${index}`));
    await expect(copyLocalImage({ ...f, path: "link0", checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" });
    await copyLocalImage({ ...f, path: "link1", checkPolicy: allowed }); expect(await readFile(f.outputPath, "utf8")).toBe("authorized");
  });
  it("bounds symlink loops", async () => {
    const f = await fixture(); await symlink("b", path.join(f.cwd, "a")); await symlink("a", path.join(f.cwd, "b"));
    await expect(copyLocalImage({ ...f, path: "a", checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" });
  });
  it("refuses a FIFO without waiting for a writer", async () => {
    const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
    const f = await fixture(); await promisify(execFile)("mkfifo", [path.join(f.cwd, "pipe")]);
    await expect(copyLocalImage({ ...f, path: "pipe", checkPolicy: allowed })).rejects.toMatchObject({ code: "source_forbidden" });
    expect(await readFile(f.outputPath)).toHaveLength(0);
  });
  it("refuses output replacement before publishing a completed snapshot", async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, "image"), "authorized"); let checks = 0;
    await expect(copyLocalImage({ ...f, path: "image", checkPolicy: async () => {
      if (++checks === 4) { await rename(f.outputPath, `${f.outputPath}-held`); await writeFile(f.outputPath, "replacement", { mode: 0o600 }); }
    } })).rejects.toMatchObject({ code: "source_changed" });
    expect(await readFile(f.outputPath, "utf8")).toBe("replacement");
  });
  it("copies exactly the maximum file size in bounded blocks", async () => {
    const f = await fixture(), bytes = Buffer.alloc(10_485_760, 17); await writeFile(path.join(f.cwd, "image"), bytes); let checks = 0;
    const result = await copyLocalImage({ ...f, path: "image", checkPolicy: async () => { checks++; } });
    expect(result.byteLength).toBe(bytes.length); expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex")); expect(checks).toBe(23); expect(createHash("sha256").update(await readFile(f.outputPath)).digest("hex")).toBe(result.sha256);
  });
});
