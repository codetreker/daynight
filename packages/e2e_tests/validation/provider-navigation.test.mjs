import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { connect as connectTLS } from "node:tls";
import { chromium } from "@playwright/test";
import { startProvider } from "../src/provider.ts";

const temporary = path.resolve(import.meta.dirname, "../../../.tmp");
const fixture = async (testStall) => {
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "e2e-provider-navigation-"));
  const certificatePath = path.join(directory, "provider.pem");
  const keyPath = path.join(directory, "provider.key");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Local E2E OAuth provider", "-addext", "subjectAltName=DNS:github.com,DNS:api.github.com", "-keyout", keyPath, "-out", certificatePath], { stdio: "ignore", timeout: 10_000 });
    const provider = await startProvider({ port: 0, certificatePath, keyPath, testStall });
    return { provider, directory, close: async () => { try { await provider.close(); } finally { await rm(directory, { recursive: true, force: true }); } } };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
};

for (const stall of ["tls", "http"]) {
  test(`Chromium authorization navigation reports the ${stall} stall boundary`, { timeout: 15_000 }, async () => {
    const context = await fixture(stall);
    let browser;
    try {
      browser = await chromium.launch({ proxy: { server: `http://127.0.0.1:${context.provider.port}` } });
      const browserContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await browserContext.newPage();
      const { BootstrapObservation } = await import("../src/auth-observation.ts");
      const observation = new BootstrapObservation("http://127.0.0.1:12345");
      observation.attach(page);
      await page.setContent('<form action="https://github.com/login/oauth/authorize"><input name="state" value="STATE_SENTINEL"><input name="code" value="CODE_SENTINEL"><button>Authorize local identity</button></form>');
      observation.phase("authorize", "start");
      let failure;
      try { await page.getByRole("button", { name: "Authorize local identity" }).click({ timeout: 2000 }); }
      catch (error) { failure = error; }
      assert.ok(failure, "the stalled navigation must fail");
      assert.match(String(failure), /Timeout/);
      observation.phase("authorize", "failure");
      const browserEvidence = observation.freeze();
      assert.equal(browserEvidence.truncated, false);
      assert.ok(browserEvidence.events.some((event) => event.type === "request" && event.endpoint.origin === "https://github.com" && event.endpoint.path === "/login/oauth/authorize"));
      assert.ok(browserEvidence.unresolved.length > 0);
      const providerEvidence = context.provider.diagnostics();
      const events = providerEvidence.events;
      assert.ok(events.some((event) => event.type === "connect" && event.accepted));
      assert.equal(events.some((event) => event.type === "tls_ready"), stall === "http");
      assert.equal(events.some((event) => event.type === "http_request" && event.origin === "https://github.com" && event.path === "/login/oauth/authorize"), stall === "http");
      if (stall === "http") {
        const request = events.find((event) => event.type === "http_request");
        assert.ok(events.some((event) => event.type === "tls_ready" && event.connectionId === request.connectionId));
        assert.ok(events.some((event) => event.type === "connect" && event.accepted && event.connectionId === request.connectionId));
      }
      assert.ok(!events.some((event) => event.type === "http_finish"));
      const artifact = JSON.stringify({ browser: browserEvidence, provider: providerEvidence });
      assert.doesNotMatch(artifact, /STATE_SENTINEL|CODE_SENTINEL/);
      const file = path.join(context.directory, `${stall}.json`);
      await writeFile(file, artifact);
      assert.equal(await readFile(file, "utf8"), artifact);
      console.log(`${stall} evidence: ${artifact}`);
    } finally { try { await browser?.close(); } finally { await context.close(); } }
  });
}

// The TLS client writes its ClientHello to a local relay. Sending that first
// chunk together with CONNECT exercises nonempty head without fabricating TLS.
const relay = async (providerPort, withHead) => {
  const sockets = new Set();
  const server = createServer((client) => {
    const upstream = connect(providerPort, "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    client.once("close", () => sockets.delete(client));
    upstream.once("close", () => sockets.delete(upstream));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.once("data", (hello) => {
      client.pause();
      const header = Buffer.from("CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n");
      upstream.write(withHead ? Buffer.concat([header, hello]) : header);
      let reply = Buffer.alloc(0);
      const onData = (chunk) => {
        reply = Buffer.concat([reply, chunk]);
        const boundary = reply.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        upstream.off("data", onData);
        assert.match(reply.subarray(0, boundary).toString(), /^HTTP\/1\.1 200/);
        const remainder = reply.subarray(boundary + 4);
        if (remainder.length) client.write(remainder);
        if (!withHead) upstream.write(hello);
        client.pipe(upstream); upstream.pipe(client); client.resume();
      };
      upstream.on("data", onData);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: server.address().port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
};

for (const withHead of [false, true]) {
  test(`CONNECT head ${withHead ? "present" : "absent"} preserves TLS and same-connection HTTP`, { timeout: 10_000 }, async () => {
    const context = await fixture();
    const forward = await relay(context.provider.port, withHead);
    let tls;
    try {
      tls = connectTLS({ host: "127.0.0.1", port: forward.port, servername: "github.com", rejectUnauthorized: false });
      tls.setTimeout(5000, () => tls.destroy(new Error("TLS relay timed out")));
      await new Promise((resolve, reject) => { tls.once("secureConnect", resolve); tls.once("error", reject); });
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        tls.on("data", (chunk) => chunks.push(chunk));
        tls.once("error", reject);
        tls.once("end", () => resolve(Buffer.concat(chunks).toString()));
        tls.write("GET /login/oauth/authorize?code=CODE_SENTINEL HTTP/1.1\r\nHost: github.com\r\nConnection: keep-alive\r\n\r\nGET /login/oauth/authorize?state=STATE_SENTINEL HTTP/1.1\r\nHost: github.com\r\nConnection: close\r\n\r\n");
      });
      assert.equal((raw.match(/HTTP\/1\.1 400/g) ?? []).length, 2);
      const events = context.provider.diagnostics().events;
      const connected = events.find((event) => event.type === "connect");
      assert.equal(connected?.headPresent, withHead);
      assert.ok(connected?.accepted);
      assert.ok(events.some((event) => event.type === "tls_ready" && event.connectionId === connected.connectionId));
      const requests = events.filter((event) => event.type === "http_request");
      const finishes = events.filter((event) => event.type === "http_finish");
      assert.equal(requests.length, 2);
      assert.equal(finishes.length, 2);
      assert.ok([...requests, ...finishes].every((event) => event.connectionId === connected.connectionId));
      assert.doesNotMatch(JSON.stringify(events), /CODE_SENTINEL|STATE_SENTINEL/);
    } finally { tls?.destroy(); try { await forward.close(); } finally { await context.close(); } }
  });
}
