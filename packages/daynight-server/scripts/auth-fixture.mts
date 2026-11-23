import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";

export type AuthFixture = {
  readonly origin: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly child: ChildProcess;
  close(): Promise<void>;
};

export const reserveLoopbackPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Loopback port selection did not return an IP listener.");
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
};

export const startAuthFixture = async (options: {
  readonly binary: string;
  readonly directory: string;
  readonly callbackURL: string;
  readonly listenAddress?: string;
  readonly publicOrigin?: string;
  readonly signal?: AbortSignal;
  readonly onSpawn?: (child: ChildProcess) => Promise<void>;
}): Promise<AuthFixture> => {
  options.signal?.throwIfAborted();
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const readyFile = join(options.directory, "ready.json");
  await rm(readyFile, { force: true });
  options.signal?.throwIfAborted();
  const child = spawn(options.binary, [], {
    env: {
      ...process.env,
      DAYNIGHT_FIXTURE_CALLBACK_URL: options.callbackURL,
      DAYNIGHT_FIXTURE_DATABASE_PATH: join(options.directory, "apps.db"),
      DAYNIGHT_FIXTURE_READY_FILE: readyFile,
      DAYNIGHT_FIXTURE_LISTEN_ADDRESS: options.listenAddress ?? "127.0.0.1:0",
      DAYNIGHT_FIXTURE_PUBLIC_URL: options.publicOrigin ?? "",
    },
    stdio: ["ignore", "ignore", "pipe"],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  let exited = false;
  let failure: Error | undefined;
  let diagnosticBytes = 0;
  const completion = new Promise<void>((resolve) => {
    child.once("error", (cause) => { if (!options.signal?.aborted) failure = new Error("Unable to start the real UniAuth fixture.", { cause }); });
    child.once("close", (code, signal) => {
      exited = true;
      if (code !== 0 && !options.signal?.aborted) failure ??= new Error(`The real UniAuth fixture exited with ${signal === null ? `code ${code}` : `signal ${signal}`}.`);
      resolve();
    });
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    diagnosticBytes += chunk.byteLength;
    if (diagnosticBytes > 1_048_576) {
      failure ??= new Error("UniAuth fixture diagnostic output exceeded its limit.");
      child.kill("SIGTERM");
    }
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    if (!exited) {
      child.kill("SIGTERM");
      let deadline: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        completion.then(() => false),
        new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(true), 5_000); }),
      ]);
      clearTimeout(deadline);
      if (timedOut) {
        child.kill("SIGKILL");
        await completion;
        failure ??= new Error("UniAuth fixture exceeded its shutdown deadline.");
      }
    }
    await rm(readyFile, { force: true });
    if (failure !== undefined) throw failure;
  })();
  try {
    await options.onSpawn?.(child);
    options.signal?.throwIfAborted();
    const deadline = performance.now() + 10_000;
    while (true) {
      options.signal?.throwIfAborted();
      if (failure !== undefined) throw failure;
      if (exited) throw new Error("UniAuth fixture exited before readiness.");
      let data: string | undefined;
      try { data = await readFile(readyFile, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (data !== undefined) {
        const info = await stat(readyFile);
        if (!info.isFile() || process.platform !== "win32" && (info.mode & 0o777) !== 0o600) throw new Error("UniAuth fixture readiness must be a private file.");
        let ready: { origin?: unknown; appId?: unknown; appSecret?: unknown };
        try { ready = JSON.parse(data) as typeof ready; }
        catch { throw new Error("Invalid private UniAuth fixture readiness JSON."); }
        if (typeof ready.origin !== "string" || typeof ready.appId !== "string" || typeof ready.appSecret !== "string" || ready.appId === "" || ready.appSecret === "") throw new Error("Invalid UniAuth fixture readiness metadata.");
        const origin = new URL(ready.origin);
        if (origin.origin !== ready.origin || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("Fixture readiness must report its numeric loopback HTTP origin.");
        await rm(readyFile);
        return { origin: ready.origin, appId: ready.appId, appSecret: ready.appSecret, child, close };
      }
      if (performance.now() >= deadline) throw new Error("UniAuth fixture readiness deadline exceeded.");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "UniAuth fixture startup and cleanup failed."); }
    throw error;
  }
};

export type AuthenticatedFixture = {
  readonly cookie: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  preview(taskId: string, path: string, init?: RequestInit): Promise<Response>;
  createPAT(name?: string, days?: number): Promise<string>;
};

export const login = async (options: {
  readonly origin: string;
  readonly persona?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<AuthenticatedFixture> => {
  options.signal?.throwIfAborted();
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin) throw new Error("Authentication fixture requires an exact product origin.");
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port) throw new Error("Authentication fixture requires numeric loopback.");
  const preview = new URL(origin);
  const port = Number(origin.port);
  preview.port = String(port === 65535 ? 65534 : port + 1);
  const cookies = new Map<string, { host: string; value: string; secure: boolean }>();
  const fetch = options.fetch ?? globalThis.fetch;
  const virtualRequest = async (socketURL: URL, headers: Headers, signal: AbortSignal): Promise<Response> => {
    return await new Promise((resolve, reject) => {
      const request = httpRequest(socketURL, { method: "GET", headers: Object.fromEntries(headers), signal }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const output = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) output.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
          const status = response.statusCode ?? 500;
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: output }));
        });
      });
      request.on("error", reject);
      request.end();
    });
  };
  const exchange = async (url: URL, init: RequestInit = {}): Promise<Response> => {
    options.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    const virtual = url.origin === preview.origin;
    const values = [...cookies.values()].filter((cookie) => cookie.host === url.hostname && (!cookie.secure || url.protocol === "https:")).map((cookie) => cookie.value);
    if (options.fetch === undefined && values.length !== 0 && !headers.has("Cookie")) headers.set("Cookie", values.join("; "));
    if (virtual) headers.set("Host", url.host);
    const signals = [AbortSignal.timeout(10_000), ...(options.signal === undefined ? [] : [options.signal]), ...(init.signal == null ? [] : [init.signal])];
    const socketURL = virtual ? new URL(`${url.pathname}${url.search}`, origin) : url;
    const signal = AbortSignal.any(signals);
    const response = options.fetch === undefined && (virtual || headers.has("Host"))
      ? await virtualRequest(socketURL, headers, signal)
      : await fetch(socketURL, { ...init, headers, redirect: "manual", signal });
    for (const raw of response.headers.getSetCookie()) {
      const parts = raw.split(";");
      const value = parts[0]!;
      const separator = value.indexOf("=");
      if (separator < 1) throw new Error("Authentication fixture received an invalid cookie.");
      const key = `${url.hostname}:${value.slice(0, separator)}`;
      if (parts.some((part) => /^\s*max-age\s*=\s*(?:0|-\d+)\s*$/i.test(part))) cookies.delete(key);
      else cookies.set(key, { host: url.hostname, value, secure: parts.some((part) => /^\s*secure\s*$/i.test(part)) });
    }
    return response;
  };
  const redirect = async (url: URL, status: number): Promise<URL> => {
    const response = await exchange(url);
    await response.body?.cancel();
    if (response.status !== status || response.headers.get("location") === null) throw new Error(`Authentication fixture expected HTTP ${status} redirect.`);
    return new URL(response.headers.get("location")!, url);
  };
  const loginURL = new URL("/api/v1/auth/login?provider=github", origin);
  let authorize = await redirect(loginURL, 303);
  if (authorize.href === loginURL.href) authorize = await redirect(loginURL, 303);
  const upstream = await redirect(authorize, 302);
  if (upstream.origin !== "https://github.com" || upstream.pathname !== "/login/oauth/authorize" || upstream.searchParams.get("code_challenge_method") !== "S256" || !upstream.searchParams.get("code_challenge")) throw new Error("Real GitHub authorization or PKCE challenge changed.");
  const callback = new URL(upstream.searchParams.get("redirect_uri")!);
  if (callback.origin !== authorize.origin) throw new Error("Provider callback left its UniAuth gateway.");
  callback.search = new URLSearchParams({ state: upstream.searchParams.get("state")!, code: `${options.persona ?? "alice"}:${upstream.searchParams.get("code_challenge")!}` }).toString();
  const productCallback = await redirect(callback, 302);
  if (productCallback.origin !== origin.origin) throw new Error("Gateway callback left its registered product origin.");
  const result = await redirect(productCallback, 303);
  if (result.origin !== preview.origin || result.pathname !== "/auth/sso/start") throw new Error("Product callback did not start preview SSO.");
  const ssoAuthorize = await redirect(result, 303);
  if (ssoAuthorize.origin !== origin.origin || ssoAuthorize.pathname !== "/api/v1/auth/preview/authorize") throw new Error("Preview SSO left its main authorization origin.");
  const ssoCallback = await redirect(ssoAuthorize, 303);
  if (ssoCallback.origin !== preview.origin || ssoCallback.pathname !== "/auth/sso/callback") throw new Error("Preview SSO callback origin changed.");
  const ssoComplete = await redirect(ssoCallback, 303);
  if (ssoComplete.origin !== preview.origin || ssoComplete.pathname !== "/auth/sso/complete") throw new Error("Preview SSO completion origin changed.");
  const finish = await redirect(ssoComplete, 303);
  if (finish.origin !== origin.origin || finish.pathname !== "/auth/complete" || finish.searchParams.get("returnPath") !== "/projects") throw new Error("Preview SSO lost the main completion target.");
  const session = [...cookies.values()].find((cookie) => cookie.host === origin.hostname && /^(?:__Host-)?daynight_session=/.test(cookie.value));
  if (session === undefined) throw new Error("Product login did not establish a session.");
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) throw new Error("Authenticated fixture request must remain on its product origin.");
    const headers = new Headers(init.headers);
    if (!["GET", "HEAD", "OPTIONS"].includes(init.method ?? "GET")) headers.set("Origin", origin.origin);
    return await exchange(url, { ...init, headers });
  };
  const previewRequest = async (taskId: string, path: string, init: RequestInit = {}): Promise<Response> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId) || !path.startsWith("/")) throw new Error("Invalid preview address.");
    const target = new URL(path, preview);
    if (target.origin !== preview.origin) throw new Error("Preview request must remain on its configured origin.");
    const headers = new Headers(init.headers);
    headers.set("Host", `${taskId}.${preview.host}`);
    const credential = [...cookies.values()].find((cookie) => cookie.host === preview.hostname && /^daynight_preview_session=/.test(cookie.value));
    if (credential === undefined) throw new Error("Preview login did not establish its session.");
    headers.set("Cookie", credential.value);
    return await exchange(new URL(`${target.pathname}${target.search}`, origin), { ...init, headers });
  };
  const createPAT = async (name = "Acceptance fixture", days = 1): Promise<string> => {
    const response = await request("/api/v1/me/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() }) });
    if (response.status !== 201) { await response.body?.cancel(); throw new Error("Fixture PAT creation failed."); }
    let value: { token?: unknown };
    try { value = await response.json() as typeof value; }
    catch { throw new Error("Fixture PAT response JSON is invalid."); }
    if (typeof value.token !== "string" || !value.token.startsWith("dnpat_")) throw new Error("Fixture PAT response is invalid.");
    return value.token;
  };
  return { cookie: session.value, request, preview: previewRequest, createPAT };
};
