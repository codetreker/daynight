import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import Database from "better-sqlite3";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { validateImageFile } from "../../../src/commands/controller/media/image-validation.js";
import type { ImageUploadSpec } from "../../../src/session/image-values.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-preparation-count"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "i-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const bytes = await sharp({ create: { width: 23, height: 19, channels: 4, background: "blue" } }).png().toBuffer();
  const spec: ImageUploadSpec = { uploadId: randomUUID(), imageId: randomUUID(), target: { serverOrigin: ticket.serverOrigin, actorUserId: ticket.userId!, fence: { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1" }, expectedNativeSessionId: "native" }, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") };
  const file = path.join(home, "journal.sqlite"), options = { imageDecoder: validateImageFile };
  const store = openControllerLifecycleStore(file, ticket, options); store.patchSnapshot({ nativeSessionId: "native" });
  return { file, ticket, bytes, spec, options, store };
};

test("more than 10000 retained preparation records do not prevent new preparations after reopening", async () => {
  const f = await fixture(), media = f.store.media();
  await media.prepare(f.spec);
  await media.close(); f.store.close();
  const db = new Database(f.file);
  try {
    const row = db.prepare("SELECT value FROM image_preparations WHERE upload_id=?").get(f.spec.uploadId) as { value: string };
    const original = JSON.parse(row.value);
    const insert = db.prepare("INSERT INTO image_preparations VALUES(?,?)");
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const uploadId = randomUUID(), imageId = randomUUID();
        insert.run(uploadId, JSON.stringify({ ...original, spec: { ...original.spec, uploadId, imageId }, receipt: { ...original.receipt, uploadId, imageId, state: "released" } }));
      }
    }).immediate();
    expect((db.prepare("SELECT COUNT(*) AS count FROM image_preparations").get() as { count: number }).count).toBe(10_001);
  } finally { db.close(); }
  const reopened = openControllerLifecycleStore(f.file, f.ticket, f.options), recovered = reopened.media();
  try {
    const spec = { ...f.spec, uploadId: randomUUID(), imageId: randomUUID() };
    expect(await recovered.prepare(spec)).toMatchObject({ uploadId: spec.uploadId, state: "receiving" });
    expect(await recovered.write({ uploadId: spec.uploadId, offset: "0", sha256: spec.sha256, data: f.bytes.toString("base64") })).toMatchObject({ acceptedOffset: spec.byteLength });
    expect(await recovered.complete(spec)).toMatchObject({ state: "validated" });
    expect(await recovered.readPrepared({ preparationId: spec.uploadId, offset: "0", limit: 524288 })).toMatchObject({ data: f.bytes.toString("base64"), eof: true });
  } finally { await recovered.close(); reopened.close(); }
});
