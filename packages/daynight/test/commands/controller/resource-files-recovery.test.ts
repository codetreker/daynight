import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const fault = vi.hoisted(() => ({ indexPath: "", markerPath: "", writes: 0 }));
vi.mock("../../../src/platform/durable-json.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/platform/durable-json.js")>();
  return {
    ...actual,
    writeDurableJson(file: string, value: unknown): void {
      if (file === fault.markerPath) {
        fault.writes++;
        actual.writeDurableJson(file, value);
        throw new Error("Controlled marker error after publication");
      }
      if (file === fault.indexPath) {
        fault.writes++;
        if (fault.writes === 1 && !fault.markerPath) {
          actual.writeDurableJson(file, value);
          throw new Error("Controlled index error after publication");
        }
        if (fault.writes === 2) throw new Error("Controlled index rollback error");
      }
      actual.writeDurableJson(file, value);
    },
  };
});

import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";

const roots: string[] = [];
afterEach(async () => { fault.indexPath = ""; fault.markerPath = ""; fault.writes = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("failed deletion restores the descriptor and only blob after index publication and rollback errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-resource-rollback-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), sessionId = randomUUID(), bytes = Buffer.from("original bytes");
  const resource = { resourceId: randomUUID(), status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
  const owner = openResourceFiles(journal, sessionId);
  owner.writeResource(resource, bytes);
  const lease = owner.acquireResource(resource.resourceId), blob = lease.path; lease.close();
  fault.indexPath = path.join(owner.root, "index.json");
  expect(() => owner.releaseResource(resource.resourceId)).toThrow();
  expect(fault.writes).toBe(2);
  expect(() => owner.writeResource({ ...resource, resourceId: randomUUID() }, bytes)).toThrow(/requires recovery/);
  fault.indexPath = "";
  const reopened = openResourceFiles(journal, sessionId);
  expect(reopened.resources.get(resource.resourceId)).toEqual({ resource, data: null });
  expect(await readFile(blob)).toEqual(bytes);
  const recovered = reopened.acquireResource(resource.resourceId);
  try { expect(recovered.read("0", bytes.length)).toEqual(bytes); } finally { recovered.close(); }
});

test("an unconfirmed undo marker quarantines the same owner until reopening", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-resource-marker-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), sessionId = randomUUID(), bytes = Buffer.from("original bytes");
  const resource = { resourceId: randomUUID(), status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
  const owner = openResourceFiles(journal, sessionId);
  owner.writeResource(resource, bytes);
  const lease = owner.acquireResource(resource.resourceId), blob = lease.path; lease.close();
  const source = path.join(root, "source"); await writeFile(source, bytes, { mode: 0o600 });
  fault.markerPath = path.join(owner.root, "resource-removal.json");
  fault.indexPath = path.join(owner.root, "index.json");
  expect(() => owner.releaseResource(resource.resourceId)).toThrow(/marker error/);
  expect(fault.writes).toBe(2);
  expect(() => owner.writeResource({ ...resource, resourceId: randomUUID() }, bytes)).toThrow(/requires recovery/);
  expect(() => owner.importResourceFile(resource, source)).toThrow(/requires recovery/);
  expect(() => owner.pinResource(resource.resourceId, "consumer")).toThrow(/requires recovery/);
  expect(() => owner.unpinResource(resource.resourceId, "consumer")).toThrow(/requires recovery/);
  expect(() => owner.releaseResource(resource.resourceId)).toThrow(/requires recovery/);
  fault.markerPath = ""; fault.indexPath = "";
  const reopened = openResourceFiles(journal, sessionId);
  expect(reopened.resources.get(resource.resourceId)).toEqual({ resource, data: null });
  expect(await readFile(blob)).toEqual(bytes);
  const recovered = reopened.acquireResource(resource.resourceId);
  try { expect(recovered.read("0", bytes.length)).toEqual(bytes); } finally { recovered.close(); }
});
