import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Request, type Response } from "@playwright/test";
import { registerAuth, type AuthBootstrapObservation } from "../src/auth-bootstrap.ts";

const environment = { authURL: "http://127.0.0.1:12345", proxyURL: "http://127.0.0.1:12346", baseURL: "http://127.0.0.1:12347" };

for (const scenario of [
  { phase: "console-load", recordingFails: false },
  { phase: "provider-submit", recordingFails: false },
  { phase: "provider-submit", recordingFails: true },
] as const) {
  const failingPhase = scenario.phase;
  test(`bootstrap records ${failingPhase} failure and cleans up${scenario.recordingFails ? " when recording fails" : ""}`, async (t) => {
    const secret = "bootstrap-private-query-body-header";
    const failure = new Error(`Navigation failed: https://github.com/login/oauth/authorize?state=${secret}`);
    failure.name = "TimeoutError";
    const observations: AuthBootstrapObservation[] = [];
    const observationFailure = new Error("Diagnostic recording failed");
    let recordingFailed = false;
    const page = new EventEmitter();
    const existing = () => {};
    page.on("request", existing);
    const launchOptions: unknown[] = [];
    const contextOptions: unknown[] = [];
    const timeouts: number[] = [];
    let closed = 0;
    const network = (): void => {
      const request = {
        url: () => `https://github.com/login/oauth/authorize?state=${secret}`,
        method: () => "GET",
        isNavigationRequest: () => true,
        failure: () => ({ errorText: `untrusted-${secret}` }),
        postData: () => { throw new Error("Diagnostic read an OAuth body"); },
        headers: () => { throw new Error("Diagnostic read OAuth headers"); },
      } as unknown as Request;
      const response = { request: () => request, url: () => request.url(), status: () => 200 } as unknown as Response;
      page.emit("request", request);
      page.emit("response", response);
      page.emit("requestfinished", request);
      page.emit("requestfailed", request);
      page.emit("request", { ...request, url: () => `${environment.authURL}/auth/authorize?state=${secret}` });
    };
    const fakePage = Object.assign(page, {
      setDefaultTimeout: (value: number) => timeouts.push(value),
      goto: async () => { network(); if (failingPhase === "console-load") throw failure; },
      getByRole: (_role: string, options: { name: string }) => ({ click: async () => { if (options.name === "Authorize local identity") throw failure; } }),
    });
    const browser = {
      newContext: async (options: unknown) => {
        contextOptions.push(options);
        return { newPage: async () => fakePage };
      },
      close: async () => { closed++; },
    } as unknown as Browser;
    t.mock.method(chromium, "launch", async (options: unknown) => { launchOptions.push(options); return browser; });
    await assert.rejects(registerAuth(environment, (event) => {
      if (recordingFailed) throw observationFailure;
      observations.push(event);
      if (scenario.recordingFails && event.event === "phase" && event.state === "failed") {
        recordingFailed = true;
        throw observationFailure;
      }
    }), (error) => scenario.recordingFails
      ? error instanceof AggregateError && error.cause === failure && error.errors.length === 2 && error.errors[0] === failure && error.errors[1] === observationFailure
      : error === failure);
    assert.deepEqual(launchOptions, [{ proxy: { server: environment.proxyURL, bypass: "127.0.0.1,localhost" } }]);
    assert.deepEqual(contextOptions, [{ ignoreHTTPSErrors: true, locale: "en-US" }]);
    assert.deepEqual(timeouts, [30_000]);
    assert.equal(closed, 1);
    assert.deepEqual(page.listeners("request"), [existing]);
    for (const event of ["response", "requestfailed", "requestfinished", "framenavigated"]) assert.equal(page.listenerCount(event), 0);
    assert.ok(observations.some((event) => event.event === "phase" && event.phase === failingPhase && event.state === "failed" && event.error === "timeout"));
    const request = observations.find((event) => event.event === "request");
    const response = observations.find((event) => event.event === "response");
    assert.ok(request?.event === "request" && request.route === "github-authorize");
    assert.ok(observations.some((event) => event.event === "request" && event.route === "authorize" && event.navigation));
    assert.ok(response?.event === "response" && response.request === request.request && response.status === 200);
    assert.ok(observations.some((event) => event.event === "request-failed" && event.request === request.request && event.code === "unknown"));
    assert.equal(JSON.stringify(observations).includes(secret), false);
  });
}


test("a launch-completion recording failure still closes the newly created browser", async (t) => {
  const failure = new Error("Diagnostic recording failed");
  let closed = 0;
  const browser = { close: async () => { closed++; } } as unknown as Browser;
  t.mock.method(chromium, "launch", async () => browser);
  await assert.rejects(registerAuth(environment, (event) => {
    if (event.event === "phase" && event.state === "completed") throw failure;
  }), (error) => error === failure);
  assert.equal(closed, 1);
});

test("bootstrap begins the next action before peer continuations queued by navigation", async (t) => {
  const order: string[] = [];
  const failure = new Error("Stop after observing the next action");
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout: () => {},
    goto: () => {
      const completed = Promise.resolve();
      void completed.then(() => { void Promise.resolve().then(() => { order.push("peer"); }); });
      return completed;
    },
    getByRole: () => ({ click: () => { order.push("click"); throw failure; } }),
  });
  const browser = {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => {},
  } as unknown as Browser;
  t.mock.method(chromium, "launch", async () => browser);
  await assert.rejects(registerAuth(environment, () => {}), (error) => error === failure);
  assert.deepEqual(order, ["click", "peer"]);
});

for (const scenario of [
  { event: "request", primaryFails: false },
  { event: "response", primaryFails: false },
  { event: "request-finished", primaryFails: false },
  { event: "request-failed", primaryFails: false },
  { event: "navigation", primaryFails: false },
  { event: "request", primaryFails: true },
] as const) {
  test(`asynchronous ${scenario.event} diagnostic failure reaches bootstrap cleanup${scenario.primaryFails ? " with its primary failure" : ""}`, { timeout: 10_000 }, async (t) => {
    const temporary = path.resolve(import.meta.dirname, "../../..", ".tmp");
    await mkdir(temporary, { recursive: true });
    const sink = await mkdtemp(path.join(temporary, "bootstrap-diagnostic-test-"));
    const page = new EventEmitter();
    const existing = () => {};
    page.on("request", existing);
    const primaryFailure = new Error("Navigation timed out");
    primaryFailure.name = "TimeoutError";
    let diagnosticFailure: unknown;
    let sinkAttempts = 0;
    let actionSettled = false;
    let closed = 0;
    const request = {
      url: () => `${environment.authURL}/console/?state=private-query`,
      method: () => "GET",
      isNavigationRequest: () => true,
      failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
    } as unknown as Request;
    const frame = { url: () => request.url() };
    const fakePage = Object.assign(page, {
      mainFrame: () => frame,
      setDefaultTimeout: () => {},
      goto: () => new Promise<void>((resolve, reject) => setImmediate(() => {
        try {
          page.emit("request", request);
          page.emit("response", { request: () => request, url: () => request.url(), status: () => 200 });
          page.emit("requestfinished", request);
          page.emit("requestfailed", request);
          page.emit("framenavigated", frame);
        } finally {
          actionSettled = true;
          if (scenario.primaryFails) reject(primaryFailure);
          else resolve();
        }
      })),
      getByRole: () => { throw new Error("Bootstrap continued after a diagnostic failure"); },
    });
    t.mock.method(chromium, "launch", async () => ({
      newContext: async () => ({ newPage: async () => fakePage }),
      close: async () => { assert.equal(actionSettled, true); closed++; },
    }) as unknown as Browser);
    try {
      await assert.rejects(registerAuth(environment, (event) => {
        if (event.event !== scenario.event) return;
        sinkAttempts++;
        try { appendFileSync(sink, `${JSON.stringify(event)}\n`); }
        catch (error) { diagnosticFailure = error; throw error; }
      }), (error) => {
        if (!scenario.primaryFails) return error === diagnosticFailure;
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primaryFailure);
        assert.deepEqual(error.errors, [primaryFailure, diagnosticFailure]);
        return true;
      });
      assert.ok(diagnosticFailure instanceof Error && "code" in diagnosticFailure && diagnosticFailure.code === "EISDIR");
      assert.equal(sinkAttempts, 1);
      assert.equal(closed, 1);
      assert.deepEqual(page.listeners("request"), [existing]);
      for (const event of ["response", "requestfailed", "requestfinished", "framenavigated"]) assert.equal(page.listenerCount(event), 0);
      page.emit("request", request);
      assert.equal(sinkAttempts, 1);
    } finally { await rm(sink, { recursive: true, force: true }); }
  });
}
