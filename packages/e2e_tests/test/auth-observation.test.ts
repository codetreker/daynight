import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Page, Request } from "@playwright/test";
import { BootstrapObservation, bootstrapEndpoint, finalizeBootstrapObservation, throwBootstrapFailures, writeBootstrapObservation } from "../src/auth-observation.ts";

const origin = "http://127.0.0.1:1234";
const sentinel = "CODE_SECRET_STATE_TOKEN_COOKIE_CSRF";
const fixture = () => {
  const page = new EventEmitter();
  const frame = { url: () => `${origin}/console/?code=${sentinel}` };
  const typed = Object.assign(page, { mainFrame: () => frame }) as unknown as Page;
  const request = (url: string, previous: Request | null = null) => ({
    resourceType: () => "document", frame: () => frame, redirectedFrom: () => previous,
    method: () => "GET", url: () => url, failure: () => ({ errorText: `net::ERR_ABORTED ${sentinel}` }),
  }) as unknown as Request;
  return { page, typed, frame, request };
};

test("document redirects retain identities, pending snapshot and safe fields", () => {
  const f = fixture();
  const observer = new BootstrapObservation(origin);
  observer.attach(f.typed);
  const first = f.request(`${origin}/console/?state=${sentinel}`);
  const second = f.request(`https://github.com/login/oauth/authorize?code=${sentinel}`, first);
  f.page.emit("request", first);
  f.page.emit("response", { request: () => first, status: () => 302 });
  f.page.emit("requestfinished", first);
  f.page.emit("request", second);
  f.page.emit("framenavigated", f.frame);
  observer.phase("authorize", "failure");
  const snapshot = observer.freeze();
  f.page.emit("requestfailed", second);
  assert.deepEqual(snapshot.unresolved, [2]);
  assert.deepEqual(snapshot.events.filter(e => e.type === "request").map(e => [e.requestId, e.redirectedFrom]), [[1, null], [2, 1]]);
  assert.equal(snapshot.events.some(e => e.type === "requestfailed"), false);
  assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
  assert.deepEqual(bootstrapEndpoint(`${origin}/${sentinel}?x=1`, origin), { origin: "other", path: "other" });
});

test("bounded observations report truncation and restrict failure codes", () => {
  const f = fixture();
  const observer = new BootstrapObservation(origin, 2);
  observer.attach(f.typed);
  const request = f.request(`${origin}/console/`);
  f.page.emit("request", request);
  f.page.emit("requestfailed", request);
  observer.phase("app");
  const snapshot = observer.freeze();
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.events[1]?.error, "other");
  assert.deepEqual(snapshot.unresolved, []);
});

test("finally freezes before close, writes on failure and retains each error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bootstrap-observation-"));
  try {
    const f = fixture();
    const observer = new BootstrapObservation(origin);
    observer.attach(f.typed);
    const pending = f.request(`${origin}/console/`);
    f.page.emit("request", pending);
    const original = new Error("business"), closeError = new Error("close"), writeError = new Error("write");
    const errors: unknown[] = [original];
    const filename = path.join(directory, "observation.json");
    await finalizeBootstrapObservation(observer, async () => { f.page.emit("requestfailed", pending); throw closeError; }, async snapshot => { await writeBootstrapObservation(filename, snapshot); throw writeError; }, errors);
    const saved = JSON.parse(await readFile(filename, "utf8"));
    assert.deepEqual(saved.unresolved, [1]);
    assert.equal(saved.events.some((event: { type: string }) => event.type === "requestfailed"), false);
    assert.throws(() => throwBootstrapFailures(errors), (error: unknown) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === closeError && error.errors[2] === writeError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fixed UniAuth navigation paths remain identifiable across redirects", () => {
  const f = fixture();
  const observer = new BootstrapObservation(origin);
  observer.attach(f.typed);
  let previous: Request | null = null;
  for (const pathname of ["/auth/authorize", "/auth/callback/github", "/console/auth/callback", "/console/"]) {
    const request = f.request(`${origin}${pathname}?state=${sentinel}`, previous);
    f.page.emit("request", request);
    f.page.emit("response", { request: () => request, status: () => 302 });
    f.page.emit("requestfinished", request);
    previous = request;
  }
  const events = observer.freeze().events.filter(e => e.type === "request");
  assert.deepEqual(events.map(e => (e.endpoint as { path: string }).path), ["/auth/authorize", "/auth/callback/github", "/console/auth/callback", "/console/"]);
  assert.deepEqual(events.map(e => e.redirectedFrom), [null, 1, 2, 3]);
  assert.doesNotMatch(JSON.stringify(events), /CODE_SECRET_STATE_TOKEN_COOKIE_CSRF/);
});
