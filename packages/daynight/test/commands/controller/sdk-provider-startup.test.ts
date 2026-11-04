import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openClaudeProvider } from "../../../src/commands/controller/providers/claude.js";
import { openCopilotProvider } from "../../../src/commands/controller/providers/copilot.js";
import { startupFailure } from "../../../src/commands/controller/startup.js";
import type { ProviderState } from "../../../src/commands/controller/providers/types.js";

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

for (const provider of ["copilot", "claude"] as const) {
  const modes = provider === "copilot" ? ["reject", "reject-connect", "reject-resume", "disconnect", "timeout"] as const : ["reject", "disconnect", "timeout"] as const;
  test.each(modes)(`${provider} real SDK startup %s retains rejection and uncertainty boundaries`, async mode => {
    const base = path.resolve(import.meta.dirname, "../../../../../.tmp/sdk-startup");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
    const log = path.join(root, "requests.log"), states: ProviderState[] = [];
    const open = provider === "copilot" ? openCopilotProvider : openClaudeProvider;
    const error: unknown = await open({ cwd: root, model: null, args: [], resumeNativeSessionId: mode === "reject-resume" ? randomUUID() : null,
      executable: path.resolve(import.meta.dirname, `fixtures/${provider}-startup.mjs`),
      env: { ...process.env, DAYNIGHT_TEST_STARTUP_MODE: mode, DAYNIGHT_TEST_STARTUP_LOG: log },
      onTimeline: () => {}, onState: state => states.push(structuredClone(state)), onSpawn: child => children.push(child),
    }).then(async opened => { await opened.close(); throw new Error("Fixture unexpectedly initialized."); }, error => error);
    expect(error).toBeInstanceOf(Error);
    expect(startupFailure(error)).toEqual(mode.startsWith("reject") ? { state: "failed", reasonCode: "native_rejected" }
      : { state: "unknown", reasonCode: mode === "timeout" ? "native_timeout" : "native_transport_unknown" });
    const requests = (await readFile(log, "utf8")).trim().split("\n");
    expect(requests).toContain(provider === "claude" ? "control_request:initialize" : mode === "reject-connect" ? "connect" : mode === "reject-resume" ? "session.resume" : "session.create");
    expect(requests.some(method => method === "session.send" || method.startsWith("user:"))).toBe(false);
    expect(states.every(state => state.nativeSessionId === null)).toBe(true);
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  }, 45_000);
}
