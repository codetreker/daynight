import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ImageCaptureReceipt } from "../../src/session/image-values.js";

const values = await import(new URL("../../dist/session/image-values.js", import.meta.url).href) as typeof import("../../src/session/image-values.js");
const configuration = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  origin: string; token: string; sessionId: string; receipts: ImageCaptureReceipt[]; result: string; phase: string;
};
const reads = [];
for (const receipt of configuration.receipts) {
  assert.equal(receipt.state, "committed");
  const resource = receipt.resource; assert(resource && resource.status === "available");
  const hash = createHash("sha256"); let offset = 0, chunks = 0;
  const endpoint = `/api/v1/test-sessions/${configuration.sessionId}/resources/${resource.resourceId}/content`;
  while (true) {
    // The chunk endpoint always reads immutable Go storage; it has no online-Controller fallback.
    const response = await fetch(`${configuration.origin}${endpoint}?offset=${offset}&limit=524288`, {
      headers: { authorization: `Bearer ${configuration.token}`, "Daynight-Session-Content-Revision": "2", "Cache-Control": "no-store" },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, "Immutable original read failed.");
    const chunk = values.parseImageReadChunk(await response.json());
    assert.equal(chunk.resourceId, resource.resourceId); assert.equal(chunk.sha256, resource.sha256);
    assert.equal(chunk.byteLength, resource.byteLength); assert.equal(chunk.offset, String(offset));
    const bytes = Buffer.from(chunk.data, "base64"); assert(bytes.length > 0);
    hash.update(bytes); offset += bytes.length; chunks++;
    assert(offset <= Number(resource.byteLength));
    if (chunk.eof) break;
  }
  assert.equal(String(offset), resource.byteLength);
  const sha256 = hash.digest("hex"); assert.equal(sha256, resource.sha256);
  reads.push({ captureId: receipt.captureId, attemptId: receipt.attemptId, imageId: receipt.occurrence.imageId,
    resourceId: resource.resourceId, byteLength: String(offset), sha256, chunks, endpoint });
}
await writeFile(configuration.result, `${JSON.stringify({ phase: configuration.phase, readerPid: process.pid, readAt: new Date().toISOString(), reads }, null, 2)}\n`, { mode: 0o600 });
