import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CopilotClient, RuntimeConnection, type SessionConfig } from "@github/copilot-sdk";
import which from "which";
import { createOperation } from "../../api/operation.js";
import { parseWorkerCloudNative, type WorkerCloudNative } from "../../api/worker-configuration.js";
import { assertNativeModelSelection, type NativeModelObservation } from "../controller/providers/native-selection.js";
import { record, string } from "../controller/providers/native-rpc.js";
import { withCodexConfigurationRpc } from "./herdr/codex-config.js";
import { normalizeWorkerNative } from "./native-overrides.js";
import { createNativeSelectionFs } from "./native-selection-fs.js";

/** Runs only inside the owned probe supervisor; no user input or persistent session is created. */
export const inspectNativeSelection = async (native: WorkerCloudNative): Promise<NativeModelObservation> => {
  const normalized = normalizeWorkerNative(native, "herdr"), effort = normalized.report.reasoningEffort.value;
  const requested = { model: normalized.native.model, ...(effort === null ? {} : { effort }) };
  let observation: NativeModelObservation;
  if (native.agent === "codex") {
    if (native.args.some(argument => argument === "--oss" || argument === "--local-provider" || argument.startsWith("--local-provider="))) throw new Error("Codex local-provider model capabilities cannot be validated by the native configuration probe.");
    const operation = createOperation({ limits: { totalMs: 15_000, requestMs: 10_000 } });
    try {
      observation = await withCodexConfigurationRpc({ args: [...normalized.native.args, ...(requested.model === null ? [] : ["-c", `model=${JSON.stringify(requested.model)}`])], cwd: process.cwd(), environment: process.env, detached: false }, operation, async rpc => {
        const config = record(record(await rpc.request("config/read", { cwd: process.cwd(), includeLayers: false })).config);
        const catalog: Record<string, unknown>[] = [], cursors = new Set<string>(); let cursor: string | undefined;
        do {
          const page = record(await rpc.request("model/list", { includeHidden: true, ...(cursor === undefined ? {} : { cursor }) }));
          if (!Array.isArray(page.data)) throw new Error("Codex native model catalog is unavailable.");
          catalog.push(...page.data.map(record));
          cursor = string(page.nextCursor) || undefined;
          if (catalog.length > 500 || cursor !== undefined && cursors.has(cursor)) throw new Error("Codex native model catalog exceeds its bound.");
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        // The complete catalog preserves native order. Codex chooses its first
        // isDefault entry, then its first available entry when none is marked.
        // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/models-manager/src/manager.rs#L868-L875
        const selected = string(config.model) || string((catalog.find(model => model.isDefault === true) ?? catalog[0])?.model) || null;
        const models = catalog.map(model => ({ id: string(model.model), efforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map(value => string(record(value).reasoningEffort)).filter(Boolean) : null }));
        return { models, model: selected, ...(typeof config.model_reasoning_effort === "string" ? { effort: config.model_reasoning_effort } : {}) };
      }) as NativeModelObservation;
    } finally { operation.dispose(); }
  } else if (native.agent === "claude") {
    let release!: () => void;
    const closed = new Promise<void>(resolve => { release = resolve; });
    const children: ChildProcess[] = [];
    async function* input(): AsyncGenerator<SDKUserMessage> { await closed; }
    const session = query({ prompt: input(), options: { cwd: process.cwd(), env: process.env, pathToClaudeCodeExecutable: "claude", persistSession: false, settingSources: ["user", "project", "local"],
      ...(requested.model === null ? {} : { model: requested.model }), ...(requested.effort === undefined ? {} : { effort: requested.effort as NonNullable<Options["effort"]> }),
      spawnClaudeCodeProcess: args => { const child = spawn(args.command, args.args, { cwd: args.cwd, env: args.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); children.push(child); return child; },
    } });
    try {
      await session.initializationResult();
      const models = await session.supportedModels();
      const querySettings = session as typeof session & { getSettings?: () => Promise<unknown> };
      if (typeof querySettings.getSettings !== "function" || models.length > 500) throw new Error("Claude effective model discovery is unavailable.");
      const settings = record(record(await querySettings.getSettings()).applied);
      observation = { model: string(settings.model) || null, effort: typeof settings.effort === "string" ? settings.effort : null, models: models.map(raw => {
        const item = record(raw);
        return { id: string(item.value), aliases: typeof item.resolvedModel === "string" ? [item.resolvedModel] : [], efforts: item.supportsEffort && Array.isArray(item.supportedEffortLevels) ? item.supportedEffortLevels.filter((value): value is string => typeof value === "string") : null };
      }) };
    } finally { release(); session.close(); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }
  } else {
    const sessionId = randomUUID(), cwd = process.cwd();
    const client = new CopilotClient({ workingDirectory: cwd, env: process.env, connection: RuntimeConnection.forStdio({ path: await which("copilot") }),
      sessionFs: { initialCwd: cwd, sessionStatePath: path.join(cwd, ".tmp", `native-selection-${sessionId}`), conventions: process.platform === "win32" ? "windows" : "posix", capabilities: { sqlite: false } } });
    try {
      await client.start();
      const session = await client.createSession({ sessionId, workingDirectory: cwd, ...(requested.model === null ? {} : { model: requested.model }),
        ...(requested.effort === undefined ? {} : { reasoningEffort: requested.effort as NonNullable<SessionConfig["reasoningEffort"]> }),
        createSessionFsProvider: () => createNativeSelectionFs(cwd), onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }) });
      try {
        const [current, listing] = await Promise.all([session.rpc.model.getCurrent(), session.rpc.model.list()]);
        if (!Array.isArray(listing.list) || listing.list.length > 500) throw new Error("Copilot native model catalog exceeds its bound.");
        observation = { model: current.modelId ?? null, effort: current.reasoningEffort ?? null, models: listing.list.map(value => {
          const item = record(value), levels = item.supportedReasoningEfforts ?? record(record(item.capabilities).supports).reasoning_effort;
          return { id: string(item.id), efforts: Array.isArray(levels) ? levels.filter((value): value is string => typeof value === "string") : null };
        }) };
      } finally { await session.disconnect(); }
    } finally { const errors = await client.stop(); if (errors.length > 0) throw new AggregateError(errors, "Copilot selection probe stop was not confirmed."); }
  }
  assertNativeModelSelection(native.agent, requested, observation);
  return observation;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const observation = await inspectNativeSelection(parseWorkerCloudNative(JSON.parse(process.argv[2] ?? ""))); process.stdout.write(JSON.stringify({ ok: true, observation })); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message.slice(0, 2000) : "Native model selection inspection failed." })); }
}
