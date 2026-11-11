import { afterEach, expect, test } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotReadAuthority, copilotAuthorityProtocol, copilotRequestDigest } from "../../../src/commands/controller/providers/copilot-read-authority.js";
import { checkCopilotRead, copilotCorrelationKey, copilotSourcePath, type CopilotAuthorityNative } from "../../../src/commands/controller/providers/copilot-read-authority-check.js";
import type { LocalImageCheckpoint } from "../../../src/commands/controller/markdown/local-source-proof.js";
import type { NativeReadPolicy } from "../../../src/commands/controller/providers/types.js";
import { prepareCopilotAuthorityArtifacts } from "../../../src/commands/controller/providers/copilot-read-authority-artifacts.js";

const identity = (ino: string) => ({ kind: "posix" as const, dev: "1", ino });
const checkpoint = (name = "image.png"): LocalImageCheckpoint => ({ stage: "opened", proof: {
  requested: { locator: name, path: name }, root: { cwd: "/workspace", identity: identity("1"), traversal: [] },
  traversal: [{ kind: "open", parent: identity("1"), name, object: identity("2"), directory: false }], opened: identity("2"),
} });
function nativeFixture() {
  const calls: string[] = [];
  const state = { strict: { available: true, checks: [{ path: "/workspace/image.png", excluded: false }] } as unknown,
    route: { route: "result", result: { kind: "approved" } } as unknown, callbacks: [] as unknown[], hooks: [] as unknown[], cwd: "/workspace", mode: "manual" };
  const native: CopilotAuthorityNative = {
    sessionAuthMetadataJson: () => JSON.stringify({ type: "user", host: "https://github.com", login: "fixture" }),
    hookSessionSnapshot: async () => { calls.push("hooks"); return JSON.stringify({ sessionId: "session", cwd: state.cwd, hookCount: state.hooks.length, hooks: state.hooks, warnings: [], repositoryLoaded: true, repositoryDiagnostics: [] }); },
    hookProcessorCallbackRegistrations: () => { calls.push("callbacks"); return state.callbacks; },
    sessionInvokeJson: async (_id, method) => {
      calls.push(method);
      return JSON.stringify({ ok: true, result: method === "session.metadata.snapshot" ? { sessionId: "session", workingDirectory: state.cwd, isRemote: false } : method === "session.permissions.getMode" ? { mode: state.mode } : state.strict });
    },
    sessionRoutePermissionJson: async () => { calls.push("read"); return JSON.stringify(state.route); },
  };
  return { native, calls, state };
}
test("ordinary source proofs bind every component to the held root", () => {
  expect(copilotSourcePath(checkpoint(), "/workspace")).toBe("/workspace/image.png");
  for (const change of [
    (c: LocalImageCheckpoint) => ({ ...c, proof: { ...c.proof, requested: { locator: "image.png", path: "other.png" } } }),
    (c: LocalImageCheckpoint) => ({ ...c, proof: { ...c.proof, traversal: [{ ...c.proof.traversal[0], parent: identity("9") }] } }),
    (c: LocalImageCheckpoint) => ({ ...c, proof: { ...c.proof, requested: { locator: "image.png", path: "sub/../image.png" } } }),
    (c: LocalImageCheckpoint) => ({ ...c, proof: { ...c.proof, root: { ...c.proof.root, traversal: [{ kind: "link", parent: identity("1"), object: identity("2"), name: "root", target: "/workspace", relative: false }] } } }),
  ]) expect(() => copilotSourcePath(change(checkpoint()), "/workspace")).toThrow();
});
test("an unknown executable never activates the private ABI or creates a cache", async () => {
  const directory = await mkdtemp(fileURLToPath(new URL("../../../../../.tmp/copilot-unknown-", import.meta.url)));
  try {
    const executable = join(directory, "copilot"); await writeFile(executable, "unknown runtime");
    const diagnostics: string[] = [];
    expect(await prepareCopilotAuthorityArtifacts(executable, {}, message => diagnostics.push(message))).toBeUndefined();
    expect(diagnostics).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("native hooks, complete strict exclusion, and Read route precede a one-checkpoint grant", async () => {
  const { native, calls } = nativeFixture();
  await expect(checkCopilotRead(native, "session", "/workspace", checkpoint())).resolves.toBeUndefined();
  expect(calls).toEqual(["session.metadata.snapshot", "session.permissions.getMode", "hooks", "callbacks", "session.contentExclusion.checkPaths", "session.permissions.getMode", "read", "session.metadata.snapshot"]);
});
test.each(["unavailable", "excluded", "partial", "different-path", "handler", "deny", "callback", "hook", "cwd", "assisted"])("native %s never authorizes a source", async mode => {
  const { native, calls, state } = nativeFixture();
  if (mode === "unavailable") state.strict = { available: false, checks: [] };
  if (mode === "excluded") state.strict = { available: true, checks: [{ path: "/workspace/image.png", excluded: true }] };
  if (mode === "partial") state.strict = { available: true, checks: [] };
  if (mode === "different-path") state.strict = { available: true, checks: [{ path: "/workspace/other.png", excluded: false }] };
  if (mode === "handler") state.route = { route: "handler" };
  if (mode === "deny") state.route = { route: "result", result: { kind: "denied-by-rules" } };
  if (mode === "callback") state.callbacks = [{ source: "SDK" }];
  if (mode === "hook") state.hooks = [{ eventName: "preToolUse", specJson: JSON.stringify({ enabled: true }) }];
  if (mode === "cwd") state.cwd = "/different";
  if (mode === "assisted") state.mode = "assisted";
  await expect(checkCopilotRead(native, "session", "/workspace", checkpoint())).rejects.toMatchObject({ code: "source_forbidden" });
  if (!["handler", "deny"].includes(mode)) expect(calls).not.toContain("read");
});
test("a delayed mode read cannot authorize a mode changed to assisted", async () => {
  const { native, calls, state } = nativeFixture();
  const original = native.sessionInvokeJson;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  native.sessionInvokeJson = async (id, method, params) => { if (method === "session.permissions.getMode") await blocked; return original(id, method, params); };
  const pending = checkCopilotRead(native, "session", "/workspace", checkpoint());
  state.mode = "assisted"; release();
  await expect(pending).rejects.toThrow(); expect(calls).not.toContain("read");
});
test("a lifecycle hook is preserved while unknown hook events refuse", async () => {
  const { native, state } = nativeFixture();
  state.hooks = [{ eventName: "sessionStart", specJson: JSON.stringify({ eventName: "sessionStart", enabled: true }) }];
  await expect(checkCopilotRead(native, "session", "/workspace", checkpoint())).resolves.toBeUndefined();
  state.hooks = [{ eventName: "futureReadHook", specJson: JSON.stringify({ enabled: true }) }];
  await expect(checkCopilotRead(native, "session", "/workspace", checkpoint())).rejects.toThrow();
});
test.each(["existing", "malformed", "write-unknown-confirmed", "write-unknown-missing", "conflict"])("correlation metadata %s never rotates or replays an uncertain key", async mode => {
  const { native } = nativeFixture();
  let value: string | undefined = mode === "existing" ? "2".repeat(64) : mode === "malformed" ? "invalid" : undefined;
  let writes = 0;
  native.sessionInvokeJson = async (_id, method, params) => {
    if (method === "session.metadata.getClientMetadata") return JSON.stringify({ ok: true, result: value === undefined ? {} : { "daynight/local-read-authority-v1": value } });
    expect(method).toBe("session.metadata.updateClientMetadata"); writes++;
    const request = JSON.parse(params!); expect(Object.keys(request)).toEqual(["set"]); expect(Object.keys(request.set)).toEqual(["daynight/local-read-authority-v1"]);
    if (mode === "conflict") value = "3".repeat(64);
    else if (mode !== "write-unknown-missing") value = request.set["daynight/local-read-authority-v1"];
    throw new Error("Write outcome unknown");
  };
  const result = copilotCorrelationKey(native, "session");
  if (["existing", "write-unknown-confirmed"].includes(mode)) expect(await result).toMatch(/^[a-f0-9]{64}$/);
  else await expect(result).rejects.toThrow();
  expect(writes).toBe(["existing", "malformed"].includes(mode) ? 0 : 1);
  if (mode === "existing") expect(value).toBe("2".repeat(64));
  if (mode === "conflict") expect(value).toBe("3".repeat(64));
});

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
});
async function bridge(mode = "normal") {
  const execution = randomUUID();
  const child = fork(new URL("./fixtures/copilot-read-authority.mjs", import.meta.url), [mode, execution], { stdio: ["pipe", "pipe", "pipe", "ipc"] }); children.push(child);
  await once(child.stdout!, "data");
  const policies: (NativeReadPolicy | null)[] = [];
  const authority = new CopilotReadAuthority({ child, execution, cwd: "/workspace", publish: policy => policies.push(policy), timeoutMs: 200 });
  await authority.install("session");
  return { child, authority, policies, policy: policies.at(-1)! as NativeReadPolicy };
}
test("real private IPC admits only a matching session, execution and checkpoint", async () => {
  const { authority, policy } = await bridge();
  await expect(policy.authorizeCheckpoint(checkpoint())).resolves.toBeUndefined();
  await expect(policy.authorizeCheckpoint(checkpoint("denied.png"))).rejects.toMatchObject({ code: "source_forbidden" });
  await expect(policy.authorizeCheckpoint(checkpoint())).resolves.toBeUndefined();
  authority.invalidate(); expect(() => policy.verify()).toThrow();
});
test.each(["wrong-digest", "wrong-sequence", "oversized"])("real IPC rejects %s response and revokes the execution", async mode => {
  const { policy, child, policies } = await bridge(mode);
  await expect(policy.authorizeCheckpoint(checkpoint())).rejects.toThrow();
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
  expect(policies.at(-1)).toBeNull();
  expect(() => policy.verify()).toThrow();
});
test("a timed-out native check preserves its runtime and cannot publish a late grant", async () => {
  const { child, policy, policies } = await bridge("hang");
  const checking = once(child.stdout!, "data");
  const result = policy.authorizeCheckpoint(checkpoint());
  await checking; await expect(result).rejects.toThrow();
  const late = once(child, "message"); child.stdin!.write("release"); await late;
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull(); expect(policies.at(-1)).toBeNull();
  expect(() => policy.verify()).toThrow();
});
test("duplicate responses cannot grant a second checkpoint", async () => {
  const { child, policy, policies } = await bridge("duplicate");
  const duplicate = new Promise<void>(resolve => { let count = 0; child.on("message", () => { if (++count === 2) resolve(); }); });
  await policy.authorizeCheckpoint(checkpoint()).catch(() => {});
  await duplicate; expect(policies.at(-1)).toBeNull();
  await expect(policy.authorizeCheckpoint(checkpoint())).rejects.toThrow();
});
test("concurrent image checkpoints serialize their native decisions", async () => {
  const { policy } = await bridge();
  const results = await Promise.allSettled([policy.authorizeCheckpoint(checkpoint()), policy.authorizeCheckpoint(checkpoint("denied.png")), policy.authorizeCheckpoint(checkpoint())]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
});
test("invalidation while native checks are pending discards the eventual success", async () => {
  const { child, policy, authority, policies } = await bridge("block");
  const checking = once(child.stdout!, "data");
  const result = policy.authorizeCheckpoint(checkpoint());
  await checking; authority.invalidate();
  await expect(result).rejects.toThrow();
  child.stdin!.write("release");
  expect(policies.at(-1)).toBeNull(); expect(() => policy.verify()).toThrow();
});
test("permission mode changes revoke pending and queued checks while preserving text runtime", async () => {
  const { child, policy, authority } = await bridge("block");
  const checking = once(child.stdout!, "data");
  const first = policy.authorizeCheckpoint(checkpoint()).catch(error => error);
  const second = policy.authorizeCheckpoint(checkpoint()).catch(error => error);
  await checking; authority.observe({ type: "session.permissions_changed", data: { mode: "assisted" } });
  expect(await first).toBeInstanceOf(Error); expect(await second).toBeInstanceOf(Error);
  child.stdin!.write("release"); expect(child.exitCode).toBeNull(); expect(() => policy.verify()).toThrow();
});
test("only an issued complete Read request binds its callback and native events", async () => {
  const { child, policy, authority } = await bridge("permission");
  const requesting = once(child.stdout!, "data");
  const pending = policy.authorizeCheckpoint(checkpoint());
  const request = JSON.parse(String((await requesting)[0]));
  expect(authority.rejectPermission({ ...request, path: "/workspace/other.png" }, { sessionId: "session" })).toBeUndefined();
  expect(authority.rejectPermission(request, { sessionId: "different" })).toBeUndefined();
  expect(authority.rejectPermission({ ...request, toolCallId: "native-tool" }, { sessionId: "session" })).toBeUndefined();
  authority.invalidate();
  await expect(pending).rejects.toThrow();
  const refusal = authority.rejectPermission(request, { sessionId: "session" });
  const event = { type: "permission.requested", data: { requestId: "own-request", permissionRequest: request } };
  expect(authority.suppressPermissionEvent({ ...event, agentId: "child" })).toBe(false);
  expect(authority.suppressPermissionEvent({ ...event, data: { ...event.data, ownerSessionId: "other" } })).toBe(false);
  expect(authority.suppressPermissionEvent(event)).toBe(true);
  const result = await refusal; expect(result?.kind).toBe("reject");
  expect(authority.suppressPermissionEvent({ ...event, data: { ...event.data, permissionRequest: { ...request } } })).toBe(false);
  expect(authority.suppressPermissionEvent({ type: "permission.completed", data: { requestId: "ordinary-request" } })).toBe(false);
  expect(authority.suppressPermissionEvent({ type: "permission.completed", data: { requestId: "own-request" } })).toBe(true);
  const resumed = await bridge();
  const completed = { type: "permission.completed", data: { requestId: "own-request", result: { ...result, kind: "denied-interactively-by-user" } } };
  resumed.authority.prepareHistory([structuredClone(event), completed]);
  expect(resumed.authority.suppressPermissionEvent(structuredClone(event), true)).toBe(true);
  expect(resumed.authority.suppressPermissionEvent(completed, true)).toBe(true);
  expect(resumed.authority.suppressPermissionEvent({ ...event, data: { ...event.data, permissionRequest: { ...request, path: "/different" } } }, true)).toBe(false);
  const replay = { ...event, data: { ...event.data, requestId: "ordinary-replay" } };
  resumed.authority.prepareHistory([replay, { ...completed, data: { ...completed.data, requestId: "ordinary-replay" } }]);
  expect(resumed.authority.suppressPermissionEvent(replay, true)).toBe(false);
  child.stdin!.write("release");
});
test.each(["session", "execution", "sequence", "digest", "unknown", "oversized"])("private server rejects a %s request mismatch", async mode => {
  const { child, authority, policy } = await bridge();
  const base = { protocol: copilotAuthorityProtocol, execution: mode === "execution" ? randomUUID() : authority.execution, sequence: mode === "sequence" ? 0 : 1, sessionId: mode === "session" ? "another-session" : "session", cwd: "/workspace", checkpoint: checkpoint() };
  const request = { ...base, digest: mode === "digest" ? "0".repeat(64) : copilotRequestDigest(base), ...(mode === "unknown" ? { method: "session.permissions.configure" } : {}), ...(mode === "oversized" ? { payload: "x".repeat(270_336) } : {}) };
  child.send(request);
  await expect(policy.authorizeCheckpoint(checkpoint())).rejects.toThrow();
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull(); expect(() => policy.verify()).toThrow();
});
