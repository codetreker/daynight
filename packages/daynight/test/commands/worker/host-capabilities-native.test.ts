import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createAssistantHostCollector } from "../../../src/commands/worker/bots/host-capabilities.js";
import { hasHerdrCommandCleanupFailure } from "../../../src/commands/worker/herdr/command.js";

it("qualifies bounded native Web prerequisites without starting a session", async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "host-native-"));
  const operation = createOperation({ limits: { totalMs: 10_000 } });
  try {
    const environment = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, COPILOT_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root };
    const collector = createAssistantHostCollector({ workingDirectory: root, configuration: { agent: "copilot", agentControlMode: "herdr", model: null, args: [], recoveryLimit: 3 }, environment });
    const started = performance.now();
    const sample = await collector.collect(operation);
    const elapsed = performance.now() - started;
    process.stdout.write(`${JSON.stringify({ kind: "assistant_host_native", platform: process.platform, elapsedMs: Math.round(elapsed), providers: sample.assistantHost.providers.map(({ provider, available, reason }) => ({ provider, available, reason })) })}\n`);
    expect(elapsed).toBeLessThan(5_500);
    expect(sample.assistantHost.defaultProvider).toBe("copilot");
    expect(sample.assistantHost.providers).toHaveLength(3);
    expect(sample.issues.some(issue => hasHerdrCommandCleanupFailure(issue.error))).toBe(false);
    for (const entry of sample.assistantHost.providers) {
      expect(entry.available).toBe(entry.reason === null);
      expect(entry.model).toBeNull();
      expect(entry.args).toEqual([]);
    }
  } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); }
}, 10_000);
