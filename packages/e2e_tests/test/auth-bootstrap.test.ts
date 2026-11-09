import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
