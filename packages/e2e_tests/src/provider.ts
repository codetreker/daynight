import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import type { Socket } from "node:net";

type Authorization = {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
};

export const providerClientId = "product-e2e-github";
export const providerClientSecret = "product-e2e-github-secret";

export type Provider = {
  port: number;
  close: () => Promise<void>;
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
}): Promise<Provider> => {
  const [cert, key] = await Promise.all([readFile(options.certificatePath), readFile(options.keyPath)]);
  const requests = new Map<string, Authorization>();
  const codes = new Map<string, Authorization>();
  const tokens = new Set<string>();
  const sockets = new Set<Socket>();
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
      respond(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local GitHub authorization</title></head><body><h1>Local GitHub authorization</h1><p>Sign in as admin@example.test</p><form method="post" action="/login/oauth/authorize"><input type="hidden" name="request" value="${requestId}"><button type="submit">Authorize local identity</button></form></body></html>`, "text/html; charset=utf-8");
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
      const code = identifier();
      codes.set(code, authorization);
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
      tokens.add(token);
      json(response, 200, { access_token: token, token_type: "Bearer", scope: "read:user user:email" });
      return;
    }
    if (url.hostname === "api.github.com" && request.method === "GET" && (url.pathname === "/user" || url.pathname === "/user/emails")) {
      const authorization = request.headers.authorization;
      if (authorization === undefined || !authorization.startsWith("Bearer ") || !tokens.has(authorization.slice("Bearer ".length))) {
        json(response, 401, { message: "Bad credentials" });
        return;
      }
      if (url.pathname === "/user") {
        json(response, 200, { id: 1, login: "e2e-admin", email: "admin@example.test", name: "E2E Administrator", avatar_url: null });
      } else {
        json(response, 200, url.searchParams.get("page") === null || url.searchParams.get("page") === "1" ? [{ email: "admin@example.test", primary: true, verified: true }] : []);
      }
      return;
    }
    json(response, 404, { error: "unsupported_endpoint" });
  };

  const secure = createHTTPSServer({ cert, key }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      } else {
        json(response, 400, { error: "invalid_request", error_description: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  const proxy = createHTTPServer((_request, response) => json(response, 403, { error: "CONNECT_required" }));
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error) => {
      if (!closing) console.error(`Local provider connection failed: ${error.message}`);
    });
  });
  proxy.on("connect", (request, socket, head) => {
    if (closing || (request.url !== "github.com:443" && request.url !== "api.github.com:443")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
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
    close: () => {
      closePromise ??= (async () => {
        closing = true;
        requests.clear();
        codes.clear();
        tokens.clear();
        const closed = new Promise<void>((resolve, reject) => proxy.close((error) => error === undefined ? resolve() : reject(error)));
        for (const socket of sockets) socket.destroy();
        await closed;
      })();
      return closePromise;
    },
  };
};
