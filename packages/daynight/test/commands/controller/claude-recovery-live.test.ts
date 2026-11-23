import { expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
const { queryClaudeLive } = await import(new URL("../../../dist/commands/controller/providers/claude-live.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/claude-live.js");

test.each([false, true])("actual SDK mirror preserves resume configuration and waits for append (failure=%s)", async failure => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-mirror-"));
  const config = path.join(root, "config"), log = path.join(root, "launch.jsonl"); await mkdir(config);
  const sessionId = randomUUID(), inputId = randomUUID(), events: unknown[] = [], batches: SessionStoreEntry[][] = [];
  let child!: ChildProcess, peak = 0, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), appending = new Promise<void>(resolve => { entered = resolve; });
  const load = vi.fn(async () => { throw new Error("SDK materialization would change configuration."); });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, DAYNIGHT_TEST_CLAUDE_RECOVERY_LOG: log };
  const owner: ProviderOptions = { cwd: root, env, model: null, args: [], resumeNativeSessionId: null, onState: () => {}, onTimeline: () => {},
    onSpawn: (value: ChildProcess) => { child = value; child.on("message", frame => { peak = Math.max(peak, Buffer.byteLength(JSON.stringify(frame))); }); } };
  const native = queryClaudeLive({ prompt: (async function* () {})(), options: { cwd: root, env, extraArgs: { resume: sessionId },
    pathToClaudeCodeExecutable: path.resolve("test/commands/controller/fixtures/claude-recovery-native.mjs"),
    sessionStore: { load, append: async (key, entries) => {
      expect(key).toEqual({ projectKey: "fixture", sessionId }); batches.push(entries); entered(); await gate;
      if (failure) throw new Error("Controlled store refusal");
    } },
  } }, owner);
  const resultSeen = Promise.withResolvers<void>();
  const pump = (async () => { for await (const event of native) { events.push(event); if (event.type === "result") resultSeen.resolve(); } })();
  try {
    await native.initializationResult();
    await native.submit({ uuid: inputId, sessionId, input: { content: [{ type: "text", text: "continue" }] } });
    await appending; expect(events).toEqual([]); release();
    // The SDK's failure branch includes its real 200 ms + 800 ms retry backoff.
    // Await the actual result event rather than a poll with a shorter default budget.
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([resultSeen.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude fixture result was not observed.")), 10_000); })]); }
    finally { clearTimeout(timer); }
    const launch = JSON.parse((await readFile(log, "utf8")).trim());
    expect(launch.config).toBe(config); expect(launch.cwd).toBe(root);
    expect(launch.args.slice(launch.args.indexOf("--resume"), launch.args.indexOf("--resume") + 2)).toEqual(["--resume", sessionId]);
    expect(launch.args).toContain("--session-mirror"); expect(launch.args).not.toContain("--session-id"); expect(load).not.toHaveBeenCalled();
    expect(batches).toHaveLength(failure ? 3 : 1); expect(batches[0]?.[1]?.message).toEqual({ role: "assistant", content: "😀".repeat(60_000) });
    expect(events.some(value => (value as { subtype?: string }).subtype === "mirror_error")).toBe(failure);
    expect(peak).toBeLessThanOrEqual(1_048_576);
  } finally {
    release(); native.close(); await native.join(); await pump;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true); await rm(root, { recursive: true, force: true });
  }
}, 20_000);
