import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import * as archive from "../../src/session/archive.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const timeline = { entries: [{entryId:id(5),entrySeq:"1",revision:"1",kind:"assistant_message",content:[{type:"resource",resourceId:id(6),label:"original"}]}] };
const original = Buffer.from("original");
const resource = { resourceId:id(6),status:"available",name:"result.txt",mediaType:"text/plain",byteLength:"8",sha256:digest(original),error:null };
const manifest = () => ({schemaVersion:3,contentKind:"native_timeline",recordId:id(1),fence:{sessionId:id(1),claimId:id(2),executionGeneration:"1"},provider:"codex",nativeSessionId:"native",controllerId:id(3),controllerInstanceId:id(4),timeline:{fileId:id(7),sha256:digest(JSON.stringify(timeline)),byteLength:String(Buffer.byteLength(JSON.stringify(timeline)))},resources:[{resource,blobId:id(8)}],completeness:"complete"});

test("validates external archive identity and exact resource closure without embedding original bytes", async () => {
  expect(typeof archive.parseSessionArchiveManifest).toBe("function");
  const parsed = archive.parseSessionArchiveManifest(manifest());
  expect(parsed.resources).toEqual([{resource,blobId:id(8)}]);
  await expect(archive.verifySessionArchiveClosure(parsed, Buffer.from(JSON.stringify(timeline)), async () => original)).resolves.toEqual(timeline);
  await expect(archive.verifySessionArchiveClosure(parsed, Buffer.from(JSON.stringify(timeline)), async () => Buffer.from("changed!"))).rejects.toThrow();
  expect(() => archive.parseSessionArchiveManifest({...manifest(),recordId:id(9)})).toThrow();
  expect(() => archive.parseSessionArchiveManifest({...manifest(),resources:[{resource,blobId:null}]})).toThrow();
  expect(() => archive.parseSessionArchiveManifest({...manifest(),data:"not permitted"})).toThrow();
});

test("rejects missing references and refuses partial archival of a known saved resource", async () => {
  expect(typeof archive.verifySessionArchiveClosure).toBe("function");
  await expect(archive.verifySessionArchiveClosure(archive.parseSessionArchiveManifest({...manifest(),resources:[]}), Buffer.from(JSON.stringify(timeline)), async () => original)).rejects.toThrow();
  await expect(archive.verifySessionArchiveClosure(archive.parseSessionArchiveManifest({...manifest(),completeness:"partial"}), Buffer.from(JSON.stringify(timeline)), async () => original)).rejects.toThrow();
});

test("accepts migration evidence only as a bounded ready schema3 status", () => {
  const migration = { migrationId: id(9), sourceSha256: digest("schema1 original"), sourceByteLength: "67108864" };
  const ready = { state: "ready", sha256: digest("manifest"), byteLength: "8", errorCode: null, schemaVersion: 3, completeness: "complete", migration };
  expect(archive.parseSessionArchiveStatus(ready)).toEqual(ready);
  for (const invalid of [null, { ...migration, extra: true }, { ...migration, sourceByteLength: "67108865" }, { ...migration, sourceByteLength: "0" }, { ...migration, sourceSha256: "unknown" }, { ...migration, migrationId: "unknown" }]) {
    expect(() => archive.parseSessionArchiveStatus({ ...ready, migration: invalid })).toThrow();
  }
  expect(() => archive.parseSessionArchiveStatus({ state: "pending", sha256: null, byteLength: null, errorCode: null, schemaVersion: 3, completeness: null, migration })).toThrow();
  expect(() => archive.parseSessionArchiveStatus({ state: "ready", sha256: ready.sha256, byteLength: "8", errorCode: null, migration })).toThrow();
});
