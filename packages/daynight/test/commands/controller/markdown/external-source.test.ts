import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createServer as createRawServer, connect, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertExternalImageSocketPeer, copyExternalImage, createExternalImagePolicy, resolveExternalImageAddresses, type ExternalImageDnsResolver, type ExternalImagePolicy } from "../../../../src/commands/controller/markdown/external-source.js";

const roots: string[] = [], servers: Server[] = [], sockets = new Set<Socket>();
afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets) socket.destroy(); sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});
async function output() {
  const base = path.resolve(import.meta.dirname, "../../../../../../.tmp/external-image-tests");
  await mkdir(base, { recursive: true }); const dir = await mkdtemp(path.join(base, "case-")); roots.push(dir);
  const file = path.join(dir, "reserved"); await writeFile(file, "", { mode: 0o600 }); return file;
}
async function listen(server: Server) {
  servers.push(server); server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
async function fixture(handler: RequestListener, extra: { tls?: boolean; assertEgressPolicy?: () => void } = {}) {
  const server = extra.tls ? createTlsServer({ key: TLS_KEY, cert: TLS_CERT }, handler) : createServer(handler), port = await listen(server);
  const charges: string[] = [];
  const policy = createExternalImagePolicy({ assertEgressPolicy: extra.assertEgressPolicy ?? (() => {}), beforeRequest: ({ hostname }) => { charges.push(hostname); }, controlledNetworkBoundary: { hostname: "fixture.example", address: "127.0.0.1", port, ...(extra.tls ? { ca: TLS_CERT } : {}) } });
  return { url: `${extra.tls ? "https" : "http"}://fixture.example:${port}/original?token=source#fragment`, policy, charges };
}
const start = async (url: string, policy: ExternalImagePolicy, signal?: AbortSignal) => copyExternalImage({ url, outputPath: await output(), policy, ...(signal ? { signal } : {}) });

test("dedicated transport preserves origin path and Host while omitting environment credentials and cookies across a fresh redirect socket", async () => {
  const requests: { method: string | undefined; url: string | undefined; headers: Record<string, unknown>; port: number | undefined }[] = [];
  const priorProxy = process.env.HTTP_PROXY; process.env.HTTP_PROXY = "http://secret:password@127.0.0.1:1";
  const f = await fixture((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, port: req.socket.remotePort });
    if (requests.length === 1) { res.writeHead(302, { Location: "/saved?sig=exact%2Fvalue", "Set-Cookie": "session=secret" }); res.end("ignored"); }
    else { res.writeHead(200, { "Content-Type": "image/png", "Content-Length": "8" }); res.end("original"); }
  });
  try {
    const result = await start(f.url, f.policy);
    expect(await readFile(result.inputPath, "utf8")).toBe("original");
    expect(result).toMatchObject({ byteLength: "8", sha256: createHash("sha256").update("original").digest("hex") });
    expect(f.charges).toEqual(["fixture.example", "fixture.example"]);
    expect(requests.map(r => [r.method, r.url])).toEqual([["GET", "/original?token=source"], ["GET", "/saved?sig=exact%2Fvalue"]]);
    expect(requests[0]!.port).not.toBe(requests[1]!.port);
    for (const req of requests) expect(req.headers).toEqual({ host: new URL(f.url).host, accept: "image/png,image/jpeg,image/webp,image/gif,image/avif", "accept-encoding": "identity", "user-agent": "Daynight-Image-Source/1", connection: "close" });
  } finally { if (priorProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = priorProxy; }
});

test("TLS uses the original hostname and validates the certificate with an isolated trust root", async () => {
  let servername: string | undefined;
  const f = await fixture((req, res) => { servername = (req.socket as import("node:tls").TLSSocket).servername || undefined; res.end("tls bytes"); }, { tls: true });
  const result = await start(f.url, f.policy);
  expect(servername).toBe("fixture.example"); expect(await readFile(result.inputPath, "utf8")).toBe("tls bytes");
  const wrongHostname = createExternalImagePolicy({ assertEgressPolicy() {}, beforeRequest() {}, controlledNetworkBoundary: { hostname: "wrong.example", address: "127.0.0.1", port: Number(new URL(f.url).port), ca: TLS_CERT } });
  await expect(start(f.url.replace("fixture.example", "wrong.example"), wrongHostname)).rejects.toMatchObject({ code: "source_unavailable" });
});

test("private redirects and credentials never reach the destination", async () => {
  let forbiddenRequests = 0;
  const destination = createServer((_req, res) => { forbiddenRequests++; res.end("forbidden"); }), port = await listen(destination);
  const f = await fixture((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${port}/metadata` }); res.end(); });
  await expect(start(f.url, f.policy)).rejects.toMatchObject({ code: "source_forbidden" });
  expect(forbiddenRequests).toBe(0);
});

test("redirects stop after six total requests and loops do not request the repeated URL", async () => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests++; res.writeHead(302, { Location: `/hop-${requests}` }); res.end(); });
  await expect(start(f.url, f.policy)).rejects.toMatchObject({ code: "source_forbidden" }); expect(requests).toBe(6);
  const loop = await fixture((_req, res) => { res.writeHead(302, { Location: "/original?token=source" }); res.end(); });
  await expect(start(loop.url, loop.policy)).rejects.toMatchObject({ code: "source_forbidden" }); expect(loop.charges).toHaveLength(1);
});

test("raw ambiguous, duplicated, encoded, truncated and oversized headers cannot become a successful copy", async () => {
  const responses = [
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx",
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1\r\n\r\nx",
    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Type: image/jpeg\r\nContent-Length: 1\r\n\r\nx",
    "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nx",
    "HTTP/1.1 200 OK\r\n" + Array.from({ length: 101 }, (_, i) => `X-Test-${i}: x\r\n`).join("") + "Content-Length: 1\r\n\r\nx",
    "HTTP/1.1 200 OK\r\nX-Big: " + "x".repeat(33000) + "\r\nContent-Length: 1\r\n\r\nx",
  ];
  for (const response of responses) {
    const server = createRawServer(socket => { socket.once("data", () => socket.end(response)); }), port = await listen(server);
    const policy = createExternalImagePolicy({ assertEgressPolicy() {}, beforeRequest() {}, controlledNetworkBoundary: { hostname: "fixture.example", address: "127.0.0.1", port } });
    await expect(start(`http://fixture.example:${port}/`, policy)).rejects.toMatchObject({ code: "source_unavailable" });
  }
});

test("only final 200 and declared supported image types are accepted; retry cooldown is bounded", async () => {
  for (const [status, code, retryAfterSeconds] of [[404, "source_not_found", undefined], [410, "source_not_found", undefined], [401, "permission_denied", undefined], [403, "permission_denied", undefined], [206, "source_unavailable", undefined], [304, "source_unavailable", undefined], [429, "source_rate_limited", 300], [503, "source_busy", 300]] as const) {
    const f = await fixture((_req, res) => { res.writeHead(status, { "Retry-After": "9999" }); res.end(); });
    await expect(start(f.url, f.policy)).rejects.toMatchObject({ code, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) });
  }
  const f = await fixture((_req, res) => { res.writeHead(200, { "Content-Type": "image/svg+xml" }); res.end("<svg/>"); });
  await expect(start(f.url, f.policy)).rejects.toMatchObject({ code: "unsupported_media_type" });
});

test("body byte accounting accepts ten MiB and cancels byte ten MiB plus one without retaining a writer", async () => {
  for (const bytes of [10_485_760, 10_485_761]) {
    const f = await fixture((_req, res) => { res.writeHead(200, { "Content-Type": "image/png" }); res.end(Buffer.alloc(bytes, 71)); });
    if (bytes === 10_485_760) { const result = await start(f.url, f.policy); expect(result.byteLength).toBe(String(bytes)); expect((await readFile(result.inputPath)).length).toBe(bytes); }
    else await expect(start(f.url, f.policy)).rejects.toMatchObject({ code: "source_too_large" });
  }
});

test("cancellation destroys and joins a real in-flight socket", async () => {
  let begin!: () => void; const began = new Promise<void>(resolve => { begin = resolve; });
  const f = await fixture((_req, res) => { res.writeHead(200); res.write("first"); begin(); });
  const abort = new AbortController(), copying = start(f.url, f.policy, abort.signal);
  const result = expect(copying).rejects.toMatchObject({ code: "source_cancelled" });
  await began; abort.abort(); await result;
  // The reader has joined its socket; the server's peer observes closure in the next I/O turn.
  await new Promise(resolve => setImmediate(resolve));
  expect([...sockets].every(socket => socket.destroyed)).toBe(true);
});

test("a header deadline destroys its real socket and returns a typed timeout", async () => {
  let begin!: () => void; const began = new Promise<void>(resolve => { begin = resolve; });
  const f = await fixture(() => { begin(); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const copying = start(f.url, f.policy), result = expect(copying).rejects.toMatchObject({ code: "source_timeout" });
  await began; await vi.advanceTimersByTimeAsync(8001); await result;
});

function resolver(records: Record<string, { a?: string[]; aaaa?: string[]; cname?: string[]; error6?: string }>): ExternalImageDnsResolver {
  return { resolve4: async host => records[host]?.a ?? [], resolve6: async host => { if (records[host]?.error6) throw Object.assign(new Error("controlled DNS failure"), { code: records[host]!.error6 }); return records[host]?.aaaa ?? []; }, resolveCname: async host => records[host]?.cname ?? [], cancel() {} };
}
test("DNS checks all address families and aliases before allowing a connection", async () => {
  const signal = new AbortController().signal;
  await expect(resolveExternalImageAddresses("origin.example", signal, resolver({ "origin.example": { a: ["8.8.8.8"], aaaa: ["::1"] } }))).rejects.toMatchObject({ code: "source_forbidden" });
  await expect(resolveExternalImageAddresses("origin.example", signal, resolver({ "origin.example": { a: ["8.8.8.8"], error6: "ETIMEOUT" } }))).rejects.toMatchObject({ code: "source_timeout" });
  await expect(resolveExternalImageAddresses("origin.example", signal, resolver({ "origin.example": { a: ["8.8.8.8"], cname: ["alias.example"] }, "alias.example": { a: ["169.254.169.254"] } }))).rejects.toMatchObject({ code: "source_forbidden" });
  await expect(resolveExternalImageAddresses("origin.example", signal, resolver({ "origin.example": { a: ["8.8.8.8"], cname: ["metadata.google.internal"] } }))).rejects.toMatchObject({ code: "source_forbidden" });
  await expect(resolveExternalImageAddresses("origin.example", signal, resolver({ "origin.example": { a: ["8.8.8.8"], error6: "ENODATA" } }))).resolves.toEqual(["8.8.8.8"]);
});

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDMTCCAhmgAwIBAgIUU6yPjtw6lrDZpO5AFuMjMLH5OyEwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPZml4dHVyZS5leGFtcGxlMB4XDTI2MTExMDA2MjUzNloX
DTM2MTEwNzA2MjUzNlowGjEYMBYGA1UEAwwPZml4dHVyZS5leGFtcGxlMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwmH71eH8TvAX8IGLOH18eAbBNolb
1MyrE2RE9m4zZhmsP66+46fiwhh/xiSmJiC5ln4dtgG0PsTL+edd6IfvdFjp/NQ6
ioyzKjV6tdtjmIBLiXXcKucpwmyNRejkLMmf4ZiTifsp0m4vzqlNIWzLuAEj+eGR
tJL3n7rIsoaHp91w+QByT9RO8het3fm4s4abSCZVsnpZ6HOWPj13yz+xyGPhsbFa
zirQsDQJN4RoQBa0JxOb8qG1u/vMAWJZTUi9P48ByHTkX66bkLghLSiRoDd6vFSb
bUSH16Jw5vc8GIOYvN2l9Xzx37JkV4hKlNnMc0Y5A4WSEdkedkHpLLEnNwIDAQAB
o28wbTAdBgNVHQ4EFgQU6VKyjwL2Dv1YZU3pf4EJiYETfP8wHwYDVR0jBBgwFoAU
6VKyjwL2Dv1YZU3pf4EJiYETfP8wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzAR
gg9maXh0dXJlLmV4YW1wbGUwDQYJKoZIhvcNAQELBQADggEBAGPSrJnpkw1JHxMb
HVIpaUwIevDbo6cafgKfhsQwmqlPjDQ0bQU4iUhe9eZ2jnH//QYJUhYj70+vB8Nh
SGyoVIeL53GmXDwrAPHWeggaRnIbpvx5TJvyv/N5/aX42qaY94bLrCpB08FB1Grk
ZWcwwKRahihKscECqmeBw8r5gp00y3jU6C7p01dRfxECggTlq6SRaDaXTg+2dPAD
h0PZj8hOspti1ia67fASpb3JFUjCjw1wN9on1IyFLkW7TxM0CY/lyfanPu1QkOth
yjGln0/GYO9Z2e/PXCLI1cT4MVbPiotNVgeA0KvvI/S7Q8uq6/RX0z/12q3NcK15
lMtGmyI=
-----END CERTIFICATE-----
`;

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEugIBADANBgkqhkiG9w0BAQEFAASCBKQwggSgAgEAAoIBAQDCYfvV4fxO8Bfw
gYs4fXx4BsE2iVvUzKsTZET2bjNmGaw/rr7jp+LCGH/GJKYmILmWfh22AbQ+xMv5
513oh+90WOn81DqKjLMqNXq122OYgEuJddwq5ynCbI1F6OQsyZ/hmJOJ+ynSbi/O
qU0hbMu4ASP54ZG0kvefusiyhoen3XD5AHJP1E7yF63d+bizhptIJlWyelnoc5Y+
PXfLP7HIY+GxsVrOKtCwNAk3hGhAFrQnE5vyobW7+8wBYllNSL0/jwHIdORfrpuQ
uCEtKJGgN3q8VJttRIfXonDm9zwYg5i83aX1fPHfsmRXiEqU2cxzRjkDhZIR2R52
QekssSc3AgMBAAECgf8+pFUEGE+3IKiWWSkEi2wRQhwB90Ig0dRP64BN6jWmMZ/Q
5f+eXfw1kK+cqzLgFqu4U+w/O01a7RDO+EDLLwN7+ytszvgOrkkO0S06bfkqrC2r
ns/VA6nxfgoI/YSK6m8bxI/HZ6mSpu/BKc4xd14vbi6p2IecKcCjOQ50eeY9sg9u
3EUecQW+aA6/V1CBx9jaqJ2SAr7RdQQFX7G8nvPWusvYW1VG4Fj2O9J8b7elHJEh
AN1kWkPuTFWEJxtG2LgHFBUd3Dw/dcwblXsUnRLPVgcq72Vt6ljF0ImvEmTh65hh
Qw8H8knWwrUR27Qjfq8xfgJaNrsuR0kD/Vlg810CgYEA36cPo7TQdSOLJ1ZOf2UQ
kFDee1WXvo3cVZD9l5t1PeYPgx0mGVto7P+GEtX1nnyxWw5yHkHnW3a5sc74dW13
TBIOCeoOHUpu9imTB2hroqpImZvYuNJd/VTs1koDm2o0qkVMQWZubAprtEFAGuIS
6EZGOwbQBOKdg/ZKAV1lRBMCgYEA3n8uPNPDzNHfX0O3caHynfEOioZiZyIbpZff
A4c/x8p9113EG8wYY2qcA6mtL+kpu6WZwLrp9hgRLvFKepcK3J9ksv8pLSW1a8lC
TgKBf30yGPhCR9/Acqdx7Nke1AXE6m6zt251e6N5vpPAWyaGRuOH5aUh5fKxn8sj
xIiMTM0CgYA2k/UsFP7d5xuZMOWdDxO4tBNm859BQCspsmVALw6wWUklzOI0Q+ta
Eo0sYYw77d/2AZN1sM19s35jVsepGFqJdMp6PuTM3xIu/jxEDYZevsFSwwZjK+sF
3EijjpJMxeEuQBT4zL9bnDtmVJoJNWw5xJR06RewaYDY6CxtItaIgwKBgE17zvdh
6/MdN4PuiijpdBtqwlyddhFigGxHmmOZKy4Bp5dj0RK5HdkpXFGuOmDP+zec8RF8
RlPsh7doUj6k8SRp4eCwGX/efPKfcRbHqp9iUxr9AeAT3OpQw8zuw9ykcbIOgUml
DwbSpGgo/jkADo0LWd0wh8CTpyX10Wv0/Z8VAoGAAJQLB5Bh1FIQXsSrkYM4cXme
5Z62W3qA3bVpfjP1+4fvNyiDbfGMSFchaBYSlZNF+FaUBKdmllh3FTPUBa8oyixi
SdI30z+mlW1KOkMriys/CdnMY1992WAoFnNXcP6mwjkL64m8xIGpQsBfCZ+T6Y4m
9DXUwlLn1gR/rWYcxKU=
-----END PRIVATE KEY-----
`;


test("the production peer guard rejects a real socket whose actual peer differs from the selected public IP before HTTP is sent", async () => {
  let received = 0;
  const server = createRawServer(socket => { socket.on("data", bytes => { received += bytes.length; }); }), port = await listen(server);
  const socket = connect({ host: "127.0.0.1", port });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    expect(() => assertExternalImageSocketPeer(socket, "8.8.8.8")).toThrow("source_forbidden");
    expect(() => assertExternalImageSocketPeer(socket, "127.0.0.1")).toThrow("source_forbidden");
    expect(received).toBe(0);
  } finally { socket.destroy(); }
});

test("malformed Content-Type parameters are rejected safely", async () => {
  const invalidMime = await fixture((_req, res) => { res.writeHead(200, { "Content-Type": "image/png;broken" }); res.end("image bytes"); });
  await expect(start(invalidMime.url, invalidMime.policy)).rejects.toMatchObject({ code: "unsupported_media_type" });
});

test("non-HTTP Retry-After dates receive the default cooldown", async () => {
  const invalidDate = await fixture((_req, res) => { res.writeHead(503, { "Retry-After": "2020" + "-01" }); res.end(); });
  await expect(start(invalidDate.url, invalidDate.policy)).rejects.toMatchObject({ code: "source_busy", retryAfterSeconds: 30 });
});

test("source authorization is checked again for later body blocks and stops the live writer on revocation", async () => {
  let authorized = true, sendRemainder!: () => void;
  const f = await fixture((_req, res) => { res.writeHead(200, { "Content-Length": "131072" }); res.write(Buffer.alloc(65536, 1)); sendRemainder = () => res.end(Buffer.alloc(65536, 2)); }, { assertEgressPolicy: () => { if (!authorized) throw new Error("revoked"); } });
  const outputPath = await output(), copying = copyExternalImage({ url: f.url, outputPath, policy: f.policy });
  const result = expect(copying).rejects.toMatchObject({ code: "policy_restricted" });
  const deadline = Date.now() + 2000;
  while ((await readFile(outputPath)).length < 65536 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  expect((await readFile(outputPath)).length).toBe(65536); authorized = false; sendRemainder(); await result;
  expect((await readFile(outputPath)).length).toBe(65536);
});

test("a nonempty or substituted reservation is refused before a request is made", async () => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests++; res.end("image"); });
  const outputPath = await output(); await writeFile(outputPath, "existing");
  await expect(copyExternalImage({ url: f.url, outputPath, policy: f.policy })).rejects.toMatchObject({ code: "policy_restricted" });
  expect(await readFile(outputPath, "utf8")).toBe("existing"); expect(requests).toBe(0);
});
