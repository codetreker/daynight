import { expect, test, vi } from "vitest";
import { CodexReadAuthority } from "../../../src/commands/controller/providers/codex-read-authority.js";
import type { NativeReadPolicy } from "../../../src/commands/controller/providers/types.js";
import type { LocalImageCheckpoint } from "../../../src/commands/controller/markdown/local-source-proof.js";

const cwd = "/work", nativeSessionId = "native-thread";
const startup = () => ({
  initialized: { userAgent: "daynight/0.167.0 (Linux; x86_64) (daynight; 0.22.0)" },
  remoteControl: { status: "disabled", serverName: "host", installationId: "installation", environmentId: null },
  response: { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, activePermissionProfile: null,
    thread: { id: nativeSessionId, sessionId: nativeSessionId, cwd, environments: [{ environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] }] } },
  nativeSessionId, nativeCwd: cwd,
});
const hooks = (items: unknown[] = []) => ({ data: [{ cwd, hooks: items, warnings: [], errors: [] }] });
const hook = (patch: Record<string, unknown> = {}) => ({
  key: "hook", eventName: "preToolUse", handlerType: "command", command: "check", async: false, matcher: "^Bash$", timeoutSec: 600,
  statusMessage: null, additionalContextLimit: null, sourcePath: "/hooks.json", source: "user", pluginId: null, environmentId: null,
  displayOrder: 0, enabled: true, isManaged: false, currentHash: "sha256:hash", trustStatus: "untrusted", ...patch,
});
const checkpoint = (stage: LocalImageCheckpoint["stage"] = "initial"): LocalImageCheckpoint => {
  const root = { kind: "posix" as const, dev: "1", ino: "2" }, object = { ...root, ino: "3" };
  return { stage, proof: { requested: { locator: "./image.png", path: "/work/image.png" }, root: { cwd, identity: root, traversal: [] },
    traversal: stage === "initial" ? [] : [{ kind: "open", parent: root, name: "image.png", object, directory: false }], opened: stage === "initial" ? null : object } };
};
const setup = (request = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => hooks()), drain = vi.fn(async () => {})) => {
  const published: (NativeReadPolicy | null)[] = [];
  const authority = new CodexReadAuthority({ cwd, request, drain, publish: policy => published.push(policy) });
  authority.install(startup());
  const policy = published.at(-1)!;
  expect(policy).not.toBeNull();
  return { authority, policy, published, request, drain };
};

test("Codex authorizes each source checkpoint against the live native thread without caching empty hooks", async () => {
  const { policy, request } = setup();
  expect(policy).toMatchObject({ cwd, nativeSessionId });
  expect(policy.revision).toMatch(/^codex:0\.167\.0:[a-f0-9-]{36}:1$/);
  expect(policy.verify()).toBeUndefined();
  for (const stage of ["initial", "opened", "block", "block", "final"] as const) await policy.authorizeCheckpoint(checkpoint(stage));
  expect(request.mock.calls).toEqual(Array.from({ length: 5 }, () => ["hooks/list", { threadId: nativeSessionId }]));
  request.mockResolvedValue(hooks([hook()]));
  await expect(policy.authorizeCheckpoint(checkpoint("block"))).rejects.toMatchObject({ code: "source_forbidden" });
  expect(() => policy.verify()).toThrow();
});

test.each([
  { name: "unknown native version", change: (value: ReturnType<typeof startup>) => { value.initialized.userAgent = "daynight/0.168.0 (Linux)"; } },
  { name: "missing native version", change: (value: ReturnType<typeof startup>) => { value.initialized.userAgent = ""; } },
  { name: "remote client", change: (value: ReturnType<typeof startup>) => { value.remoteControl.status = "connected"; } },
  { name: "remote environment", change: (value: ReturnType<typeof startup>) => { Object.assign(value.remoteControl, { environmentId: "remote" }); } },
  { name: "approval prompt", change: (value: ReturnType<typeof startup>) => { value.response.approvalPolicy = "on-request"; } },
  { name: "restricted sandbox", change: (value: ReturnType<typeof startup>) => { value.response.sandbox.type = "workspaceWrite"; } },
  { name: "unknown sandbox restriction", change: (value: ReturnType<typeof startup>) => { Object.assign(value.response.sandbox, { deny: ["/secret"] }); } },
  { name: "named permission profile", change: (value: ReturnType<typeof startup>) => { Object.assign(value.response, { activePermissionProfile: { id: "profile" } }); } },
  { name: "missing permission provenance", change: (value: ReturnType<typeof startup>) => { Reflect.deleteProperty(value.response, "activePermissionProfile"); } },
  { name: "foreign session", change: (value: ReturnType<typeof startup>) => { value.response.thread.id = "another"; } },
  { name: "foreign session tree", change: (value: ReturnType<typeof startup>) => { value.response.thread.sessionId = "parent"; } },
  { name: "changed working directory", change: (value: ReturnType<typeof startup>) => { value.response.cwd = "/elsewhere"; } },
  { name: "unknown environment", change: (value: ReturnType<typeof startup>) => { value.response.thread.environments[0]!.environmentId = "owner"; } },
  { name: "extra environment", change: (value: ReturnType<typeof startup>) => { value.response.thread.environments.push(value.response.thread.environments[0]!); } },
  { name: "unknown environment roots", change: (value: ReturnType<typeof startup>) => { value.response.thread.environments[0]!.runtimeWorkspaceRoots = []; } },
])("Codex leaves $name without local read authority", ({ change }) => {
  const publish = vi.fn(), request = vi.fn();
  const authority = new CodexReadAuthority({ cwd, request, publish });
  const value = startup(); change(value); authority.install(value);
  expect(publish.mock.calls.every(([policy]) => policy === null)).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

test.each([
  { name: "enabled PreToolUse", result: hooks([hook()]) },
  { name: "unknown hook event", result: hooks([hook({ eventName: "futureEvent", enabled: false })]) },
  { name: "unknown source", result: hooks([hook({ source: "unknown", enabled: false })]) },
  { name: "unknown handler", result: hooks([hook({ handlerType: "future", enabled: false })]) },
  { name: "unknown metadata", result: hooks([hook({ newPolicy: true, enabled: false })]) },
  { name: "missing enabled flag", result: hooks([{ eventName: "preToolUse" }]) },
  { name: "warnings", result: { data: [{ cwd, hooks: [], warnings: ["unreadable"], errors: [] }] } },
  { name: "errors", result: { data: [{ cwd, hooks: [], warnings: [], errors: [{ path: "hooks.json", message: "unreadable" }] }] } },
  { name: "wrong cwd", result: { data: [{ cwd: "/elsewhere", hooks: [], warnings: [], errors: [] }] } },
  { name: "missing errors", result: { data: [{ cwd, hooks: [], warnings: [] }] } },
  { name: "unknown envelope", result: { ...hooks(), cursor: "next" } },
  { name: "multiple entries", result: { data: [...hooks().data, ...hooks().data] } },
])("Codex rejects $name at a checkpoint", async ({ result }) => {
  const { policy } = setup(vi.fn(async () => result));
  await expect(policy.authorizeCheckpoint(checkpoint())).rejects.toMatchObject({ code: "source_forbidden" });
});

test("known inactive or unrelated hooks do not require changing user hook configuration", async () => {
  const { policy } = setup(vi.fn(async () => hooks([hook({ enabled: false }), hook({ eventName: "postToolUse" })])));
  await expect(policy.authorizeCheckpoint(checkpoint())).resolves.toBeUndefined();
});

test("an in-flight native hooks response cannot restore invalidated authority", async () => {
  let resolve!: (value: unknown) => void;
  const { authority, policy, published } = setup(vi.fn(() => new Promise<unknown>(done => { resolve = done; })));
  const pending = policy.authorizeCheckpoint(checkpoint());
  authority.invalidate(); expect(published.at(-1)).toBeNull();
  expect(() => policy.verify()).toThrow();
  resolve(hooks()); await expect(pending).rejects.toMatchObject({ code: "source_forbidden" });
  authority.install(startup()); expect(published.at(-1)).toBeNull();
});

test.each(["thread/settings/update", "thread/resume", "environment/add", "config/value/write", "future/mutation"])("%s closes and drains the writer before native mutation", async method => {
  let drained!: () => void;
  const { authority, policy, request, drain } = setup(vi.fn(async () => ({})), vi.fn(() => new Promise<void>(done => { drained = done; })));
  const pending = authority.request(method, { threadId: nativeSessionId, sandboxPolicy: { type: "readOnly" } });
  expect(() => policy.verify()).toThrow(); expect(drain).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
  drained(); await pending;
  expect(request).toHaveBeenCalledWith(method, { threadId: nativeSessionId, sandboxPolicy: { type: "readOnly" } });
  expect(() => policy.verify()).toThrow();
});

test("safe model controls and input keep authority while injected per-turn permissions close it", async () => {
  const { authority, policy, drain } = setup();
  await authority.request("thread/settings/update", { threadId: nativeSessionId, model: "model", effort: "high" });
  await authority.request("turn/start", { threadId: nativeSessionId, input: [], clientUserMessageId: "operation", effort: "high" });
  expect(policy.verify()).toBeUndefined(); expect(drain).not.toHaveBeenCalled();
  await authority.request("turn/start", { threadId: nativeSessionId, input: [], sandboxPolicy: { type: "readOnly" } });
  expect(() => policy.verify()).toThrow(); expect(drain).toHaveBeenCalledTimes(1);
});

test.each([
  ["remoteControl/status/changed", { status: "connected" }],
  ["thread/settings/updated", { threadId: nativeSessionId, threadSettings: { cwd, sandboxPolicy: { type: "readOnly" } } }],
  ["thread/environment/connected", { threadId: nativeSessionId }],
  ["thread/environment/disconnected", { threadId: nativeSessionId }],
  ["thread/closed", { threadId: nativeSessionId }],
  ["error", { threadId: nativeSessionId }],
])("%s synchronously invalidates the published policy", (method, params) => {
  const { authority, policy, published } = setup();
  authority.observe(method as string, params);
  expect(() => policy.verify()).toThrow(); expect(published.at(-1)).toBeNull();
});

test("foreign thread settings cannot invalidate this session and safe native snapshots do not reopen a closed policy", () => {
  const { authority, policy } = setup();
  authority.observe("thread/settings/updated", { threadId: "other", threadSettings: { sandboxPolicy: { type: "readOnly" } } });
  authority.observe("thread/settings/updated", { threadId: nativeSessionId, threadSettings: { cwd, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null } });
  expect(policy.verify()).toBeUndefined();
  authority.invalidate();
  authority.observe("remoteControl/status/changed", { status: "disabled" });
  expect(() => policy.verify()).toThrow();
});

test("a checkpoint from another working directory is rejected before contacting native hooks", async () => {
  const { policy, request } = setup();
  const value = checkpoint();
  await expect(policy.authorizeCheckpoint({ ...value, proof: { ...value.proof, root: { ...value.proof.root, cwd: "/other" } } })).rejects.toMatchObject({ code: "source_forbidden" });
  expect(request).not.toHaveBeenCalled();
});

test.each(["thread/settings/updated", "thread/environment/connected", "thread/closed", "error"])("a startup %s notification cannot be overwritten by an older startup receipt", method => {
  const publish = vi.fn(), request = vi.fn();
  const authority = new CodexReadAuthority({ cwd, request, publish });
  authority.observe(method, { threadId: nativeSessionId, threadSettings: { cwd, sandboxPolicy: { type: "readOnly" } } });
  authority.install(startup());
  expect(publish.mock.calls.every(([policy]) => policy === null)).toBe(true);
});

test("failed native checkpoint queries invalidate the policy without retrying", async () => {
  const { policy, request, published } = setup(vi.fn(async () => { throw new Error("native response unavailable"); }));
  await expect(policy.authorizeCheckpoint(checkpoint())).rejects.toMatchObject({ code: "source_forbidden" });
  expect(published.at(-1)).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
});

test("a failed writer drain keeps native permission mutation unsent", async () => {
  const { authority, policy, request } = setup(vi.fn(async () => ({})), vi.fn(async () => { throw new Error("writer not joined"); }));
  await expect(authority.request("thread/settings/update", { threadId: nativeSessionId, approvalPolicy: "on-request" })).rejects.toThrow("writer not joined");
  expect(() => policy.verify()).toThrow(); expect(request).not.toHaveBeenCalled();
});
