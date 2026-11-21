import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, connect, type Server, type Socket } from "node:net";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { authenticate, type RunCommand } from "../../scripts/external-image-harness/auth.js";
import { requestService, startForward } from "../../scripts/external-image-harness/service.js";

const runFile = promisify(execFile), roots: string[] = [], servers: Server[] = [], sockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy(); sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const listen = async (server: Server): Promise<number> => {
  servers.push(server); server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port."); return address.port;
};
const certificate = async (directory: string, name: "daynight" | "provider" | "untrusted") => {
  // These public test keys belong only to loopback fixtures, never deployments.
  const source = path.resolve(import.meta.dirname, "../fixtures/external-image-auth");
  const [key, cert] = await Promise.all([readFile(path.join(source, `${name}-key.pem`)), readFile(path.join(source, `${name}-ca.pem`))]);
  const parsed = new X509Certificate(cert), hostname = name === "provider" ? "github.com" : "app.daynight.localhost";
  expect(parsed.ca).toBe(true); expect(parsed.subject).toBe(parsed.issuer); expect(parsed.verify(parsed.publicKey)).toBe(true);
  expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true);
  expect(Date.parse(parsed.validFrom)).toBeLessThan(Date.now()); expect(Date.parse(parsed.validTo)).toBeGreaterThan(Date.now());
  expect(parsed.checkHost(hostname)).toBe(hostname);
  if (hostname === "app.daynight.localhost") expect(parsed.checkHost("preview.daynight.localhost")).toBe("preview.daynight.localhost");
  await Promise.all([writeFile(path.join(directory, `${name}-key.pem`), key, { mode: 0o600 }), writeFile(path.join(directory, `${name}-ca.pem`), cert, { mode: 0o600 })]);
  return { key, cert };
};
const run: RunCommand = async (command, args, options) => {
  const result = await runFile(command, [...args], { cwd: options.cwd, signal: options.signal, timeout: options.timeoutMs });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
};

const fixture = async (wrongAppCertificate = false) => {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/external-image-auth-tests"); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "auth-")); roots.push(directory);
  const appCert = await certificate(directory, "daynight"), providerCert = await certificate(directory, "provider");
  const actualCert = wrongAppCertificate ? await certificate(directory, "untrusted") : appCert;
  if (wrongAppCertificate) expect(new X509Certificate(actualCert.cert).verify(new X509Certificate(appCert.cert).publicKey)).toBe(false);
  let authOrigin = "", appOrigin = "", previewOrigin = "", loginRequests = 0, tokenRequests = 0;
  const sso: string[] = [];
  const credentials: { path: string; method: string; origin: string | undefined; body: unknown }[] = [];
  const auth = createHttpServer((request, response) => {
    const route = request.url?.split("?")[0];
    const json = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (route === "/console/api/login") json(200, { authorization_url: "https://github.com/login/oauth/authorize?fixture=console" });
    else if (route === "/console/api/session") json(200, { csrf_token: "synthetic-csrf" });
    else if (route === "/console/api/apps") json(201, { app: { id: "synthetic-app" }, secret: "synthetic-secret" });
    else if (route === "/console/callback") response.end("ok");
    else if (route === "/callback") { response.writeHead(302, { location: `${appOrigin}/auth/callback` }); response.end(); }
    else { response.writeHead(404); response.end(); }
  });
  authOrigin = `http://127.0.0.1:${await listen(auth)}`;
  const provider = createHttpsServer(providerCert, (request, response) => {
    if (request.method === "GET") { response.end('<input name="request" value="fixture_request">'); return; }
    response.writeHead(302, { location: loginRequests ? `${authOrigin}/callback` : `${authOrigin}/console/callback` }); response.end();
  });
  const providerPort = await listen(provider);
  const proxy = createTcpServer(socket => {
    let pending = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]); const end = pending.indexOf("\r\n\r\n"); if (end < 0) return;
      socket.off("data", receive);
      if (!pending.toString("ascii", 0, end).startsWith("CONNECT github.com:443 ")) { socket.destroy(); return; }
      const target = connect(providerPort, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (pending.length > end + 4) target.write(pending.subarray(end + 4)); socket.pipe(target).pipe(socket); });
      sockets.add(target); target.once("close", () => sockets.delete(target)); target.on("error", () => socket.destroy()); socket.on("error", () => target.destroy());
    };
    socket.on("data", receive);
  });
  const proxyPort = await listen(proxy);
  const app = createHttpsServer(actualCert, (request, response) => {
    const route = request.url?.split("?")[0];
    if (route === "/api/v1/auth/login") {
      loginRequests++;
      if (!request.headers.cookie?.includes("__Host-daynight_login_scope=fixture")) response.writeHead(303, { location: request.url!, "set-cookie": "__Host-daynight_login_scope=fixture; Secure; Path=/" });
      else response.writeHead(302, { location: "https://github.com/login/oauth/authorize?fixture=app" });
      response.end();
    }
    else if (route === "/auth/callback") {
      if (!request.headers.cookie?.includes("__Host-daynight_login_scope=fixture")) { response.writeHead(403); response.end(); return; }
      response.writeHead(303, { location: `${previewOrigin}/auth/sso/start?login=fixture`, "set-cookie": "__Host-daynight_session=fixture; Secure; Path=/" }); response.end();
    } else if (route === "/auth/sso/start" && request.headers.host?.startsWith("preview.daynight.localhost:")) {
      sso.push("start"); response.writeHead(303, { location: `${appOrigin}/api/v1/auth/preview/authorize?login=fixture&state=state`, "set-cookie": "__Host-daynight_login_state=state; Secure; Path=/" }); response.end();
    } else if (route === "/api/v1/auth/preview/authorize") {
      if (!request.headers.cookie?.includes("__Host-daynight_session=fixture")) { response.writeHead(403); response.end(); return; }
      sso.push("authorize"); response.writeHead(303, { location: `${previewOrigin}/auth/sso/callback?code=fixture&state=state` }); response.end();
    } else if (route === "/auth/sso/callback" && request.headers.host?.startsWith("preview.daynight.localhost:")) {
      if (!request.headers.cookie?.includes("__Host-daynight_login_state=state")) { response.writeHead(403); response.end(); return; }
      sso.push("callback"); response.writeHead(303, { location: `${previewOrigin}/auth/sso/complete?login=fixture`, "set-cookie": "__Secure-daynight_preview_session=fixture; Domain=preview.daynight.localhost; Secure; Path=/" }); response.end();
    } else if (route === "/auth/sso/complete" && request.headers.host?.startsWith("preview.daynight.localhost:")) {
      if (!request.headers.cookie?.includes("__Secure-daynight_preview_session=fixture")) { response.writeHead(403); response.end(); return; }
      sso.push("complete"); response.writeHead(303, { location: `${appOrigin}/auth/complete?returnPath=%2Fprojects` }); response.end();
    } else if (route === "/auth/complete") response.end("ok");
    else if (route === "/service") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ authorization: request.headers.authorization })); }
    else if (route === "/api/v1/me/tokens") { response.writeHead(400); response.end(); }
    else if (route === "/api/v2/me/tokens" || route === "/api/v1/me" || route === "/api/v1/me/credential-scope-catalog") {
      tokenRequests++;
      if (!request.headers.cookie?.includes("__Host-daynight_session=fixture")) { response.writeHead(403); response.end(); return; }
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => {
        credentials.push({ path: route, method: request.method!, origin: request.headers.origin, body: body ? JSON.parse(body) : null });
        response.writeHead(route.endsWith("tokens") ? 201 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(route.endsWith("tokens") ? { token: "synthetic-token", id: "synthetic-token-id", scopePolicy: { scopes: ["session:read", "session:produce"], scopeVersion: "1" } }
          : route.endsWith("credential-scope-catalog") ? { pat: { catalogRevision: "synthetic-catalog", groups: [{ id: "session", scopeIds: ["session:read", "session:produce", "session:control"] }], defaultScopes: ["session:read", "session:produce", "session:control"] } }
          : { id: "synthetic-user" }));
      });
    } else { response.writeHead(404); response.end(); }
  });
  const ws = new WebSocketServer({ server: app });
  ws.on("connection", socket => socket.on("message", data => socket.send(data)));
  appOrigin = `https://app.daynight.localhost:${await listen(app)}`;
  previewOrigin = appOrigin.replace("app.daynight.localhost", "preview.daynight.localhost");
  const environment = { baseURL: appOrigin, authURL: authOrigin, proxyURL: `http://127.0.0.1:${proxyPort}`, resourceIdentity: { network: "fixture", ingressNetwork: "fixture", applicationContainer: "fixture", postgresContainer: "fixture" }, startServer: async (credentials: { appId: string; appSecret: string }) => { expect(credentials).toEqual({ appId: "synthetic-app", appSecret: "synthetic-secret" }); }, close: async () => {} };
  return { directory, environment, sso, credentials, counts: () => ({ loginRequests, tokenRequests }) };
};

test("isolated OAuth follows both trusted TLS hosts and preserves secure cookies", async () => {
  const f = await fixture();
  expect(await authenticate({ environment: f.environment, directory: f.directory, artifacts: f.directory, repository: f.directory, run, signal: new AbortController().signal })).toEqual({ token: "synthetic-token", tokenId: "synthetic-token-id", userId: "synthetic-user" });
  expect(f.counts()).toEqual({ loginRequests: 2, tokenRequests: 3 });
  expect(f.credentials.map(({ path, method }) => ({ path, method }))).toEqual([
    { path: "/api/v1/me", method: "GET" },
    { path: "/api/v1/me/credential-scope-catalog", method: "GET" },
    { path: "/api/v2/me/tokens", method: "POST" },
  ]);
  expect(f.credentials[2]).toMatchObject({ origin: f.environment.baseURL, body: {
    name: "External image source regression", expiresAt: expect.any(String), expectedUserId: "synthetic-user", catalogRevision: "synthetic-catalog", scopes: ["session:produce", "session:read"],
  } });
  expect(f.sso).toEqual(["start", "authorize", "callback", "complete"]);
}, 30_000);

test("isolated OAuth rejects an untrusted Daynight TLS certificate before login", async () => {
  const f = await fixture(true);
  await expect(authenticate({ environment: f.environment, directory: f.directory, artifacts: f.directory, repository: f.directory, run, signal: new AbortController().signal })).rejects.toThrow("Isolated OAuth HTTP request failed");
  expect(f.counts()).toEqual({ loginRequests: 0, tokenRequests: 0 });
}, 30_000);

test("the namespace forward carries HTTP and WebSocket over verified local TLS", async () => {
  const f = await fixture(), ca = await readFile(path.join(f.directory, "daynight-ca.pem"));
  expect(await requestService(f.environment.baseURL, ca, "synthetic-token", "/service", AbortSignal.timeout(5000))).toEqual({ authorization: "Bearer synthetic-token" });
  const forward = await startForward(f.environment.baseURL, ca);
  try {
    const response = await fetch(`http://127.0.0.1:${forward.port}/service`, { signal: AbortSignal.timeout(5000), headers: { authorization: "Bearer synthetic-token" } });
    expect(await response.json()).toEqual({ authorization: "Bearer synthetic-token" });
    const socket = new WebSocket(`ws://127.0.0.1:${forward.port}/channel`);
    try {
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      const echoed = new Promise<string>((resolve, reject) => { socket.once("message", data => resolve(data.toString())); socket.once("error", reject); });
      socket.send("fixture"); expect(await echoed).toBe("fixture");
    } finally { socket.terminate(); }
    expect(forward.accepted()).toBe(2);
  } finally { await forward.close(); }
}, 30_000);

test("the namespace forward refuses an untrusted upstream certificate", async () => {
  const f = await fixture(true), ca = await readFile(path.join(f.directory, "daynight-ca.pem"));
  await expect(requestService(f.environment.baseURL, ca, "synthetic-token", "/service", AbortSignal.timeout(5000))).rejects.toThrow();
  const forward = await startForward(f.environment.baseURL, ca);
  try { await expect(fetch(`http://127.0.0.1:${forward.port}/service`, { signal: AbortSignal.timeout(5000) })).rejects.toThrow(); }
  finally { await forward.close(); }
}, 30_000);

test.each([false, true])("the separate reader resolves the local service and validates its certificate (untrusted=%s)", async untrusted => {
  const f = await fixture(untrusted), resolver = path.resolve(import.meta.dirname, "../../../e2e_tests/src/resolve-local.cjs");
  const source = `fetch(process.argv[1] + '/service', { signal: AbortSignal.timeout(5000) }).then(r => r.json()).then(() => process.stdout.write('verified'), () => process.exitCode = 7)`;
  const child = runFile(process.execPath, ["--require", resolver, "-e", source, f.environment.baseURL], { env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(f.directory, "daynight-ca.pem") }, timeout: 10_000 });
  if (untrusted) await expect(child).rejects.toMatchObject({ code: 7 });
  else expect((await child).stdout).toBe("verified");
}, 30_000);
