import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

type Authorization = {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
};
type Identity = "admin" | "member" | "collaborator";

export const providerClientId = "product-e2e-github";
export const providerClientSecret = "product-e2e-github-secret";

export type Provider = {
  port: number;
  close: () => Promise<void>;
  diagnostics: () => ProviderDiagnostics;
};

type ProviderEvent = {
  sequence: number;
  type: "connect" | "tls_ready" | "tls_error" | "http_request" | "http_finish";
  connectionId: number | "unknown";
  target?: "github.com:443" | "api.github.com:443" | "other";
  accepted?: boolean;
  headPresent?: boolean;
  method?: string;
  origin?: string;
  path?: string;
  status?: number;
  errorCode?: string;
};

export type ProviderDiagnostics = { events: ProviderEvent[]; complete: boolean; truncated: boolean };
const eventLimit = 256;
const errorCodes = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_UNEXPECTED_EOF_WHILE_READING", "ERR_SSL_HTTP_REQUEST", "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN", "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA"]);
const safeErrorCode = (error: Error): string => {
  const code: unknown = "code" in error ? error.code : undefined;
  return typeof code === "string" && errorCodes.has(code) ? code : "other";
};
const endpoint = (request: IncomingMessage): { origin: string; path: string } => {
  const host = request.headers.host;
  if (host !== "github.com" && host !== "github.com:443" && host !== "api.github.com" && host !== "api.github.com:443") return { origin: "other", path: "other" };
  try {
    const url = new URL(request.url ?? "", `https://${host}`);
    if (url.origin === "https://github.com" && (url.pathname === "/login/oauth/authorize" || url.pathname === "/login/oauth/access_token")) return { origin: url.origin, path: url.pathname };
    if (url.origin === "https://api.github.com" && (url.pathname === "/user" || url.pathname === "/user/emails")) return { origin: url.origin, path: url.pathname };
  } catch { /* Invalid requests have no recognized endpoint. */ }
  return { origin: "other", path: "other" };
};

// Socket wrappers change at TLS handoff; only a live public endpoint tuple can
// associate them without relying on Node's private socket implementation.
const socketTuple = (socket: Socket): string | undefined => {
  const { localAddress, localPort, remoteAddress, remotePort } = socket;
  if (localAddress === undefined || localPort === undefined || remoteAddress === undefined || remotePort === undefined) return undefined;
  return JSON.stringify([localAddress, localPort, remoteAddress, remotePort]);
};

const identifier = (): string => randomBytes(24).toString("base64url");

const required = (parameters: URLSearchParams, name: string): string => {
  const value = parameters.get(name);
  if (value === null || value === "") throw new Error(`Missing OAuth parameter: ${name}`);
  return value;
};

const body = async (request: IncomingMessage): Promise<URLSearchParams> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 64 * 1024) throw new Error("OAuth request body exceeds the fixture limit");
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
};

const respond = (response: ServerResponse, status: number, value: string, contentType: string): void => {
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(value), "Cache-Control": "no-store" });
  response.end(value);
};

const json = (response: ServerResponse, status: number, value: unknown): void =>
  respond(response, status, JSON.stringify(value), "application/json");

const redirect = (response: ServerResponse, destination: string): void => {
  response.writeHead(302, { Location: destination, "Content-Length": 0, "Cache-Control": "no-store" });
  response.end();
};

export const startProvider = async (options: {
  port: number;
  certificatePath: string;
  keyPath: string;
  testStall?: "tls" | "http";
  onDiagnostics?: (diagnostics: ProviderDiagnostics) => void;
}): Promise<Provider> => {
  const [cert, key] = await Promise.all([readFile(options.certificatePath), readFile(options.keyPath)]);
  const requests = new Map<string, Authorization>();
  const codes = new Map<string, Authorization & { identity: Identity }>();
  const tokens = new Map<string, Identity>();
  const sockets = new Set<Socket>();
  const connections = new Map<string, number>();
  const tlsConnections = new WeakMap<TLSSocket, number | "unknown">();
  const events: ProviderEvent[] = [];
  let truncated = false;
  let complete = false;
  let ended = false;
  let nextConnectionId = 0;
  let nextSequence = 0;
  const record = (event: Omit<ProviderEvent, "sequence">): void => {
    if (ended) return;
    if (events.length === eventLimit) {
      if (!truncated) { truncated = true; options.onDiagnostics?.({ events: events.map((item) => ({ ...item })), complete, truncated }); }
      return;
    }
    events.push({ sequence: ++nextSequence, ...event });
    options.onDiagnostics?.({ events: events.map((item) => ({ ...item })), complete, truncated });
  };
  const identify = (socket: Socket): number | "unknown" => {
    const tuple = socketTuple(socket);
    return tuple === undefined ? "unknown" : connections.get(tuple) ?? "unknown";
  };
  let closing = false;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const hostname = request.headers.host;
    if (hostname !== "github.com" && hostname !== "github.com:443" && hostname !== "api.github.com" && hostname !== "api.github.com:443") {
      json(response, 403, { error: "unsupported_host" });
      return;
    }
    const url = new URL(request.url!, `https://${hostname}`);
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/authorize" && request.method === "GET") {
      const query = url.searchParams;
      if (query.get("code_challenge_method") !== "S256") {
        json(response, 400, { error: "invalid_request", error_description: "S256 PKCE is required" });
        return;
      }
      const authorization = {
        clientId: required(query, "client_id"),
        redirectUri: required(query, "redirect_uri"),
        state: required(query, "state"),
        challenge: required(query, "code_challenge"),
      };
      if (authorization.clientId !== providerClientId) {
        json(response, 400, { error: "invalid_client" });
        return;
      }
      const callback = new URL(authorization.redirectUri);
      if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1") {
        json(response, 400, { error: "invalid_request", error_description: "A local HTTP callback is required" });
        return;
      }
      const requestId = identifier();
      requests.set(requestId, authorization);
      respond(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local GitHub authorization</title></head><body><h1>Local GitHub authorization</h1><form method="post" action="/login/oauth/authorize"><input type="hidden" name="request" value="${requestId}"><button type="submit" name="identity" value="admin">Authorize local identity</button><button type="submit" name="identity" value="member">Authorize member identity</button><button type="submit" name="identity" value="collaborator">Authorize collaborator identity</button></form></body></html>`, "text/html; charset=utf-8");
      return;
    }
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/authorize" && request.method === "POST") {
      const parameters = await body(request);
      const requestId = required(parameters, "request");
      const authorization = requests.get(requestId);
      requests.delete(requestId);
      if (authorization === undefined) {
        json(response, 400, { error: "invalid_request" });
        return;
      }
      const identity = parameters.get("identity") ?? "admin";
      if (identity !== "admin" && identity !== "member" && identity !== "collaborator") { json(response, 400, { error: "invalid_identity" }); return; }
      const code = identifier();
      codes.set(code, { ...authorization, identity });
      const callback = new URL(authorization.redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", authorization.state);
      redirect(response, callback.href);
      return;
    }
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token" && request.method === "POST") {
      const parameters = await body(request);
      const code = required(parameters, "code");
      const authorization = codes.get(code);
      codes.delete(code);
      const verifier = required(parameters, "code_verifier");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (authorization === undefined || parameters.get("grant_type") !== "authorization_code" || parameters.get("client_id") !== authorization.clientId || parameters.get("redirect_uri") !== authorization.redirectUri || parameters.get("client_secret") !== providerClientSecret || challenge !== authorization.challenge) {
        json(response, 400, { error: "invalid_grant" });
        return;
      }
      const token = identifier();
      tokens.set(token, authorization.identity);
      json(response, 200, { access_token: token, token_type: "Bearer", scope: "read:user user:email" });
      return;
    }
    if (url.hostname === "api.github.com" && request.method === "GET" && (url.pathname === "/user" || url.pathname === "/user/emails")) {
      const authorization = request.headers.authorization;
      if (authorization === undefined || !authorization.startsWith("Bearer ") || !tokens.has(authorization.slice("Bearer ".length))) {
        json(response, 401, { message: "Bad credentials" });
        return;
      }
      const identity = tokens.get(authorization.slice("Bearer ".length))!;
      const email = `${identity}@example.test`;
      if (url.pathname === "/user") {
        const profiles = { admin: { id: 1, name: "E2E Administrator" }, member: { id: 2, name: "E2E Member" }, collaborator: { id: 3, name: "E2E Collaborator" } };
        json(response, 200, { ...profiles[identity], login: `e2e-${identity}`, email, avatar_url: null });
      } else {
        json(response, 200, url.searchParams.get("page") === null || url.searchParams.get("page") === "1" ? [{ email, primary: true, verified: true }] : []);
      }
      return;
    }
    json(response, 404, { error: "unsupported_endpoint" });
  };

  const secure = createHTTPSServer({ cert, key }, (request, response) => {
    const connectionId = tlsConnections.get(request.socket as TLSSocket) ?? "unknown";
    const method = request.method === "GET" || request.method === "POST" ? request.method : "other";
    const safeEndpoint = endpoint(request);
    record({ type: "http_request", connectionId, method, ...safeEndpoint });
    response.once("finish", () => record({ type: "http_finish", connectionId, method, ...safeEndpoint, status: response.statusCode }));
    if (options.testStall === "http") return;
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      } else {
        json(response, 400, { error: "invalid_request", error_description: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  secure.on("secureConnection", (socket) => {
    const connectionId = identify(socket);
    tlsConnections.set(socket, connectionId);
    record({ type: "tls_ready", connectionId });
  });
  secure.on("tlsClientError", (error, socket) => {
    record({ type: "tls_error", connectionId: identify(socket), errorCode: safeErrorCode(error) });
  });
  const proxy = createHTTPServer((_request, response) => json(response, 403, { error: "CONNECT_required" }));
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error) => {
      if (!closing) console.error(`Local provider connection failed: ${safeErrorCode(error)}`);
    });
  });
  proxy.on("connect", (request, socket, head) => {
    const connectionId = ++nextConnectionId;
    const tuple = socketTuple(socket as Socket);
    if (tuple !== undefined) {
      connections.set(tuple, connectionId);
      socket.once("close", () => { if (connections.get(tuple) === connectionId) connections.delete(tuple); });
    }
    const target = request.url === "github.com:443" || request.url === "api.github.com:443" ? request.url : "other";
    const accepted = !closing && target !== "other";
    record({ type: "connect", connectionId, target, accepted, headPresent: head.length !== 0 });
    if (!accepted) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (options.testStall === "tls") return;
    if (head.length !== 0) socket.unshift(head);
    secure.emit("connection", socket);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(options.port, "0.0.0.0", () => {
      proxy.off("error", reject);
      resolve();
    });
  });
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("Provider did not bind a TCP port");
  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    diagnostics: () => ({ events: events.map((event) => ({ ...event })), complete, truncated }),
    close: () => {
      closePromise ??= (async () => {
        try {
          closing = true;
          requests.clear();
          codes.clear();
          tokens.clear();
          const closed = new Promise<void>((resolve, reject) => proxy.close((error) => error === undefined ? resolve() : reject(error)));
          for (const socket of sockets) socket.destroy();
          await closed;
          complete = true;
        } finally { ended = true; }
      })();
      return closePromise;
    },
  };
};
