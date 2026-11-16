import { afterEach, expect, test, vi } from "vitest";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { MarkdownProjectedOccurrence } from "../../../src/commands/controller/markdown/projection.js";

// Production decoding verifies hashes of the packaged helper and engine.
const implementation = new URL("../../../dist/commands/controller/stopped-markdown-images.js", import.meta.url).href;
const { resolveStoppedMarkdownImage } = await import(implementation) as typeof import("../../../src/commands/controller/stopped-markdown-images.js");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgZGL+DwABFAEG9O6t0QAAAABJRU5ErkJggg==", "base64");
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const scratch = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const base = await mkdtemp(path.join(scratch, "stopped-images-")); roots.push(base);
  const cwd = path.join(base, "original-worktree"); await mkdir(cwd);
  const observed = await stat(cwd, { bigint: true }), root = { dev: String(observed.dev), ino: String(observed.ino) };
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd, nativeHome: path.join(base, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(base, "grant.json"), ipcEndpoint: path.join(base, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
  };
  const imageId = randomUUID(), text = "![original](original.png)";
  const source: MarkdownProjectedOccurrence = {
    occurrence: { imageId, entryId: randomUUID(), container: "content", partId: randomUUID(), sourceRevision: "1", sourceTextSha256: createHash("sha256").update(text).digest("hex"), callId: null, sourceKey: "original-markdown-image" },
    destination: "original.png", linkHref: null, contextKey: "original", start: 0, end: text.length,
    part: { type: "image_unavailable", imageId, label: "original", error: { code: "source_unavailable", message: "Image has not been captured." } },
  };
  const context = { ticket, root, journalPath: path.join(base, "original.sqlite") };
  await writeFile(path.join(cwd, source.destination), png);
  const clean = async () => expect((await readdir(base)).filter(name => name.startsWith("markdown-repair-image-"))).toEqual([]);
  return { base, cwd, source, context, clean };
};

test("stopped repair copies the original local PNG through the platform helper and bundled decoder", async () => {
  const f = await fixture(), original = JSON.stringify(f.source);
  const resolved = await resolveStoppedMarkdownImage(f.source, f.context);
  expect(Buffer.from(resolved.bytes)).toEqual(png);
  expect(resolved.resource).toMatchObject({ status: "available", resourceId: f.source.occurrence.imageId, mediaType: "image/png", byteLength: String(png.length), sha256: createHash("sha256").update(png).digest("hex"), error: null });
  expect(resolved.part).toEqual({ type: "image", imageId: f.source.occurrence.imageId, resourceId: resolved.resource.resourceId, label: "original" });
  expect(await readFile(path.join(f.cwd, "original.png"))).toEqual(png);
  expect(JSON.stringify(f.source)).toBe(original); await f.clean();
}, 30_000);

test("a missing original image is diagnosed without leaving a repair copy", async () => {
  const f = await fixture(); await rm(path.join(f.cwd, "original.png"));
  await expect(resolveStoppedMarkdownImage(f.source, f.context)).rejects.toMatchObject({ code: "source_not_found" });
  await f.clean();
}, 15_000);

test("replacing the original root refuses the replacement image before capture", async () => {
  const f = await fixture();
  await rename(f.cwd, `${f.cwd}-preserved`); await mkdir(f.cwd); await writeFile(path.join(f.cwd, "original.png"), png);
  await expect(resolveStoppedMarkdownImage(f.source, f.context)).rejects.toMatchObject({ code: "source_changed" });
  expect(await readFile(path.join(`${f.cwd}-preserved`, "original.png"))).toEqual(png); await f.clean();
});

test.each(["../outside.png", "https://example.com/original.png"])("stopped repair refuses the unowned locator %s", async destination => {
  const f = await fixture(); await writeFile(path.join(f.base, "outside.png"), png);
  await expect(resolveStoppedMarkdownImage({ ...f.source, destination }, f.context)).rejects.toMatchObject({ code: "source_forbidden" });
  expect(await readFile(path.join(f.base, "outside.png"))).toEqual(png); await f.clean();
});

test("stopped repair rejects a symlink or junction even when its target remains inside the root", async () => {
  const f = await fixture(); await mkdir(path.join(f.cwd, "images")); await writeFile(path.join(f.cwd, "images", "original.png"), png);
  await symlink(path.join(f.cwd, "images"), path.join(f.cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
  await expect(resolveStoppedMarkdownImage({ ...f.source, destination: "alias/original.png" }, f.context)).rejects.toMatchObject({ code: "source_forbidden" });
  await f.clean();
}, 15_000);

test("cancellation joins the actual decoder and local helper before removing its private copy", async () => {
  const f = await fixture(), abort = new AbortController(), reason = new Error("Controlled repair cancellation");
  const children: { child: ChildProcess; closed: boolean }[] = [];
  const observe = (child: ChildProcess) => { const entry = { child, closed: false }; children.push(entry); child.once("close", () => { entry.closed = true; }); return child; };
  const fork = childProcess.fork, spawn = childProcess.spawn;
  vi.spyOn(childProcess, "fork").mockImplementation(((...args: Parameters<typeof fork>) => observe(fork(...args))) as typeof fork);
  vi.spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
    const child = observe(spawn(...args));
    if (Array.isArray(args[1]) && args[1].some(arg => String(arg).endsWith("image-validation-helper.js"))) child.once("spawn", () => abort.abort(reason));
    return child;
  }) as typeof spawn);
  syncBuiltinESMExports();
  await expect(resolveStoppedMarkdownImage(f.source, { ...f.context, signal: abort.signal })).rejects.toBe(reason);
  expect(abort.signal.aborted).toBe(true); expect(children.length).toBeGreaterThanOrEqual(2);
  expect(children.every(child => child.closed)).toBe(true);
  expect(await readFile(path.join(f.cwd, "original.png"))).toEqual(png); await f.clean();
}, 30_000);
