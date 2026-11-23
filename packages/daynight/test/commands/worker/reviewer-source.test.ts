import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createReviewerSource } from "../../../src/commands/worker/reviewer-source.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const candidate = { projectId, repositoryId: "123", repositoryUrl: "https://github.com/example/repo", number: "5" };
const signal = () => new AbortController().signal;
const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of close.splice(0)) await action(); });
const listen = async (handler: (url: URL, response: ServerResponse) => void) => {
  const server = createServer((request, response) => { response.setHeader("Daynight-User-ID", userId); handler(new URL(request.url!, "http://localhost"), response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  close.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}`;
};
const send = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
const failure = { error: { code: "internal_error", message: "fixture failure", requestId: "fixture" } };

describe("Worker reviewer source", () => {
  it("publishes only a complete page set and revokes immediately when a later page disables review", async () => {
    let mode = "success";
    const origin = await listen((url, res) => {
      if (!url.searchParams.has("cursor")) send(res, { reviewEnabled: true, pullRequests: [candidate], nextCursor: "next" });
      else if (mode === "failure") send(res, failure, 500);
      else if (mode === "disabled") send(res, { reviewEnabled: false, pullRequests: [], nextCursor: null });
      else send(res, { reviewEnabled: true, pullRequests: [], nextCursor: null });
    });
    const source = createReviewerSource({ serverOrigin: origin, serverToken: "fixture-token", userId, workerId });
    await source.poll(signal()); expect(source.source.snapshot()).toMatchObject({ kind: "enabled", pullRequests: [{ ...candidate, number: 5 }] });
    mode = "failure"; await expect(source.poll(signal())).rejects.toThrow(); expect(source.source.snapshot().kind).toBe("unavailable");
    mode = "disabled"; await source.poll(signal()); expect(source.source.snapshot()).toEqual({ kind: "disabled" });
  });
  it("caches three confirmed layers on transient failure and invalidates a captured tuple when a project disappears", async () => {
    let mode = "success";
    const origin = await listen((url, res) => {
      if (url.pathname.endsWith("review-pull-requests")) { send(res, { reviewEnabled: true, pullRequests: mode === "removed" ? [] : [candidate], nextCursor: null }); return; }
      if (mode === "failure") { send(res, failure, 500); return; }
      const scope = url.pathname.includes("/projects/") ? "project" : url.pathname.includes("/workers/") ? "worker" : "user";
      send(res, { scope, scopeId: scope === "user" ? userId : scope === "worker" ? workerId : projectId, revision: "1", text: scope, updatedAt: "2026-11-20T00:00:00Z" });
    });
    const source = createReviewerSource({ serverOrigin: origin, serverToken: "fixture-token", userId, workerId });
    await source.poll(signal()); const first = await source.source.capturePrompt(projectId, signal());
    expect(first.values.project.text).toBe("project"); expect(first.isCurrent()).toBe(true);
    mode = "failure"; const second = await source.source.capturePrompt(projectId, signal()); expect(second.values).toEqual(first.values);
    mode = "removed"; await source.poll(signal()); expect(first.isCurrent()).toBe(false); expect(second.isCurrent()).toBe(false);
  });
  it("distinguishes an old service from a confirmed missing Worker", async () => {
    let mode = "old";
    const origin = await listen((_url, res) => {
      if (mode === "old") res.removeHeader("Daynight-User-ID");
      if (mode === "mismatch") res.setHeader("Daynight-User-ID", "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
      send(res, { error: { code: "not_found", message: "not found", requestId: "fixture" } }, 404);
    });
    const source = createReviewerSource({ serverOrigin: origin, serverToken: "fixture-token", userId, workerId });
    await expect(source.poll(signal())).rejects.toThrow("does not support reviewer polling");
    expect(source.source.snapshot().kind).toBe("unavailable");
    mode = "mismatch"; await expect(source.poll(signal())).rejects.toMatchObject({ phase: "protocol", status: 404 });
    expect(source.source.snapshot().kind).toBe("unavailable");
    mode = "missing"; await expect(source.poll(signal())).rejects.toThrow();
    expect(source.source.snapshot().kind).toBe("disabled");
  });
  it("retains three complete 32 KiB resources", async () => {
    const text = "x".repeat(32768);
    const origin = await listen((url, res) => {
      if (url.pathname.endsWith("review-pull-requests")) { send(res, { reviewEnabled: true, pullRequests: [candidate], nextCursor: null }); return; }
      const scope = url.pathname.includes("/projects/") ? "project" : url.pathname.includes("/workers/") ? "worker" : "user";
      send(res, { scope, scopeId: scope === "user" ? userId : scope === "worker" ? workerId : projectId, revision: "1", text, updatedAt: "2026-11-20T00:00:00Z" });
    });
    const source = createReviewerSource({ serverOrigin: origin, serverToken: "fixture-token", userId, workerId });
    await source.poll(signal()); const capture = await source.source.capturePrompt(projectId, signal());
    expect([capture.values.user.text, capture.values.project.text, capture.values.worker.text]).toEqual([text, text, text]);
  });
  it("discards a late Project prompt read after its candidate is removed", async () => {
    let removed = false; let held: ServerResponse | undefined; let notify!: () => void;
    const started = new Promise<void>(resolve => { notify = resolve; });
    const origin = await listen((url, res) => {
      if (url.pathname.endsWith("review-pull-requests")) { send(res, { reviewEnabled: true, pullRequests: removed ? [] : [candidate], nextCursor: null }); return; }
      const scope = url.pathname.includes("/projects/") ? "project" : url.pathname.includes("/workers/") ? "worker" : "user";
      if (scope === "project") { held = res; notify(); return; }
      send(res, { scope, scopeId: scope === "user" ? userId : workerId, revision: "0", text: "", updatedAt: null });
    });
    const source = createReviewerSource({ serverOrigin: origin, serverToken: "fixture-token", userId, workerId });
    await source.poll(signal()); const capture = source.source.capturePrompt(projectId, signal());
    await started; removed = true; await source.poll(signal());
    send(held!, { scope: "project", scopeId: projectId, revision: "1", text: "old", updatedAt: "2026-11-20T00:00:00Z" });
    await expect(capture).rejects.toThrow();
  });

});
