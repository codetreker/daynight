import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { createApiClient, createOperation, DEFAULT_OPERATION_LIMITS, stringifyApiJson } from "../../src/api/index.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

const mib = 1_048_576;
const project = (id: string) => ({ id, name: "Project 中文", repoUrl: "https://example.test/owner/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: "2026-10-20T01:02:03Z", updatedAt: "2026-10-20T01:02:03Z" });
const projects = ["aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222", "cccccccc-3333-4333-8333-333333333333"].map(project);
const padding = new Uint8Array(64 * 1024).fill(0x20);

const page = (value: unknown, size: number, emitted: number[]) => {
  const json = Buffer.from(stringifyApiJson(value));
  let remaining = size - json.byteLength, first = true;
  if (remaining < 0) throw new Error("Fixture page exceeds its requested size.");
  const index = emitted.length; emitted.push(0);
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (first) { first = false; emitted[index]! += json.byteLength; controller.enqueue(json); return; }
      if (remaining === 0) { controller.close(); return; }
      const length = Math.min(remaining, padding.byteLength); remaining -= length; emitted[index]! += length;
      controller.enqueue(padding.subarray(0, length));
    },
  }), { headers: { "Content-Type": "application/json" } });
};

it.each([false, true])("enforces the real 128 MiB single-response boundary (one byte over: %s)", async over => {
  expect(DEFAULT_OPERATION_LIMITS.responseBytes).toBe(128 * mib);
  const emitted: number[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => page({ items: [projects[0]], nextCursor: null }, 128 * mib + Number(over), emitted));
  const operation = createOperation();
  try {
    const api = createApiClient({ serverUrl: "http://localhost", operation, fetch });
    if (over) await expect(api.listProjects()).rejects.toMatchObject({ cause: { kind: "response_limit" } });
    else await expect(api.listProjects()).resolves.toEqual([projects[0]]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(emitted).toEqual([128 * mib + Number(over)]);
  } finally { operation.dispose(); }
}, 120_000);

it.each([false, true])("counts real gzip HTTP responses at the 128 MiB decoded boundary (one byte over: %s)", async over => {
  const generated: number[] = [];
  let wireBytes = 0;
  const pending: Promise<unknown>[] = [];
  const server = createServer((_request, response) => {
    const json = Buffer.from(stringifyApiJson({ items: [projects[0]], nextCursor: null }));
    const size = 128 * mib + Number(over);
    generated.push(0);
    function* chunks() {
      generated[0]! += json.byteLength;
      yield json;
      for (let remaining = size - json.byteLength; remaining > 0;) {
        const length = Math.min(remaining, padding.byteLength);
        remaining -= length; generated[0]! += length;
        yield padding.subarray(0, length);
      }
    }
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { wireBytes += chunk.byteLength; callback(null, chunk); } });
    response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    pending.push(pipeline(Readable.from(chunks()), createGzip(), counter, response).catch(error => error));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address.");
  const operation = createOperation();
  try {
    const api = createApiClient({ serverUrl: `http://127.0.0.1:${address.port}`, operation });
    if (over) await expect(api.listProjects()).rejects.toMatchObject({ cause: { kind: "response_limit" } });
    else await expect(api.listProjects()).resolves.toEqual([projects[0]]);
    expect(await Promise.all(pending)).toEqual([undefined]);
    expect(generated).toEqual([128 * mib + Number(over)]);
    expect(wireBytes).toBeLessThan(128 * mib);
  } finally {
    operation.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 120_000);

it.each([false, true])("counts real gzip pages at the 256 MiB decoded boundary with authenticated ordered requests (one byte over: %s)", async over => {
  const generated: number[] = [];
  const requests: { method: string | undefined; url: string | undefined; authorization: string | undefined }[] = [];
  let wireBytes = 0;
  const pending: Promise<unknown>[] = [];
  const server = createServer((request, response) => {
    const index = requests.length;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (index >= 3) { response.writeHead(500).end(); return; }
    const json = Buffer.from(stringifyApiJson({ items: [projects[index]], nextCursor: index < 2 ? `cursor-${index + 1}` : null }));
    const size = (index < 2 ? 96 : 64) * mib + (index === 2 ? Number(over) : 0);
    generated.push(0);
    function* chunks() {
      generated[index]! += json.byteLength;
      yield json;
      for (let remaining = size - json.byteLength; remaining > 0;) {
        const length = Math.min(remaining, padding.byteLength);
        remaining -= length; generated[index]! += length;
        yield padding.subarray(0, length);
      }
    }
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { wireBytes += chunk.byteLength; callback(null, chunk); } });
    response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    pending.push(pipeline(Readable.from(chunks()), createGzip(), counter, response).catch(error => error));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address.");
  const operation = createOperation();
  try {
    const api = createApiClient({ serverUrl: `http://127.0.0.1:${address.port}`, serverToken: "fixture-token", operation });
    if (over) await expect(api.listProjects()).rejects.toMatchObject({ cause: { kind: "total_limit" } });
    else await expect(api.listProjects()).resolves.toEqual(projects);
    expect(await Promise.all(pending)).toEqual([undefined, undefined, undefined]);
    expect(generated).toEqual([96 * mib, 96 * mib, 64 * mib + Number(over)]);
    expect(requests).toEqual([null, "cursor-1", "cursor-2"].map(cursor => ({ method: "GET", url: `/api/v1/projects?limit=100${cursor === null ? "" : `&cursor=${cursor}`}`, authorization: "Bearer fixture-token" })));
    expect(wireBytes).toBeLessThan(256 * mib);
  } finally {
    operation.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 120_000);

it.each([false, true])("enforces the real 256 MiB cumulative page boundary (one byte over: %s)", async over => {
  expect(DEFAULT_OPERATION_LIMITS.totalBytes).toBe(256 * mib);
  const emitted: number[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url) => {
    const index = emitted.length;
    if (index >= 3) throw new Error("Unexpected pagination replay.");
    return page({ items: [projects[index]], nextCursor: index < 2 ? `cursor-${index + 1}` : null }, (index < 2 ? 96 : 64) * mib + (index === 2 ? Number(over) : 0), emitted);
  });
  const operation = createOperation();
  try {
    const api = createApiClient({ serverUrl: "http://localhost", operation, fetch });
    if (over) await expect(api.listProjects()).rejects.toMatchObject({ cause: { kind: "total_limit" } });
    else await expect(api.listProjects()).resolves.toEqual(projects);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("cursor"))).toEqual([null, "cursor-1", "cursor-2"]);
    expect(emitted).toEqual([96 * mib, 96 * mib, 64 * mib + Number(over)]);
  } finally { operation.dispose(); }
}, 120_000);
