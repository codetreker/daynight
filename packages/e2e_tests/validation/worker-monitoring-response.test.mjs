import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { observeMonitoringResponses, waitForRenderedMonitoring } from "../tests/monitoring-responses.ts";

const pathname = "/monitoring";

const until = async (condition, describe) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${describe}`);
    await delay(10);
  }
};

test("monitoring captures completed browser responses and diagnoses unavailable bodies", { timeout: 20_000 }, async () => {
  const modes = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url === "/") { response.end("fixture"); return; }
    if (request.url !== pathname) { response.writeHead(404).end(); return; }
    const mode = modes.shift();
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    if (mode === "abort") response.flushHeaders();
    else if (mode === "empty") response.end();
    else if (mode === "success") response.end(JSON.stringify({ state: "available", sequence: 42, receivedAt: "2026-01-01T00:00:01Z", data: { capturedAt: "2026-01-01T00:00:00Z" } }));
    else response.destroy(new Error("Unexpected monitoring request"));
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let browser, observer;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    observer = observeMonitoringResponses(page, pathname);
    const records = () => JSON.parse(observer.diagnostics()).requests;
    const fetchAborted = async () => {
      modes.push("abort");
      const failed = page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === pathname);
      await page.evaluate(async path => {
        const controller = new AbortController();
        const response = await fetch(path, { signal: controller.signal });
        controller.abort();
        try { await response.text(); } catch { /* Deliberate cancellation. */ }
      }, pathname);
      await failed;
    };
    const fetchComplete = async mode => {
      modes.push(mode);
      await page.evaluate(async path => { await (await fetch(path)).text(); }, pathname);
    };

    await fetchAborted();
    await until(() => records().length === 1 && records()[0].state === "failed", "aborted request");
    assert.deepEqual(observer.observations(), []);
    assert.equal(records()[0].status, 200);
    assert.match(records()[0].failure, /abort/i);
    assert.equal(records()[0].body, "unavailable");
    await assert.rejects(waitForRenderedMonitoring(page, observer, 300), error => {
      assert.match(error.message, /"state":"failed"/);
      assert.match(error.message, /"status":200/);
      assert.match(error.message, /"body":"unavailable"/);
      assert.match(error.message, /abort/i);
      return true;
    });

    await fetchComplete("success");
    await until(() => observer.observations().length === 1, "completed response body");
    const expected = { state: "available", sequence: 42, receivedAt: "2026-01-01T00:00:01Z", data: { capturedAt: "2026-01-01T00:00:00Z" } };
    assert.deepEqual(observer.observations(), [{ body: expected }]);
    assert.equal(records()[1].state, "finished");
    assert.equal(records()[1].status, 200);
    assert.equal(records()[1].body, "available");
    await page.evaluate(() => { document.body.innerHTML = '<div class="monitoring-time"><time datetime="2026-01-01T00:00:01Z"></time><time datetime="2026-01-01T00:00:00Z"></time></div>'; });
    assert.deepEqual(await waitForRenderedMonitoring(page, observer, 1_000), expected);

    observer.close();
    observer = observeMonitoringResponses(page, pathname);
    await fetchComplete("empty");
    await until(() => records()[0]?.body === "empty", "empty response diagnosis");
    assert.equal(records()[0].state, "finished");
    assert.equal(records()[0].status, 200);
    assert.equal(observer.observations().length, 0);
    await assert.rejects(waitForRenderedMonitoring(page, observer, 300), error => {
      assert.match(error.message, /"state":"finished"/);
      assert.match(error.message, /"status":200/);
      assert.match(error.message, /"body":"empty"/);
      return true;
    });
    assert.equal(JSON.parse(observer.diagnostics()).dropped, 0);

    const finalDiagnostics = observer.diagnostics();
    observer.close();
    await fetchComplete("success");
    assert.equal(observer.diagnostics(), finalDiagnostics, "closed observer must detach its listeners");
  } finally {
    observer?.close();
    try { await browser?.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});
