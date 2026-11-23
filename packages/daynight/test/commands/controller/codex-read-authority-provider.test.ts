import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import { textNativeInput } from "../../../src/commands/controller/providers/native-input.js";
import type { NativeReadPolicy, NativeProvider, ProviderOptions, ProviderState } from "../../../src/commands/controller/providers/types.js";
import type { LocalImageCheckpoint } from "../../../src/commands/controller/markdown/local-source-proof.js";

let home: string;
const providers: NativeProvider[] = [];
beforeEach(async () => { const root = join(process.cwd(), ".tmp"); await mkdir(root, { recursive: true }); home = await mkdtemp(join(root, "codex-read-authority-")); });
afterEach(async () => { await Promise.all(providers.splice(0).map(provider => provider.close())); await rm(home, { recursive: true, force: true }); });
const checkpoint = (): LocalImageCheckpoint => ({ stage: "initial", proof: { requested: { locator: "./image.png", path: join(process.cwd(), "image.png") }, root: { cwd: process.cwd(), identity: { kind: "posix", dev: "1", ino: "2" }, traversal: [] }, traversal: [], opened: null } });
const requests = async (): Promise<{ method: string; params: Record<string, unknown> }[]> => (await readFile(join(home, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const open = async (overrides: Partial<ProviderOptions> = {}, scenario = "") => {
  const policies: (NativeReadPolicy | null)[] = [], states: ProviderState[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    executable: fileURLToPath(new URL("./fixtures/codex-read-authority-native.mjs", import.meta.url)),
    env: { ...process.env, CODEX_HOME: home, CODEX_AUTHORITY_CASE: scenario, CODEX_AUTHORITY_LOG: join(home, "requests.jsonl") },
    onSpawn: () => {}, onTimeline: () => {}, onState: state => states.push(state), onNativeReadPolicy: policy => policies.push(policy), ...overrides });
  providers.push(provider); return { provider, policies, states };
};

test.each(["started-before-install", "started-after-install"])("normal Codex %s notification preserves the published local Read policy", async scenario => {
  const { provider, policies } = await open({}, scenario);
  const policy = policies.at(-1)!;
  expect(policy).not.toBeNull();
  expect(policy.nativeSessionId).toBe(provider.nativeSessionId);
  expect(policy.verify()).toBeUndefined();
  await expect(policy.authorizeCheckpoint(checkpoint())).resolves.toBeUndefined();
  expect(policies.at(-1)).toBe(policy);
});

test("the live Codex adapter publishes native authority before projecting resumed Markdown", async () => {
  const published: (NativeReadPolicy | null)[] = [], observed: boolean[] = [];
  const { provider } = await open({ resumeNativeSessionId: "authority-thread", unattended: true,
    onNativeReadPolicy: policy => published.push(policy),
    onTimeline: entry => { if (entry.kind === "assistant_message") observed.push(published.at(-1)?.verify() === undefined && Boolean(published.at(-1))); } });
  expect(observed).toEqual([true]);
  const policy = published.at(-1)!; expect(policy).toMatchObject({ nativeSessionId: provider.nativeSessionId, cwd: process.cwd() });
  await policy.authorizeCheckpoint(checkpoint()); await policy.authorizeCheckpoint(checkpoint());
  const calls = await requests();
  expect(calls.filter(call => call.method === "hooks/list")).toHaveLength(2);
  expect(calls.find(call => call.method === "thread/resume")?.params).not.toHaveProperty("sandbox");
  expect(calls.find(call => call.method === "thread/resume")?.params).not.toHaveProperty("approvalPolicy");
});

test.each(["version", "restricted", "remote", "startup-restrict"])("Codex %s keeps the session available without granting local reads", async scenario => {
  const { policies } = await open({}, scenario);
  expect(policies.length).toBeGreaterThan(0);
  expect(policies.every(policy => policy === null)).toBe(true);
  expect((await requests()).some(call => call.method === "hooks/list")).toBe(false);
});

test("a restriction after startup installation revokes the issued policy before any checkpoint", async () => {
  const { provider, policies, states } = await open({}, "startup-restrict-after-install");
  const issued = policies.filter((policy): policy is NativeReadPolicy => policy !== null);
  expect(issued).toHaveLength(1);
  expect(policies.at(-1)).toBeNull();
  expect(provider.nativeSessionId).toBe("authority-thread");
  expect(states.at(-1)?.capabilities.send).toBe(true);
  expect(() => issued[0]!.verify()).toThrow();
  await expect(issued[0]!.authorizeCheckpoint(checkpoint())).rejects.toMatchObject({ code: "source_forbidden" });
  expect((await requests()).some(call => call.method === "hooks/list")).toBe(false);
});

test("Codex without a native Read consumer does not start authority probes", async () => {
  await open({ onNativeReadPolicy: undefined } as unknown as Partial<ProviderOptions>);
  expect((await requests()).filter(call => ["hooks/list", "remoteControl/status/read"].includes(call.method))).toEqual([]);
});

test("native settings mutation waits for source writers after synchronous policy revocation", async () => {
  let release!: () => void;
  const drain = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const { provider, policies, states } = await open({ drainNativeReadPolicy: drain });
  const policy = policies.at(-1)!;
  const pending = provider.setSetting!("sandbox", "readOnly", "operation", states.at(-1)!.controls!.revision);
  void pending.catch(() => {});
  expect(() => policy.verify()).toThrow(); expect(policies.at(-1)).toBeNull();
  expect(drain).toHaveBeenCalledTimes(1);
  expect((await requests()).some(call => call.method === "thread/settings/update")).toBe(false);
  release(); await pending; drain.mockResolvedValue(undefined);
  expect((await requests()).some(call => call.method === "thread/settings/update")).toBe(true);
  expect(() => policy.verify()).toThrow();
});

test("accounting failure during Read authority drain prevents native settings dispatch", async () => {
  let release!: () => void, fenced = false;
  const failure = new Error("accounting failure");
  const drain = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const { provider, policies, states } = await open({ drainNativeReadPolicy: drain, assertNativeDispatch: () => { if (fenced) throw failure; } });
  const policy = policies.at(-1)!;
  const pending = provider.setSetting!("sandbox", "readOnly", "operation", states.at(-1)!.controls!.revision);
  const rejected = expect(pending).rejects.toBe(failure);
  expect(drain).toHaveBeenCalledTimes(1); expect(() => policy.verify()).toThrow();
  fenced = true; release(); drain.mockResolvedValue(undefined);
  await rejected;
  expect((await requests()).some(call => call.method === "thread/settings/update")).toBe(false);
});

test("model changes retain the same native Read permission after full native settings confirmation", async () => {
  const { provider, policies, states } = await open();
  const policy = policies.at(-1)!;
  await provider.setSetting!("model", "other-model", "model-operation", states.at(-1)!.controls!.revision);
  expect(policy.verify()).toBeUndefined();
  expect(policies.at(-1)).toBe(policy);
});

test.each(["restrict", "remote", "invalid-frame"])("native %s invalidates the previously issued policy", async text => {
  const { provider, policies } = await open();
  const policy = policies.at(-1)!;
  await provider.send(textNativeInput(text), "operation", null);
  await vi.waitFor(() => expect(policies.at(-1)).toBeNull());
  expect(() => policy.verify()).toThrow();
});

test("provider close revokes authority before joining its native transport", async () => {
  const { provider, policies } = await open(); const policy = policies.at(-1)!;
  const closing = provider.close();
  expect(() => policy.verify()).toThrow(); expect(policies.at(-1)).toBeNull();
  await closing;
});
