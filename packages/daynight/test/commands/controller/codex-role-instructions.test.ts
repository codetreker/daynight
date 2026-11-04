import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import type { NativeProvider, ProviderOptions, ProviderState } from "../../../src/commands/controller/providers/types.js";
import { NativeRpcError } from "../../../src/commands/controller/providers/native-rpc.js";

const role = "  Daynight 助手\nUse CLI help; preserve e\u0301 and 🌓.\n  ";
let root: string, child: ChildProcess, closed: boolean, states: ProviderState[];
beforeEach(async () => {
  const base = path.join(process.cwd(), ".tmp", "codex-role");
  await mkdir(base, { recursive: true });
  root = await mkdtemp(path.join(base, "run-"));
  closed = false; states = [];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function options(resumeNativeSessionId: string | null, env: NodeJS.ProcessEnv = {}): ProviderOptions {
  return {
    cwd: root, model: null, args: [], resumeNativeSessionId,
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)),
    env: { ...process.env, CODEX_HOME: root, CODEX_TEST_REQUEST_LOG: path.join(root, "requests.jsonl"), ...env },
    onTimeline: () => {}, onState: state => states.push(structuredClone(state)),
    onSpawn: process => { child = process; process.once("close", () => { closed = true; }); },
  };
}
async function requests(): Promise<{ method: string; params: Record<string, unknown> }[]> {
  return (await readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

for (const resume of [false, true]) {
  test.each([{ instructions: undefined }, { instructions: role }])(`Codex ${resume ? "resume" : "start"} configures roles without a user turn: %#`, async ({ instructions }) => {
    const provider = await openCodexProvider({ ...options(resume ? "native-thread" : null), ...(instructions === undefined ? {} : { instructions }) });
    try {
      const log = await requests();
      const opening = log.filter(item => item.method === "thread/start" || item.method === "thread/resume");
      expect(opening).toHaveLength(1);
      expect(opening[0]!.method).toBe(resume ? "thread/resume" : "thread/start");
      const params = opening[0]!.params;
      if (instructions === undefined) expect(params).not.toHaveProperty("developerInstructions");
      else expect(params.developerInstructions).toBe(role);
      expect(params).not.toHaveProperty("baseInstructions");
      for (const key of ["model", "effort", "sandbox", "approvalPolicy"]) expect(params).not.toHaveProperty(key);
      expect(log.filter(item => item.method.startsWith("turn/"))).toEqual([]);
      expect(states.at(-1)).toMatchObject({ activity: "idle", currentTurnId: null });
      if (resume) expect(params).toMatchObject({ threadId: "native-thread", excludeTurns: true });
    } finally { await provider.close(); }
  });

  test(`Codex ${resume ? "resume" : "start"} propagates native role rejection and closes its transport`, async () => {
    const message = "Native policy rejected developerInstructions: role is not permitted.";
    let provider: NativeProvider | undefined;
    try {
      const opening = openCodexProvider({ ...options(resume ? "native-thread" : null, { CODEX_TEST_REJECT_ROLE: message }), instructions: role });
      const error = await opening.then(value => { provider = value; return null; }, error => error);
      expect(error).toBeInstanceOf(NativeRpcError);
      expect(error).toMatchObject({ code: -32602, message });
      expect(closed).toBe(true);
      expect(child.exitCode).toBe(0);
      expect(child.stdin?.destroyed).toBe(true);
      expect(child.stdout?.destroyed).toBe(true);
      expect(child.stderr?.destroyed).toBe(true);
      const log = await requests();
      expect(log.filter(item => item.method === "thread/start" || item.method === "thread/resume")).toHaveLength(1);
      expect(log.filter(item => item.method.startsWith("turn/"))).toEqual([]);
    } finally { await provider?.close(); }
  });
}

test.each([
  { resume: false, unattended: false, sandbox: "workspace-write", approvalPolicy: "on-request", effort: "high" },
  { resume: false, unattended: true, sandbox: "danger-full-access", approvalPolicy: "never", effort: "high" },
  { resume: true, unattended: true, sandbox: undefined, approvalPolicy: undefined, effort: "low" },
])("roles preserve native settings and first real input: %j", async ({ resume, unattended, sandbox, approvalPolicy, effort }) => {
  const provider = await openCodexProvider({
    ...options(resume ? "native-thread" : null, {
      CODEX_TEST_THREAD_SETTINGS: JSON.stringify({ model: "native-model", ...(resume ? { reasoningEffort: "low" } : {}) }),
      CODEX_TEST_MODELS: JSON.stringify([{ model: "native-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }]),
    }),
    instructions: role, model: "requested-model", unattended,
    args: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--effort", "high"],
  });
  try {
    const before = await requests();
    expect(before.filter(item => item.method.startsWith("turn/"))).toEqual([]);
    const params = before.find(item => item.method === (resume ? "thread/resume" : "thread/start"))!.params;
    expect(params.developerInstructions).toBe(role);
    if (resume) for (const key of ["model", "sandbox", "approvalPolicy"]) expect(params).not.toHaveProperty(key);
    else expect(params).toMatchObject({ model: "requested-model", sandbox, approvalPolicy });
    const receipt = await provider.send("Actual user request", "first-user-operation", null);
    await provider.waitForTurn(receipt.turnId!, Date.now() + 1000);
    const turns = (await requests()).filter(item => item.method.startsWith("turn/"));
    expect(turns).toEqual([{ method: "turn/start", params: {
      threadId: "native-thread", clientUserMessageId: "first-user-operation", effort,
      input: [{ type: "text", text: "Actual user request", text_elements: [] }],
    }, id: expect.any(Number) }]);
  } finally { await provider.close(); }
});

test.skipIf(process.platform === "win32").each([null, "native-thread"])("roles retain native toolchain PATH and CLI aliases (resume %s)", async resumeNativeSessionId => {
  const provider = await openCodexProvider({
    ...options(resumeNativeSessionId, {
      CODEX_TEST_EFFECTIVE_CONFIG: JSON.stringify({ shell_environment_policy: {
        inherit: "none", set: { PATH: "/native/toolchain:/usr/bin:/bin" }, include_only: ["PATH", "DN_CONFIG_DIR"],
      } }),
    }),
    instructions: role,
    agentCliEnvironment: { PATH: "/private/aliases:/worker/bin", DN_CONFIG_DIR: "/private/dev" },
  });
  try {
    const params = (await requests()).find(item => item.method === (resumeNativeSessionId ? "thread/resume" : "thread/start"))!.params;
    expect(params.developerInstructions).toBe(role);
    expect(params.config).toMatchObject({
      "features.default_mode_request_user_input": true,
      "shell_environment_policy.set.PATH": "/private/aliases:/native/toolchain:/usr/bin:/bin",
      "shell_environment_policy.set.DN_CONFIG_DIR": "/private/dev",
    });
  } finally { await provider.close(); }
});
