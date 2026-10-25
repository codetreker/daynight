import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { CliContext } from "../../../src/cli/context.js";
import { runLoginCommand, runLogoutCommand } from "../../../src/commands/auth/command.js";
import { loadServerConfiguration } from "../../../src/config/server.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async (source?: string) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/auth-tests");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "device-")); roots.push(root);
  const paths = resolveConfigurationPaths(root);
  if (source !== undefined) { await mkdir(paths.stateDirectory); await writeFile(paths.configFile, source); }
  const context: CliContext = { version: "0.0.0", packageDirectory: root, homeDirectory: () => root, workingDirectory: () => { throw new Error("Auth must not inspect cwd"); }, stdout: vi.fn(), stderr: vi.fn(), stdoutBytes: vi.fn(async () => {}) };
  return { root, context, paths };
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const authorization = (origin = "https://daynight.cc") => ({ device_code: "private-device-secret", user_code: "BCDFG-HJKLM", verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?user_code=BCDFG-HJKLM`, expires_in: 600, interval: 5 });
const token = { access_token: "opaque-cli-credential", token_type: "Bearer", expires_in: 2592000 };
const successFetch = () => vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(authorization())).mockResolvedValueOnce(json(token));
const immediateWait = vi.fn(async (_milliseconds: number, signal: AbortSignal) => { signal.throwIfAborted(); });

describe("explicit device login", () => {
  it("uses the default origin, RFC forms and pacing, saves a restricted credential, then uses it for business requests", async () => {
    const { context, paths } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(authorization()))
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(json({ error: "slow_down" }, 400))
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(json(token));
    const openBrowser = vi.fn(async () => {});
    const wait = immediateWait.mockClear();
    await runLoginCommand([], context, { fetch, openBrowser, wait });
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://daynight.cc/device?user_code=BCDFG-HJKLM", expect.any(AbortSignal));
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([5000, 5000, 10000, 10000]);
    const [firstUrl, firstInit] = fetch.mock.calls[0]!;
    expect(String(firstUrl)).toBe("https://daynight.cc/api/v1/auth/device/code");
    expect(firstInit).toMatchObject({ method: "POST", body: "client_id=daynight-cli", cache: "no-store", redirect: "manual" });
    expect(new Headers(firstInit!.headers).get("Authorization")).toBeNull();
    const [pollUrl, pollInit] = fetch.mock.calls[1]!;
    expect(String(pollUrl)).toBe("https://daynight.cc/api/v1/auth/device/token");
    expect(Object.fromEntries(new URLSearchParams(pollInit!.body as string))).toEqual({ client_id: "daynight-cli", grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "private-device-secret" });
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ serverToken: token.access_token });
    if (process.platform !== "win32") expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
    const output = vi.mocked(context.stderr).mock.calls.flat().join("");
    expect(output).toContain("BCDFG-HJKLM");
    expect(output).not.toContain(token.access_token);
    expect(output).not.toContain("private-device-secret");
    expect(context.stdout).not.toHaveBeenCalled();
    const businessFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ items: [], nextCursor: null }));
    await runServerCommand(context, async ({ api }) => { await api.listProjects(); }, { fetch: businessFetch });
    expect(new Headers(businessFetch.mock.calls[0]![1]!.headers).get("Authorization")).toBe(`Bearer ${token.access_token}`);
  });

  it.each([undefined, 60, 2592000])("accepts an omitted or finite token expiry without adding local expiry state: %j", async (expiresIn) => {
    const { context, paths } = await fixture();
    const response = { access_token: token.access_token, token_type: "Bearer", ...(expiresIn === undefined ? {} : { expires_in: expiresIn }) };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(authorization())).mockResolvedValueOnce(json(response));
    await runLoginCommand(["--no-browser"], context, { fetch, wait: immediateWait });
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ serverToken: token.access_token });
    const businessFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ items: [], nextCursor: null }));
    await runServerCommand(context, async ({ api }) => { await api.listProjects(); }, { fetch: businessFetch });
    expect(new Headers(businessFetch.mock.calls[0]![1]!.headers).get("Authorization")).toBe(`Bearer ${token.access_token}`);
  });

  it.each([null, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "2592000", true, {}, []])("rejects a present invalid token expiry while preserving existing credentials: %j", async (expiresIn) => {
    const original = "serverToken: existing-credential\n";
    const { context, paths } = await fixture(original);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(authorization())).mockResolvedValueOnce(json({ ...token, expires_in: expiresIn }));
    await expect(runLoginCommand(["--no-browser"], context, { fetch, wait: immediateWait })).rejects.toThrow("Invalid device authorization response.");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(paths.configFile, "utf8")).toBe(original);
  });

  it("supports another-device login and continues when opening a browser fails", async () => {
    for (const noBrowser of [false, true]) {
      const { context } = await fixture();
      const openBrowser = vi.fn(async () => { throw new Error("No browser installed"); });
      await runLoginCommand(noBrowser ? ["--no-browser"] : [], context, { fetch: successFetch(), openBrowser, wait: immediateWait });
      expect(openBrowser).toHaveBeenCalledTimes(noBrowser ? 0 : 1);
      expect(vi.mocked(context.stderr).mock.calls.flat().join("")).toContain("Logged in to https://daynight.cc");
    }
  });

  it.each(["access_denied", "expired_token", "invalid_grant", "invalid_client"])("exposes terminal authorization failure and preserves existing credentials: %s", async (error) => {
    const original = "# existing\nserverToken: existing-credential\n";
    const { context, paths } = await fixture(original);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(authorization())).mockResolvedValueOnce(json({ error, error_description: "private-device-secret" }, 400));
    const failure = await runLoginCommand(["--no-browser"], context, { fetch, wait: immediateWait }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("private-device-secret");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(paths.configFile, "utf8")).toBe(original);
    expect(context.stdout).not.toHaveBeenCalled();
  });

  it("does not replay an exchange after losing its successful response", async () => {
    const { context, paths } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(authorization())).mockRejectedValueOnce(new Error("Connection lost"));
    await expect(runLoginCommand(["--no-browser"], context, { fetch, wait: immediateWait })).rejects.toThrow("Connection lost");
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(readFile(paths.configFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("doubles the polling interval after request timeouts while preserving the device deadline", async () => {
    const { context } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(authorization()))
      .mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); }))
      .mockResolvedValueOnce(json(token));
    const wait = immediateWait.mockClear();
    await runLoginCommand(["--no-browser"], context, { fetch, wait, limits: { requestMs: 10 } });
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([5000, 10000]);
    expect(vi.mocked(context.stderr).mock.calls.flat().join("")).toContain("request timed out");
  });

  it("reports creation request timeout distinctly and sends no polling request", async () => {
    const { context } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); }));
    await expect(runLoginCommand(["--no-browser"], context, { fetch, limits: { requestMs: 10 } })).rejects.toThrow("HTTP request timed out");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels pending authorization without saving or polling again", async () => {
    const { context, paths } = await fixture();
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(authorization()));
    await expect(runLoginCommand(["--no-browser"], context, { fetch, signal: controller.signal, wait: async (_ms, signal) => { controller.abort(new Error("Cancelled by test")); signal.throwIfAborted(); } })).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readFile(paths.configFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds pending login with an independent deadline and leaves configuration untouched", async () => {
    const { context, paths } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(authorization()));
    await expect(runLoginCommand(["--no-browser"], context, { fetch, limits: { totalMs: 30 } })).rejects.toThrow("Device login deadline exceeded");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readFile(paths.configFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports grant expiry explicitly when it expires during the polling wait", async () => {
    const { context, paths } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ...authorization(), expires_in: 1 }));
    await expect(runLoginCommand(["--no-browser"], context, { fetch })).rejects.toThrow("Device authorization expired. Run daynight login again.");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readFile(paths.configFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("merges concurrent review edits but refuses changed origin or credential", async () => {
    for (const concurrent of ["# review\npollIntervalMs: 2000\n", "serverUrl: https://test.example\n", "serverToken: another-login\n"]) {
      const { context, paths } = await fixture("# initial\n{}\n");
      const fetch = successFetch();
      const login = runLoginCommand(["--no-browser"], context, { fetch, wait: async () => { await writeFile(paths.configFile, concurrent); } });
      if (concurrent.startsWith("# review")) {
        await login;
        const source = await readFile(paths.configFile, "utf8");
        expect(source).toContain("# review");
        expect(parse(source)).toEqual({ pollIntervalMs: 2000, serverToken: token.access_token });
      } else {
        await expect(login).rejects.toThrow("configuration changed");
        expect(await readFile(paths.configFile, "utf8")).toBe(concurrent);
      }
    }
  });

  it.each([
    { verification_uri: "https://evil.example/device" },
    { verification_uri_complete: "https://evil.example/device?user_code=BCDFG-HJKLM" },
    { verification_uri: "https://daynight.cc/api/v1/projects" },
    { verification_uri: "not-a-url/private-device-secret" },
    { verification_uri_complete: "https://daynight.cc/device?user_code=OTHER-CODE" },
    { verification_uri_complete: "https://daynight.cc/device?user_code=BCDFG-HJKLM&device_code=secret" },
    { interval: 0 }, { expires_in: -1 }, { device_code: "" }, { user_code: "unsafe\ncode" },
  ])("rejects an invalid authorization response before opening a browser: %j", async (override) => {
    const { context } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...authorization(), ...override }));
    const openBrowser = vi.fn(async () => {});
    await expect(runLoginCommand([], context, { fetch, openBrowser, wait: immediateWait })).rejects.toThrow();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds cleanup when an oversized response refuses cancellation", async () => {
    const { context } = await fixture();
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => { controller.enqueue(new Uint8Array(65_537)); },
      cancel: async () => new Promise<void>(() => {}),
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    await expect(runLoginCommand(["--no-browser"], context, { fetch })).rejects.toThrow("response cleanup failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects insecure origins, redirects, malformed and oversized responses", async () => {
    const insecure = await fixture("serverUrl: http://remote.example\n");
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(runLoginCommand([], insecure.context, { fetch })).rejects.toThrow("HTTPS");
    expect(fetch).not.toHaveBeenCalled();
    for (const response of [new Response(null, { status: 307, headers: { Location: "https://evil.example" } }), new Response("not JSON"), new Response("x".repeat(65537))]) {
      const { context } = await fixture();
      const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      await expect(runLoginCommand(["--no-browser"], context, { fetch: transport })).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
});

describe("explicit logout", () => {
  it.each([204, 401])("revokes the current credential and clears local state after HTTP %s", async (status) => {
    const { context, paths } = await fixture("# settings\npollIntervalMs: 2000\nserverToken: current-credential\n");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status }));
    await runLogoutCommand([], context, { fetch });
    expect(String(fetch.mock.calls[0]![0])).toBe("https://daynight.cc/api/v1/auth/device/logout");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store" });
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("Authorization")).toBe("Bearer current-credential");
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ pollIntervalMs: 2000 });
    expect(await readFile(paths.configFile, "utf8")).toContain("# settings");
    expect(await loadServerConfiguration(paths)).toEqual({ serverUrl: "https://daynight.cc" });
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
    expect(context.stdout).not.toHaveBeenCalled();
  });

  it("already logged out performs no network or file writes", async () => {
    const { root, context } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    await runLogoutCommand([], context, { fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["failure", "refused"])("keeps local credentials and does not retry an uncertain or refused revocation: %s", async (kind) => {
    const original = "serverToken: current-credential\n";
    const { context, paths } = await fixture(original);
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (kind === "failure") fetch.mockRejectedValue(new Error("Connection lost"));
    else fetch.mockResolvedValue(json({ error: { code: "forbidden" } }, 403));
    await expect(runLogoutCommand([], context, { fetch })).rejects.toThrow("did not confirm revocation");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(paths.configFile, "utf8")).toBe(original);
  });

  it("preserves a concurrent login credential even after revoking the observed one", async () => {
    const { context, paths } = await fixture("serverToken: observed-credential\n");
    const concurrent = "serverToken: replacement-credential\n";
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => { await writeFile(paths.configFile, concurrent); return new Response(null, { status: 204 }); });
    await expect(runLogoutCommand([], context, { fetch })).rejects.toThrow("configuration changed");
    expect(await readFile(paths.configFile, "utf8")).toBe(concurrent);
  });
});
