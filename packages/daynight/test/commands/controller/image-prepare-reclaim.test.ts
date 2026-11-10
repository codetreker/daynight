import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, open, symlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { parseImageRequest } from "../../../src/session/controller-protocol.js";
import type { ImageUploadSpec } from "../../../src/session/image-values.js";

const faults = vi.hoisted(() => ({ lowSpace: false, stagingFlush: false, unlink: null as string | null, directoryFlush: false }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    statfsSync: (...args: unknown[]) => faults.lowSpace ? { bavail: 0n, bsize: 4096n } : Reflect.apply(fs.statfsSync, fs, args),
    fsyncSync: (fd: number) => {
      if (faults.directoryFlush && fs.fstatSync(fd).isDirectory()) {
        faults.directoryFlush = false;
        throw Object.assign(new Error("Directory flush failed"), { code: "EIO" });
      }
      if (faults.stagingFlush && fs.fstatSync(fd).isFile()) {
        faults.stagingFlush = false;
        throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
      }
      fs.fsyncSync(fd);
    },
    unlinkSync: (filename: string) => {
      if (faults.unlink && filename.endsWith(".part")) {
        const code = faults.unlink; faults.unlink = null;
        throw Object.assign(new Error("File cleanup unavailable"), { code });
      }
      fs.unlinkSync(filename);
    },
  };
});
const roots: string[] = [];
afterEach(async () => { faults.lowSpace = false; faults.stagingFlush = false; faults.unlink = null; faults.directoryFlush = false; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-prepare-reclaim-tests");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "i-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const bytes = Buffer.from("original");
  const spec: ImageUploadSpec = { uploadId: randomUUID(), imageId: randomUUID(), target: { serverOrigin: ticket.serverOrigin, actorUserId: ticket.userId!, fence: { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1" }, expectedNativeSessionId: "native" }, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") };
  const file = path.join(home, "journal.sqlite"), store = openControllerLifecycleStore(file, ticket);
  store.patchSnapshot({ nativeSessionId: "native" });
  return { ticket, home, file, store, spec };
};

test("a rejected prepare can be released under its exact original identity and stays released after restart", async () => {
  const f = await fixture(); const media = f.store.media();
  try {
    faults.lowSpace = true;
    await expect(media.prepare(f.spec)).rejects.toThrow("budget");
    expect(await readdir(`${f.file}.media-staging`)).toEqual(expect.arrayContaining(["owner.json", "native"]));
    const request = { uploadId: f.spec.uploadId, spec: f.spec };
    const receipt = await media.release(request);
    expect(receipt).toEqual({ uploadId: f.spec.uploadId, imageId: f.spec.imageId, target: f.spec.target, state: "released", acceptedOffset: "0", validated: null, error: null });
    faults.lowSpace = false;
    expect(await media.prepare(f.spec)).toEqual(receipt);
    await media.close(); f.store.close();
    const store = openControllerLifecycleStore(f.file, f.ticket); const recovered = store.media();
    try {
      expect(await recovered.status({ uploadId: f.spec.uploadId })).toEqual(receipt);
      expect(await recovered.prepare(f.spec)).toEqual(receipt);
      await expect(recovered.prepare({ ...f.spec, sha256: "b".repeat(64) })).rejects.toThrow("conflict");
      expect((await readdir(`${f.file}.media-staging`)).filter(name => name.endsWith(".part"))).toEqual([]);
    } finally { await recovered.close(); store.close(); }
  } finally { await f.store.stopMedia(); f.store.close(); }
});

test("a preparation file flush failure keeps the original durable path until release removes it", async () => {
  const f = await fixture(); const media = f.store.media();
  try {
    faults.stagingFlush = true;
    await expect(media.prepare(f.spec)).rejects.toMatchObject({ code: "ENOSPC" });
    const filename = media.preparationPath(f.spec.uploadId);
    expect(await readFile(filename)).toHaveLength(0);
    const request = { uploadId: f.spec.uploadId, spec: f.spec };
    expect(await media.release(request)).toMatchObject({ state: "released", imageId: f.spec.imageId });
    await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(`${f.file}.media-staging`)).filter(name => name.endsWith(".part"))).toEqual([]);
  } finally { await media.close(); f.store.close(); }
});

test("release refuses changed original metadata and cannot manufacture identity for a missing legacy request", async () => {
  const f = await fixture(); const media = f.store.media();
  try {
    await media.prepare(f.spec);
    const filename = media.preparationPath(f.spec.uploadId);
    const request = { uploadId: f.spec.uploadId, spec: { ...f.spec, sha256: "b".repeat(64) } };
    await expect(media.release(request)).rejects.toThrow("conflict");
    expect(await readFile(filename)).toHaveLength(0);
    await expect(media.release({ uploadId: randomUUID() })).rejects.toThrow("unavailable");
    const mismatched = { uploadId: randomUUID(), spec: f.spec };
    await expect(media.release(mismatched)).rejects.toThrow();
    expect(await media.status({ uploadId: f.spec.uploadId })).toMatchObject({ state: "receiving" });
  } finally { await media.close(); f.store.close(); }
});

test("the strict release request parser accepts only an exact optional original spec", async () => {
  const f = await fixture();
  try {
    const request = { protocol: "daynight.session.v1", type: "image_request", sessionId: f.ticket.sessionId, claimId: f.ticket.claimId, executionGeneration: "1", connectionEpoch: "1", requestId: randomUUID(), action: "release", body: { uploadId: f.spec.uploadId, spec: f.spec } };
    expect(parseImageRequest(request)).toEqual(request);
    for (const body of [ { uploadId: f.spec.uploadId, spec: null }, { uploadId: randomUUID(), spec: f.spec }, { uploadId: f.spec.uploadId, spec: { ...f.spec, sha256: "invalid" } }, { ...request.body, unexpected: true } ]) {
      expect(() => parseImageRequest({ ...request, body })).toThrow();
    }
    expect(parseImageRequest({ ...request, body: { uploadId: f.spec.uploadId } }).body).toEqual({ uploadId: f.spec.uploadId });
  } finally { await f.store.stopMedia(); f.store.close(); }
});

test("metadata insertion failure cannot leave an unowned preparation file", async () => {
  const f = await fixture(); const media = f.store.media();
  const db = new Database(f.file);
  try {
    db.exec("CREATE TRIGGER reject_preparation BEFORE INSERT ON image_preparations BEGIN SELECT RAISE(ABORT,'metadata capacity unavailable'); END");
    await expect(media.prepare(f.spec)).rejects.toThrow("metadata capacity");
    expect(db.prepare("SELECT upload_id FROM image_preparations").all()).toEqual([]);
    expect((await readdir(`${f.file}.media-staging`)).filter(name => name.endsWith(".part"))).toEqual([]);
    const request = { uploadId: f.spec.uploadId, spec: f.spec };
    await expect(media.release(request)).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER" });
    await expect(media.status({ uploadId: f.spec.uploadId })).rejects.toThrow("unavailable");
    db.exec("DROP TRIGGER reject_preparation");
    expect(await media.release(request)).toMatchObject({ state: "released", imageId: f.spec.imageId });
    expect(await media.prepare(f.spec)).toMatchObject({ state: "released" });
  } finally { db.close(); await media.close(); f.store.close(); }
});

test.each(["unlink", "directoryFlush", "receipt"] as const)("release retains its original identity after a %s storage failure", async phase => {
  const f = await fixture(); const media = f.store.media(); const db = new Database(f.file);
  try {
    await media.prepare(f.spec);
    const request = { uploadId: f.spec.uploadId, spec: f.spec };
    if (phase === "receipt") db.exec("BEGIN IMMEDIATE");
    else if (phase === "unlink") faults.unlink = "EBUSY";
    else faults.directoryFlush = true;
    await expect(media.release(request)).rejects.toMatchObject({ name: "ImageReleaseStorageError", cause: expect.any(Error) });
    expect(await media.status({ uploadId: f.spec.uploadId })).toMatchObject({ state: "receiving", imageId: f.spec.imageId });
    if (phase === "receipt") db.exec("ROLLBACK");
    const released = await media.release(request);
    expect(released).toMatchObject({ state: "released", imageId: f.spec.imageId });
    expect(await media.prepare(f.spec)).toEqual(released);
    expect((await readdir(`${f.file}.media-staging`)).filter(name => name.endsWith(".part"))).toEqual([]);
  } finally { if (db.inTransaction) db.exec("ROLLBACK"); db.close(); await media.close(); f.store.close(); }
}, 15_000);

test.each(["EPERM", "EACCES", "EROFS"])("release can reconcile an original filesystem %s refusal", async code => {
  const f = await fixture(); const media = f.store.media();
  try {
    await media.prepare(f.spec); faults.unlink = code;
    await expect(media.release({ uploadId: f.spec.uploadId })).rejects.toMatchObject({ name: "ImageReleaseStorageError", cause: expect.objectContaining({ code }) });
    expect(await media.status({ uploadId: f.spec.uploadId })).toMatchObject({ state: "receiving" });
    expect(await media.release({ uploadId: f.spec.uploadId })).toMatchObject({ state: "released" });
  } finally { await media.close(); f.store.close(); }
});

test("release can resume after metadata capacity returns without classifying an unsafe path as transient", async () => {
  const f = await fixture(); const media = f.store.media();
  const history = `${f.file}.history-sync`, retained = path.join(history, "retained.json");
  try {
    await media.prepare(f.spec);
    await mkdir(history, { mode: 0o700 }); const file = await open(retained, "wx");
    try { await file.truncate(136 * 1048576); } finally { await file.close(); }
    await expect(media.release({ uploadId: f.spec.uploadId })).rejects.toMatchObject({ name: "ImageReleaseStorageError" });
    expect(await media.status({ uploadId: f.spec.uploadId })).toMatchObject({ state: "receiving" });
    await rm(retained);
    if (process.platform !== "win32") {
      await symlink(f.file, retained);
      await expect(media.release({ uploadId: f.spec.uploadId })).rejects.toThrow("regular file");
      await rm(retained);
    }
    expect(await media.release({ uploadId: f.spec.uploadId })).toMatchObject({ state: "released" });
  } finally { await media.close(); f.store.close(); }
});
