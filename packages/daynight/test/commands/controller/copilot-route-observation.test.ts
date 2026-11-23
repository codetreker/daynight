import { afterEach, expect, test, vi } from "vitest";
import { CopilotRouteObserver, declaredCopilotRouteDigest, parseCopilotRouteObservation } from "../../../src/commands/controller/providers/copilot-route-observation.js";
import { createHash } from "node:crypto";
import { canonicalImageJson } from "../../../src/session/image-values.js";

vi.mock("node:timers", async original => {
  const actual = await original<typeof import("node:timers")>();
  return { ...actual, default: {
    setTimeout: (callback: () => void, milliseconds: number) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (timer: NodeJS.Timeout) => globalThis.clearTimeout(timer),
  } };
});

const endpoint = { type: "openai", wireApi: "responses", transport: "http", baseUrl: "https://api.enterprise.githubcopilot.com" };
afterEach(() => vi.useRealTimers());
const fixture = () => {
  const getCurrent = vi.fn(async () => ({ modelId: "fixture-model" }));
  const getEndpoint = vi.fn(async (): Promise<unknown> => endpoint);
  return { sessionId: "session", rpc: { model: { getCurrent }, provider: { getEndpoint } } };
};

test("route hashing never accesses credentials and distinguishes visible routing fields", () => {
  const secret = { ...endpoint };
  for (const key of ["apiKey", "headers", "sessionToken"]) Object.defineProperty(secret, key, { get() { throw new Error("secret-canary"); } });
  const digest = declaredCopilotRouteDigest(secret, "model");
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(digest).toBe(declaredCopilotRouteDigest({ ...endpoint, apiKey: "different" }, "model"));
  for (const patch of [{ type: "azure" }, { wireApi: "completions" }, { transport: "websockets" }, { baseUrl: "https://other.example" }]) expect(declaredCopilotRouteDigest({ ...endpoint, ...patch }, "model")).not.toBe(digest);
  expect(declaredCopilotRouteDigest(endpoint, "another-model")).not.toBe(digest);
});

test("an omitted transport hashes as an undeclared value without borrowing HTTP or WebSocket identity", async () => {
  const { transport: _transport, ...undeclared } = endpoint;
  for (const key of ["apiKey", "headers", "sessionToken"]) Object.defineProperty(undeclared, key, { get() { throw new Error("secret-canary"); } });
  const digest = declaredCopilotRouteDigest(undeclared, "fixture-model");
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(declaredCopilotRouteDigest({ ...endpoint, transport: undefined }, "fixture-model")).toBe(digest);
  for (const transport of ["http", "websockets"]) {
    const declared = { ...endpoint, transport };
    const previous = createHash("sha256").update(canonicalImageJson({ kind: "native_declared_route_v1", type: declared.type, wireApi: declared.wireApi, transport, endpoint: declared.baseUrl + "/", modelId: "fixture-model" })).digest("hex");
    expect(declaredCopilotRouteDigest(declared, "fixture-model")).not.toBe(digest);
    expect(declaredCopilotRouteDigest(declared, "fixture-model")).toBe(previous);
  }
  const session = fixture(); session.rpc.provider.getEndpoint.mockResolvedValue(undeclared);
  expect(await new CopilotRouteObserver().read(session)).toMatchObject({ backendIdentity: digest, modelId: "fixture-model" });
});

test.each([
  { type: "unknown" }, { type: { toString: (): string => "openai" } }, { wireApi: undefined }, { transport: "websocket" }, { transport: null }, { transport: 1 },
  ...["http://example.com", "https://user:secret@example.com", "https://example.com?key=secret", "https://example.com#secret", "https://example.com/a%2fb", "https://example.com/../x?key=secret", " https://example.com", "https://example.com/a\\b"].map(baseUrl => ({ baseUrl })),
])("unsafe or unknown route remains unknown: %j", patch => {
  expect(declaredCopilotRouteDigest({ ...endpoint, ...patch }, "model")).toBeNull();
});

test("observation binds the current model before and after the default endpoint RPC", async () => {
  const session = fixture(), observer = new CopilotRouteObserver();
  const observed = await observer.read(session);
  expect(observed).toMatchObject({ kind: "native_declared_route_v1", modelId: "fixture-model", sessionId: "session", generation: 1 });
  expect(session.rpc.provider.getEndpoint).toHaveBeenCalledWith();
  expect(session.rpc.model.getCurrent).toHaveBeenCalledTimes(2);
  expect(observer.matches(observed, "session")).toBe(true);
  expect(observer.matches(observed, "other-session")).toBe(false);
  const next = await observer.read(session);
  expect(next?.backendIdentity).toBe(observed?.backendIdentity);
  expect(observer.matches(observed, "session")).toBe(false);
  expect(observer.matches(next, "session")).toBe(true);
  observer.invalidate(); expect(observer.matches(next, "session")).toBe(false);
});

test("a model change during the endpoint read cannot produce a snapshot", async () => {
  const session = fixture(), observer = new CopilotRouteObserver();
  session.rpc.model.getCurrent.mockResolvedValueOnce({ modelId: "before" }).mockResolvedValueOnce({ modelId: "after" });
  expect(await observer.read(session)).toBeNull();
});

test.each(["invalidate", "concurrent", "error"])("observation cannot survive %s during native read", async mode => {
  const session = fixture(), observer = new CopilotRouteObserver();
  let finish!: (value: unknown) => void;
  session.rpc.provider.getEndpoint.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = observer.read(session);
  await vi.waitFor(() => expect(session.rpc.provider.getEndpoint).toHaveBeenCalledOnce());
  if (mode === "invalidate") observer.invalidate();
  if (mode === "concurrent") expect(await observer.read(session)).toBeNull();
  finish(mode === "error" ? { ...endpoint, baseUrl: "https://example.com?key=secret-canary" } : endpoint);
  const result = await pending;
  if (mode !== "concurrent") expect(result).toBeNull(); else expect(result).not.toBeNull();
});

test("endpoint errors never escape with native credentials", async () => {
  const session = fixture(), observer = new CopilotRouteObserver();
  const prior = await observer.read(session);
  session.rpc.provider.getEndpoint.mockRejectedValueOnce(new Error("apiKey=secret-canary"));
  await expect(observer.read(session)).resolves.toBeNull();
  expect(observer.matches(prior, "session")).toBe(false);
});

test.each(["model", "endpoint"])("a timed-out %s read retains one pending RPC and cannot revive its observation", async stage => {
  vi.useFakeTimers();
  const session = fixture(), observer = new CopilotRouteObserver();
  let release!: (value: any) => void;
  if (stage === "model") session.rpc.model.getCurrent.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  else session.rpc.provider.getEndpoint.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = observer.read(session); await Promise.resolve();
  let settled = false;
  void pending.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBeNull();
  for (let i = 0; i < 5; i++) expect(await observer.read(session)).toBeNull();
  expect(session.rpc.model.getCurrent).toHaveBeenCalledTimes(1);
  expect(session.rpc.provider.getEndpoint).toHaveBeenCalledTimes(stage === "model" ? 0 : 1);
  release(stage === "model" ? { modelId: "fixture-model" } : endpoint);
  await vi.advanceTimersByTimeAsync(0);
  expect(session.rpc.model.getCurrent).toHaveBeenCalledTimes(1);
  expect(session.rpc.provider.getEndpoint).toHaveBeenCalledTimes(stage === "model" ? 0 : 1);
  const fresh = await observer.read(session); expect(fresh).not.toBeNull();
  expect(observer.matches(fresh, "session")).toBe(true);
});

test("bridge observation decoding discards arbitrary fields and rejects wrong bindings", () => {
  const value = { kind: "native_declared_route_v1", sessionId: "session", modelId: "model", backendIdentity: "a".repeat(64), generation: 1, apiKey: "secret-canary" };
  expect(JSON.stringify(parseCopilotRouteObservation(value, "session"))).not.toContain("secret-canary");
  expect(parseCopilotRouteObservation(value, "other")).toBeNull();
  expect(parseCopilotRouteObservation({ ...value, generation: 0 }, "session")).toBeNull();
});
