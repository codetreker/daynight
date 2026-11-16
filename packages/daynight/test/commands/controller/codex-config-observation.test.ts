import { afterEach, expect, test, vi } from "vitest";
import { CodexConfigObserver, declaredCodexConfiguration } from "../../../src/commands/controller/providers/codex-config-observation.js";

const configuration = (base_url = "https://gateway.example/v1", model = "default-model") => ({ config: { model, model_provider: "gateway", model_providers: { gateway: { base_url, wire_api: "responses", supports_websockets: true } } } });
const fixture = () => {
  const read = vi.fn(async (): Promise<unknown> => configuration());
  const observer = new CodexConfigObserver(read, "/work", {});
  const bind = async (model = "default-model") => { await observer.prepare({ cwd: "/work", model, config: { "features.default_mode_request_user_input": true } }); return observer.bind("thread", { model, modelProvider: "gateway", cwd: "/work" }); };
  return { read, observer, bind };
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("declared configuration excludes credentials and does not infer actual transport", () => {
  const value = configuration(), selected = value.config.model_providers.gateway;
  for (const key of ["apiKey", "http_headers", "env_http_headers", "experimental_bearer_token"]) Object.defineProperty(selected, key, { get() { throw new Error("secret-config-canary"); } });
  const result = declaredCodexConfiguration(value);
  expect(result).toMatchObject({ model: "default-model", modelProvider: "gateway", backendIdentity: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(result)).not.toMatch(/secret|https|transport/);
  expect(declaredCodexConfiguration(configuration("https://other.example"))?.backendIdentity).not.toBe(result!.backendIdentity);
  const noSockets = configuration(); noSockets.config.model_providers.gateway.supports_websockets = false;
  expect(declaredCodexConfiguration(noSockets)?.backendIdentity).not.toBe(result!.backendIdentity);
  const missingSockets = configuration(); delete (missingSockets.config.model_providers.gateway as Record<string, unknown>).supports_websockets;
  expect(declaredCodexConfiguration(missingSockets)?.backendIdentity).not.toBe(declaredCodexConfiguration(noSockets)?.backendIdentity);
});

test.each(["https://user:secret@example.test", "https://example.test?secret=1", "https://example.test/#secret", "https://example.test/a%2fb", "https://example.test/a\\b", "invalid"])("unsafe endpoint cannot establish identity: %s", endpoint => {
  expect(declaredCodexConfiguration(configuration(endpoint))).toBeNull();
});
test.each([null, {}, { config: {} }, { config: { model: "model", model_provider: "gateway", model_providers: { gateway: { wire_api: "unknown", base_url: "https://example.test" } } } }])("missing or unsupported configuration remains unknown: %j", value => {
  expect(declaredCodexConfiguration(value)).toBeNull();
});

test("explicit start model is confirmed against the thread rather than the global default", async () => {
  const f = fixture(), result = await f.bind("selected-model");
  expect(result).toMatchObject({ nativeSessionId: "thread", model: "selected-model", modelProvider: "gateway" });
  expect(f.observer.matches(result)).toBe(true);
  expect(f.observer.matches(result && { ...result })).toBe(false);
  const refreshed = await f.observer.refresh({ model: "new-model", modelProvider: "gateway", cwd: "/work" });
  expect(refreshed?.backendIdentity).toBe(result?.backendIdentity);
  expect(refreshed?.model).toBe("new-model");
  expect(f.observer.matches(result)).toBe(false);
});

test.each([
  { cwd: "/other" }, { cwd: "/work", threadId: "old" }, { cwd: "/work", modelProvider: "other" },
  { cwd: "/work", config: { model_provider: "other" } }, { cwd: "/work", config: { "model_providers.gateway.base_url": "https://other.example" } },
])("unresolved start overrides cannot bind a thread: %j", async params => {
  const f = fixture(); await f.observer.prepare(params);
  expect(await f.observer.bind("thread", { model: "default-model", modelProvider: "gateway", cwd: "/work" })).toBeNull();
  expect(f.read).not.toHaveBeenCalled();
});
test("a model/provider mismatch and a changed route across thread creation remain unknown", async () => {
  for (const response of [{ model: "other", modelProvider: "gateway", cwd: "/work" }, { model: "default-model", modelProvider: "other", cwd: "/work" }]) {
    const f = fixture(); await f.observer.prepare({ cwd: "/work" }); expect(await f.observer.bind("thread", response)).toBeNull();
  }
  const f = fixture(); await f.observer.prepare({ cwd: "/work" }); f.read.mockResolvedValueOnce(configuration("https://changed.example"));
  expect(await f.observer.bind("thread", { model: "default-model", modelProvider: "gateway", cwd: "/work" })).toBeNull();
});

test("fresh configuration can restore the original route but cannot rebind an existing thread", async () => {
  const f = fixture(), original = await f.bind();
  f.read.mockResolvedValueOnce(configuration("https://changed.example"));
  expect(await f.observer.refresh({ model: "default-model", modelProvider: "gateway", cwd: "/work" })).toBeNull();
  expect(f.observer.matches(original)).toBe(false);
  const restored = await f.observer.refresh({ model: "default-model", modelProvider: "gateway", cwd: "/work" });
  expect(restored?.backendIdentity).toBe(original?.backendIdentity);
  f.observer.close();
  expect(await f.observer.refresh({ model: "default-model", modelProvider: "gateway", cwd: "/work" })).toBeNull();
});

test("raw native errors close observation without escaping secret diagnostics", async () => {
  const f = fixture(); await f.bind(); f.read.mockRejectedValueOnce(new Error("secret-config-canary"));
  await expect(f.observer.refresh({ model: "default-model", modelProvider: "gateway", cwd: "/work" })).resolves.toBeNull();
});
test.each(["OPENAI_BASE_URL", "OPENAI_API_BASE"])("unresolved environment override %s prevents observation", async key => {
  const read = vi.fn(), observer = new CodexConfigObserver(read, "/work", { [key]: "https://other.example" });
  await observer.prepare({ cwd: "/work" }); expect(read).not.toHaveBeenCalled();
});

test.each(["win32", "linux"])("environment route aliases follow %s native case semantics without changing the environment", async platform => {
  const host = Object.create(process); Object.defineProperty(host, "platform", { value: platform }); vi.stubGlobal("process", host);
  for (const key of ["openai_base_url", "OpenAi_Api_Base"]) {
    const environment = { [key]: "https://other.example" }, original = { ...environment };
    const read = vi.fn(async () => configuration()), observer = new CodexConfigObserver(read, "/work", environment);
    await observer.prepare({ cwd: "/work" });
    expect(read).toHaveBeenCalledTimes(platform === "win32" ? 0 : 1);
    expect(environment).toEqual(original);
  }
});
test("timed-out reads remain single pending and cannot revive a stale observation", async () => {
  const f = fixture(); await f.bind(); vi.useFakeTimers();
  let complete!: (value: unknown) => void;
  f.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const reading = f.observer.refresh({ model: "default-model", modelProvider: "gateway", cwd: "/work" });
  await vi.advanceTimersByTimeAsync(5000); expect(await reading).toBeNull();
  const count = f.read.mock.calls.length;
  expect(await f.observer.refresh({ model: "default-model", modelProvider: "gateway", cwd: "/work" })).toBeNull(); expect(f.read).toHaveBeenCalledTimes(count);
  complete(configuration()); await vi.advanceTimersByTimeAsync(0);
  const current = await f.observer.refresh({ model: "default-model", modelProvider: "gateway", cwd: "/work" }); expect(f.observer.matches(current)).toBe(true);
});
test("invalidation during an asynchronous configuration read rejects its result", async () => {
  const f = fixture(); await f.bind(); let complete!: (value: unknown) => void;
  f.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const pending = f.observer.refresh({ model: "default-model", modelProvider: "gateway", cwd: "/work" }); f.observer.invalidate(); complete(configuration()); expect(await pending).toBeNull();
});
