import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CopilotClient, RuntimeConnection, type SessionConfig } from "@github/copilot-sdk";
import which from "which";
import { createOperation } from "../../api/operation.js";
import { parseWorkerCloudNative, type WorkerCloudNative } from "../../api/worker-configuration.js";
import { assertNativeModelSelection, NativeCapabilityError, validateNativeModelObservation, type NativeModelObservation } from "../controller/providers/native-selection.js";
import { record, string } from "../controller/providers/native-rpc.js";
import { withCodexConfigurationRpc } from "./herdr/codex-config.js";
import { normalizeWorkerNative } from "./native-overrides.js";
import { createNativeSelectionFs } from "./native-selection-fs.js";
import { buildHerdrAgentArguments } from "./herdr/arguments.js";
import { hasHerdrCommandCleanupFailure } from "./herdr/command.js";
import { parseProviderArguments } from "../controller/providers/projection.js";
import { ToolSelectionError, type ResolvedToolLaunch } from "../../platform/tool-executables.js";
import { parseResolvedToolLaunch } from "../../platform/tool-launch-record.js";
import { withCopilotProbeClient, inspectCopilotStatus } from "./copilot-probe-client.js";

type NativeProbeSelection = { mode?: "web" | "herdr"; toolLaunch?: ResolvedToolLaunch; toolRuntimeRoot?: string };

/** Runs only inside the owned probe supervisor; no user input or persistent session is created. */
const inspectCapabilities = async (native: WorkerCloudNative, mode: "web" | "herdr", selection: NativeProbeSelection): Promise<NativeModelObservation> => {
  const normalized = normalizeWorkerNative(native, mode, {}, true, true), effort = normalized.report.reasoningEffort.value;
  const webArguments = mode === "web" ? parseProviderArguments(native.agent, normalized.native.args, true) : undefined;
  const requested = { model: normalized.native.model, ...(effort === null ? {} : { effort }) };
  let observation: NativeModelObservation;
  if (native.agent === "codex") {
    if (native.args.some(argument => argument === "--oss" || argument === "--local-provider" || argument.startsWith("--local-provider="))) throw new Error("Codex local-provider model capabilities cannot be validated by the native configuration probe.");
    const cwd = path.normalize(await realpath(process.cwd()));
    // Web sessions retain native project trust. Herdr verification must instead
    // use its launch-owned trust override; neither path creates a thread here.
    const launchArguments = mode === "herdr" ? buildHerdrAgentArguments(normalized.native, cwd)
      : requested.effort === undefined ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(requested.effort)}`];
    const operation = createOperation({ limits: { totalMs: 15_000, requestMs: 10_000 } });
    try {
      observation = await withCodexConfigurationRpc({ args: [...launchArguments, ...(requested.model === null ? [] : ["-c", `model=${JSON.stringify(requested.model)}`])], cwd, environment: process.env, detached: false, ...(selection.toolLaunch ? { toolLaunch: selection.toolLaunch } : {}) }, operation, async rpc => {
        const config = record(record(await rpc.request("config/read", { cwd, includeLayers: false })).config);
        const catalog: Record<string, unknown>[] = [], cursors = new Set<string>(); let cursor: string | undefined;
        do {
          const page = record(await rpc.request("model/list", { includeHidden: true, ...(cursor === undefined ? {} : { cursor }) }));
          if (!Array.isArray(page.data)) throw new Error("Codex native model catalog is unavailable.");
          catalog.push(...page.data.map(record));
          cursor = string(page.nextCursor) || undefined;
          if (catalog.length > 500 || cursors.size >= 500 || cursor !== undefined && cursors.has(cursor)) throw new NativeCapabilityError("limit_exceeded", "Codex native model catalog exceeds its bound.");
          if (page.nextCursor !== undefined && page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || Buffer.byteLength(page.nextCursor) > 4096)) throw new NativeCapabilityError("capability_error", "Codex native model pagination is invalid.");
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        // The complete catalog preserves native order. Codex chooses its first
        // isDefault entry, then its first available entry when none is marked.
        // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/models-manager/src/manager.rs#L868-L875
        const selected = string(config.model) || string((catalog.find(model => model.isDefault === true) ?? catalog[0])?.model) || null;
        const models = catalog.map(model => ({ id: string(model.model), label: string(model.displayName) || string(model.model), hidden: model.hidden === true,
          efforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map(value => string(record(value).reasoningEffort)) : model.supportedReasoningEfforts === undefined ? null : [""],
          defaultEffort: model.defaultReasoningEffort === undefined || model.defaultReasoningEffort === null ? null : string(model.defaultReasoningEffort) }));
        return { models, model: selected, ...(typeof config.model_reasoning_effort === "string" ? { effort: config.model_reasoning_effort } : {}) };
      }) as NativeModelObservation;
    } finally { operation.dispose(); }
  } else if (native.agent === "claude") {
    let release!: () => void;
    const closed = new Promise<void>(resolve => { release = resolve; });
    const children: ChildProcess[] = [];
    async function* input(): AsyncGenerator<SDKUserMessage> { await closed; }
    const session = query({ prompt: input(), options: { cwd: process.cwd(), env: process.env, ...(mode === "herdr" ? { pathToClaudeCodeExecutable: "claude" } : {}), persistSession: false, settingSources: ["user", "project", "local"],
      ...(webArguments?.additionalDirectories === undefined ? {} : { additionalDirectories: webArguments.additionalDirectories }),
      ...(requested.model === null ? {} : { model: requested.model }), ...(requested.effort === undefined ? {} : { effort: requested.effort as NonNullable<Options["effort"]> }),
      spawnClaudeCodeProcess: args => { const child = spawn(args.command, args.args, { cwd: args.cwd, env: args.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); children.push(child); return child; },
    } });
    let failure: unknown;
    try {
      await session.initializationResult();
      const models = await session.supportedModels();
      const querySettings = session as typeof session & { getSettings?: () => Promise<unknown> };
      if (typeof querySettings.getSettings !== "function" || !Array.isArray(models)) throw new Error("Claude effective model discovery is unavailable.");
      if (models.length > 500) throw new NativeCapabilityError("limit_exceeded", "Claude native model catalog exceeds its bound.");
      const settings = record(record(await querySettings.getSettings()).applied);
      observation = { model: string(settings.model) || null, effort: typeof settings.effort === "string" ? settings.effort : null, models: models.map(raw => {
        const item = record(raw);
        return { id: string(item.value), label: string(item.displayName) || string(item.value), hidden: item.hidden === true, aliases: typeof item.resolvedModel === "string" ? [item.resolvedModel] : [],
          efforts: item.supportsEffort === true ? Array.isArray(item.supportedEffortLevels) ? item.supportedEffortLevels.map(string) : [""] : null, defaultEffort: null };
      }) };
    } catch (error) { failure = error; throw error; }
    finally {
      release(); const failures: unknown[] = [];
      try { session.close(); } catch (error) { failures.push(error); }
      for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGTERM"); } catch (error) { failures.push(error); } }
      if (failures.length) throw Object.assign(new AggregateError([...(failure === undefined ? [] : [failure]), ...failures], "Claude capability probe cleanup is unconfirmed."), { code: "cleanup_unknown" as const });
    }
  } else {
    const sessionId = randomUUID(), cwd = process.cwd();
    const read = async (client: CopilotClient): Promise<NativeModelObservation> => {
      let failure: unknown, session: Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
      try {
      session = await client.createSession({ sessionId, workingDirectory: cwd, ...(requested.model === null ? {} : { model: requested.model }),
        ...(requested.effort === undefined ? {} : { reasoningEffort: requested.effort as NonNullable<SessionConfig["reasoningEffort"]> }),
        createSessionFsProvider: () => createNativeSelectionFs(cwd), onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }) });
        const [current, listing] = await Promise.all([session.rpc.model.getCurrent(), session.rpc.model.list()]);
        if (!Array.isArray(listing.list)) throw new NativeCapabilityError("capability_error", "Copilot native model catalog is unavailable.");
        if (listing.list.length > 500) throw new NativeCapabilityError("limit_exceeded", "Copilot native model catalog exceeds its bound.");
        return { model: current.modelId ?? null, effort: current.reasoningEffort ?? null, models: listing.list.map(value => {
          const item = record(value), levels = item.supportedReasoningEfforts ?? record(record(item.capabilities).supports).reasoning_effort;
          return { id: string(item.id), label: string(item.name) || string(item.id), hidden: item.hidden === true, efforts: Array.isArray(levels) ? levels.map(string) : levels === undefined || levels === null || levels === false ? null : [""],
            defaultEffort: item.defaultReasoningEffort === undefined || item.defaultReasoningEffort === null ? null : string(item.defaultReasoningEffort) };
        }) };
      } catch (error) { failure = error; throw error; }
      finally {
        if (session) try { await session.disconnect(); }
        catch (error) { throw Object.assign(new AggregateError([...(failure === undefined ? [] : [failure]), error], "Copilot capability session cleanup is unconfirmed."), { code: "cleanup_unknown" as const }); }
      }
    };
    if (mode === "web" || selection.toolLaunch) {
      const operation = createOperation({ limits: { totalMs: 15_000, requestMs: 10_000 } });
      try { observation = await withCopilotProbeClient({ cwd, environment: process.env, sessionId, ...selection }, operation, async client => { await inspectCopilotStatus(client, selection.toolLaunch); return read(client); }); }
      finally { operation.dispose(); }
    } else {
      const client = new CopilotClient({ workingDirectory: cwd, env: process.env, connection: RuntimeConnection.forStdio({ path: await which("copilot") }),
        sessionFs: { initialCwd: cwd, sessionStatePath: path.join(cwd, ".tmp", `native-selection-${sessionId}`), conventions: process.platform === "win32" ? "windows" : "posix", capabilities: { sqlite: false } } });
      let failure: unknown;
      try { await client.start(); observation = await read(client); }
      catch (error) { failure = error; throw error; }
      finally {
        let errors: unknown[] = [];
        try { errors = await client.stop(); } catch (error) { errors.push(error); }
        if (errors.length) throw Object.assign(new AggregateError([...(failure === undefined ? [] : [failure]), ...errors], "Copilot capability probe cleanup is unconfirmed."), { code: "cleanup_unknown" as const });
      }
    }
  }
  return validateNativeModelObservation(observation);
};

const readNativeCapabilities = async (native: WorkerCloudNative, mode: "web" | "herdr", selection: NativeProbeSelection = {}): Promise<NativeModelObservation> => {
  try { return await inspectCapabilities(native, mode, selection); }
  catch (error) {
    if (error instanceof ToolSelectionError) throw error;
    if (error instanceof Error && "code" in error && ["capability_error", "limit_exceeded", "cleanup_unknown"].includes(String(error.code))) throw error;
    if (hasHerdrCommandCleanupFailure(error)) throw new NativeCapabilityError("cleanup_unknown", "Native capability probe cleanup is unconfirmed.", { cause: error });
    throw new NativeCapabilityError("capability_error", error instanceof Error ? error.message : "Native capability discovery failed.", { cause: error });
  }
};

export const inspectNativeCapabilities = (native: WorkerCloudNative, selection: NativeProbeSelection = {}): Promise<NativeModelObservation> => readNativeCapabilities(native, selection.mode ?? "web", selection);

export const inspectNativeSelection = async (native: WorkerCloudNative, selection: NativeProbeSelection = {}): Promise<NativeModelObservation> => {
  const mode = selection.mode ?? "herdr";
  const normalized = normalizeWorkerNative(native, mode), effort = normalized.report.reasoningEffort.value;
  const requested = { model: normalized.native.model, ...(effort === null ? {} : { effort }) };
  const observation = await readNativeCapabilities(native, mode, selection);
  assertNativeModelSelection(native.agent, requested, observation);
  return observation;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[3] ?? "verify";
    if (!["verify", "discover", "status"].includes(action)) throw new NativeCapabilityError("capability_error", "Unknown native probe operation.");
    const input = JSON.parse(process.argv[2] ?? "") as Record<string, unknown>;
    const native = parseWorkerCloudNative({ agent: input.agent, model: input.model, args: input.args });
    const mode = input.mode ?? (action === "verify" ? "herdr" : "web");
    if (mode !== "web" && mode !== "herdr") throw new NativeCapabilityError("capability_error", "Unknown native probe context.");
    const toolLaunch = input.toolLaunch === undefined ? undefined : parseResolvedToolLaunch(input.toolLaunch, { ...(native.agent === "claude" ? {} : { tool: native.agent }), context: mode });
    if (input.toolRuntimeRoot !== undefined && (typeof input.toolRuntimeRoot !== "string" || !path.isAbsolute(input.toolRuntimeRoot))) throw new Error("Invalid private tool runtime root.");
    if (native.agent === "claude" && toolLaunch) throw new Error("Claude does not accept a Worker tool launch.");
    const selection: NativeProbeSelection = { mode, ...(toolLaunch ? { toolLaunch } : {}), ...(typeof input.toolRuntimeRoot === "string" ? { toolRuntimeRoot: input.toolRuntimeRoot } : {}) };
    if (action === "status") {
      if (native.agent !== "copilot" || mode !== "web" || !toolLaunch) throw new Error("Runtime status requires a frozen Web Copilot launch.");
      const operation = createOperation({ limits: { totalMs: 15_000, requestMs: 10_000 } });
      try {
        const version = await withCopilotProbeClient({ cwd: process.cwd(), environment: process.env, ...selection }, operation, client => inspectCopilotStatus(client, toolLaunch));
        process.stdout.write(JSON.stringify({ ok: true, version }));
      } finally { operation.dispose(); }
    } else {
      const observation = await (action === "discover" ? inspectNativeCapabilities(native, selection) : inspectNativeSelection(native, selection));
      process.stdout.write(JSON.stringify({ ok: true, observation }));
    }
  }
  catch (error) {
    const code = error instanceof Error && "code" in error && (error.code === "limit_exceeded" || error.code === "cleanup_unknown") ? error.code : "capability_error";
    const describe = (value: unknown, depth = 0): string => {
      if (!(value instanceof Error)) return String(value).slice(0, 2000);
      if (depth >= 4) return value.message.slice(0, 2000);
      return [value.message, ...(value instanceof AggregateError ? value.errors.slice(0, 8).map(item => describe(item, depth + 1)) : []), ...(value.cause === undefined ? [] : [describe(value.cause, depth + 1)])].join("; ").slice(0, 2000);
    };
    process.stdout.write(JSON.stringify({ ok: false, code, error: describe(error), ...(error instanceof ToolSelectionError ? { toolSelection: { tool: error.tool, context: error.context, stage: error.stage, code: error.code } } : {}) }));
  }
}
