import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as requestHTTP } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { connect as connectTLS } from "node:tls";
import { providerClientId, providerClientSecret, startProvider, type Provider } from "../src/provider.ts";

type Response = { status: number; headers: Map<string, string>; body: string };

const request = async (provider: Provider, certificate: Buffer, hostname: string, pathname: string, options: { method?: string; body?: string; token?: string } = {}): Promise<Response> => {
  const method = options.method === undefined ? "GET" : options.method;
  const payload = options.body === undefined ? "" : options.body;
  return new Promise<Response>((resolve, reject) => {
    const tunnel = requestHTTP({ hostname: "127.0.0.1", port: provider.port, method: "CONNECT", path: `${hostname}:443` });
    tunnel.once("error", reject);
    tunnel.setTimeout(5000, () => tunnel.destroy(new Error("Provider tunnel timed out")));
    tunnel.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        resolve({ status: response.statusCode!, headers: new Map(), body: "" });
        return;
      }
      if (head.length !== 0) socket.unshift(head);
      const tls = connectTLS({ socket, servername: hostname, ca: certificate });
      tls.once("error", reject);
      tls.setTimeout(5000, () => tls.destroy(new Error("Provider TLS request timed out")));
      const chunks: Buffer[] = [];
      tls.on("data", (chunk: Buffer) => chunks.push(chunk));
      tls.once("secureConnect", () => {
        const headers = [
          `${method} ${pathname} HTTP/1.1`, `Host: ${hostname}`, "Connection: close",
          "Content-Type: application/x-www-form-urlencoded", `Content-Length: ${Buffer.byteLength(payload)}`,
        ];
        if (options.token !== undefined) headers.push(`Authorization: Bearer ${options.token}`);
        tls.write(`${headers.join("\r\n")}\r\n\r\n${payload}`);
      });
      tls.once("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const boundary = raw.indexOf("\r\n\r\n");
        if (boundary === -1) {
          reject(new Error("Provider response has no header boundary"));
          return;
        }
        const lines = raw.slice(0, boundary).split("\r\n");
        const status = Number(lines[0]!.split(" ")[1]);
        const headers = new Map(lines.slice(1).map((line) => {
          const index = line.indexOf(":");
          return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
        }));
        resolve({ status, headers, body: raw.slice(boundary + 4) });
      });
    });
    tunnel.end();
  });
};

const fixture = async (): Promise<{ provider: Provider; certificate: Buffer; cleanup: () => Promise<void> }> => {
  const temporary = path.resolve(import.meta.dirname, "../../../..", ".tmp");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "e2e-provider-test-"));
  const certificatePath = path.join(directory, "provider.pem");
  const keyPath = path.join(directory, "provider.key");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Local E2E OAuth provider", "-addext", "subjectAltName=DNS:github.com,DNS:api.github.com", "-keyout", keyPath, "-out", certificatePath], { stdio: "ignore" });
    const provider = await startProvider({ port: 0, certificatePath, keyPath });
    const certificate = await readFile(certificatePath);
    return { provider, certificate, cleanup: async () => {
      try { await provider.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};

const authorize = async (provider: Provider, certificate: Buffer): Promise<{ code: string; verifier: string; callback: string }> => {
  const verifier = randomBytes(32).toString("base64url");
  const callback = "http://127.0.0.1:12345/auth/callback";
  const state = randomBytes(16).toString("base64url");
  const query = new URLSearchParams({ client_id: providerClientId, redirect_uri: callback, state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  const page = await request(provider, certificate, "github.com", `/login/oauth/authorize?${query}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Authorize local identity/);
  const requestId = page.body.match(/name="request" value="([^"]+)"/)![1]!;
  const authorization = await request(provider, certificate, "github.com", "/login/oauth/authorize", { method: "POST", body: new URLSearchParams({ request: requestId }).toString() });
  assert.equal(authorization.status, 302);
  const location = new URL(authorization.headers.get("location")!);
  assert.equal(location.origin + location.pathname, callback);
  assert.equal(location.searchParams.get("state"), state);
  return { code: location.searchParams.get("code")!, verifier, callback };
};

const exchange = async (provider: Provider, certificate: Buffer, authorization: { code: string; verifier: string; callback: string }): Promise<Response> =>
  request(provider, certificate, "github.com", "/login/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code: authorization.code, code_verifier: authorization.verifier, redirect_uri: authorization.callback, client_id: providerClientId, client_secret: providerClientSecret }).toString(),
  });

test("local CONNECT and TLS complete OAuth, preserve state and return a verified identity", async () => {
  const context = await fixture();
  try {
    const authorization = await authorize(context.provider, context.certificate);
    const token = await exchange(context.provider, context.certificate, authorization);
    assert.equal(token.status, 200);
    const credentials = JSON.parse(token.body) as { access_token: string; token_type: string };
    assert.equal(credentials.token_type, "Bearer");
    const profile = await request(context.provider, context.certificate, "api.github.com", "/user", { token: credentials.access_token });
    assert.equal(profile.status, 200);
    assert.equal(JSON.parse(profile.body).id, 1);
    const emails = await request(context.provider, context.certificate, "api.github.com", "/user/emails?per_page=100&page=1", { token: credentials.access_token });
    assert.equal(emails.status, 200);
    assert.deepEqual(JSON.parse(emails.body), [{ email: "admin@example.test", primary: true, verified: true }]);
    assert.equal((await exchange(context.provider, context.certificate, authorization)).status, 400);
  } finally { await context.cleanup(); }
});

test("a wrong PKCE verifier cannot exchange an authorization code", async () => {
  const context = await fixture();
  try {
    const authorization = await authorize(context.provider, context.certificate);
    const denied = await exchange(context.provider, context.certificate, { ...authorization, verifier: "wrong-verifier" });
    assert.equal(denied.status, 400);
    assert.equal(JSON.parse(denied.body).error, "invalid_grant");
  } finally { await context.cleanup(); }
});

test("CONNECT rejects targets outside the local provider and cleanup closes upgraded tunnels", async () => {
  const context = await fixture();
  try {
    const denied = await request(context.provider, context.certificate, "example.com", "/");
    assert.equal(denied.status, 403);
    const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
      const tunnel = requestHTTP({ hostname: "127.0.0.1", port: context.provider.port, method: "CONNECT", path: "github.com:443" });
      tunnel.once("error", reject);
      tunnel.once("connect", (response, socket) => {
        assert.equal(response.statusCode, 200);
        resolve(socket as import("node:net").Socket);
      });
      tunnel.end();
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.resume();
    await context.provider.close();
    await closed;
  } finally { await context.cleanup(); }
});
