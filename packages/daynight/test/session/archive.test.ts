import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSessionArchive, parseSessionArchiveStatus, verifySessionArchiveResources } from "../../src/session/archive.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixture = () => ({ schemaVersion: 1, sessionId: id(1), claimId: id(2), executionGeneration: "1", controllerId: id(3), controllerInstanceId: id(4), provider: "codex", nativeSessionId: "native", entries: [{ entryId: id(5), entrySeq: "1", revision: "1", kind: "assistant_message", content: [{ type: "text", text: "Final answer" }] }], resources: [] });
describe("immutable session archive protocol", () => {
  it("accepts both original task and test identities without a live connection", () => {
    const task = fixture(); expect(parseSessionArchive(task)).toEqual(task);
    const { claimId: _, ...test } = task;
    expect(parseSessionArchive({ ...test, testExecutionId: id(7) }).testExecutionId).toBe(id(7));
    expect(() => parseSessionArchive({ ...task, testExecutionId: id(7) })).toThrow();
  });
  it("rejects duplicate entries, reordered positions and unknown format fields", () => {
    const archive = fixture(); const entry = archive.entries[0]!;
    expect(() => parseSessionArchive({ ...archive, entries: [entry, entry] })).toThrow();
    expect(() => parseSessionArchive({ ...archive, entries: [{ ...entry, entrySeq: "2" }, { ...entry, entryId: id(6) }] })).toThrow();
    expect(() => parseSessionArchive({ ...archive, writable: true })).toThrow();
    expect(() => parseSessionArchive({ ...archive, schemaVersion: 2 })).toThrow();
  });
  it("requires every displayed resource and verifies available binary bytes", async () => {
    const archive = fixture(); const bytes = Buffer.from("artifact");
    const descriptor = { resourceId: id(8), status: "available", name: "result.txt", mediaType: "text/plain", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
    const entries = [{ ...archive.entries[0], content: [{ type: "resource", resourceId: id(8), label: "Result" }] }];
    expect(() => parseSessionArchive({ ...archive, entries })).toThrow();
    const parsed = parseSessionArchive({ ...archive, entries, resources: [{ resource: descriptor, data: bytes.toString("base64") }] });
    await expect(verifySessionArchiveResources(parsed)).resolves.toBeUndefined();
    const corrupted = parseSessionArchive({ ...parsed, resources: [{ resource: { ...descriptor, sha256: "0".repeat(64) }, data: bytes.toString("base64") }] });
    await expect(verifySessionArchiveResources(corrupted)).rejects.toThrow();
    expect(() => parseSessionArchive({ ...parsed, resources: [{ resource: { ...descriptor, byteLength: "1" }, data: bytes.toString("base64") }] })).toThrow();
    expect(() => parseSessionArchive({ ...parsed, resources: [{ resource: { ...descriptor, status: "pending" }, data: null }] })).toThrow();
  });
  it("rejects noncanonical base64 without hiding unavailable resource records", () => {
    const descriptor = { resourceId: id(8), status: "available", name: "result", mediaType: null, byteLength: "1", sha256: "0".repeat(64), error: null };
    expect(() => parseSessionArchive({ ...fixture(), resources: [{ resource: descriptor, data: "Zh==" }] })).toThrow();
    expect(parseSessionArchive({ ...fixture(), resources: [{ resource: { ...descriptor, status: "unavailable", error: "Not saved" }, data: null }] }).resources).toHaveLength(1);
  });
  it("separates upload state from verified immutable completion", () => {
    expect(parseSessionArchiveStatus({ state: "pending", sha256: null, byteLength: null, errorCode: null }).state).toBe("pending");
    expect(() => parseSessionArchiveStatus({ state: "ready", sha256: null, byteLength: null, errorCode: null })).toThrow();
    expect(() => parseSessionArchiveStatus({ state: "ready", sha256: "0".repeat(64), byteLength: "67108865", errorCode: null })).toThrow();
    expect(() => parseSessionArchiveStatus({ state: "pending", sha256: null, byteLength: null, errorCode: "upload_failed" })).toThrow();
    expect(parseSessionArchiveStatus({ state: "failed", sha256: null, byteLength: null, errorCode: "upload_failed" }).state).toBe("failed");
  });
});
