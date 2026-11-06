import { array, canonicalId, id, malformed, record, text as plainText, timestamp } from "../../api/validation.js";
import { parseWorkerRuntimeConfiguration } from "../../api/worker-runtime-configuration.js";
import type { TaskPlatform, TaskStatus, WorkerAgent, WorkerAssistantHost, WorkerAssistantHostReason, WorkerMachine, WorkerPhase, WorkerProbe, WorkerProbeCode, WorkerTelemetry } from "../../api/types.js";

const executionPlatform = (value: unknown): TaskPlatform => value === "macos" || value === "linux" || value === "windows" ? value : malformed();
export type WorkerTaskSnapshot = {
  readonly projectId: string; readonly taskId: string; readonly claimId: string;
  readonly title: string; readonly projectName: string; readonly status: TaskStatus;
  readonly phase: WorkerPhase; readonly agent: WorkerAgent;
};
type WorkerIdentity = {
  readonly workerId: string;
  readonly machine: WorkerMachine;
  readonly platform: TaskPlatform;
  readonly lastReportedAt: string;
};
export type WorkerSummary = WorkerIdentity & (
  | { readonly taskObservationState: "unavailable"; readonly taskObservedAt: null; readonly activeTaskCount: null }
  | { readonly taskObservationState: "observed" | "stale"; readonly taskObservedAt: string; readonly activeTaskCount: number }
);
export type WorkerDetail = WorkerSummary & {
  readonly telemetry: WorkerTelemetry;
  readonly inventoryObservedAt: string | null;
  readonly tasks: readonly WorkerTaskSnapshot[];
};
export type WorkerPage = { readonly observedAt: string; readonly items: readonly WorkerSummary[]; readonly nextCursor: string | null };
export type WorkerDetailResponse = { readonly observedAt: string; readonly worker: WorkerDetail };
export type WorkerList = { readonly observedAt: string; readonly items: readonly WorkerSummary[] };

const fields = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).length !== names.length || names.some(name => !Object.hasOwn(data, name))) return malformed();
  return data;
};
const choice = <T extends string>(value: unknown, choices: readonly T[]): T =>
  typeof value === "string" && choices.includes(value as T) ? value as T : malformed();
const text = (value: unknown): string => {
  const parsed = plainText(value);
  if (!parsed.isWellFormed() || parsed.includes("\0") || !/[^\p{White_Space}]/u.test(parsed)) return malformed();
  return parsed;
};
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : malformed();
const machine = (value: unknown): WorkerMachine => {
  const data = fields(value, ["id", "name"]);
  return { id: id(data.id), name: text(data.name) };
};
const probe = <T>(value: unknown, parse: (value: unknown) => T): WorkerProbe<T> => {
  const data = record(value);
  if (data.state === "ok") {
    fields(data, ["state", "checkedAt", "value"]);
    return { state: "ok", checkedAt: timestamp(data.checkedAt), value: parse(data.value) };
  }
  fields(data, ["state", "checkedAt", "code"]);
  if (data.state !== "error") return malformed();
  return { state: "error", checkedAt: timestamp(data.checkedAt), code: choice<WorkerProbeCode>(data.code, ["not_found", "permission_denied", "timeout", "command_failed", "invalid_output", "invalid_sample", "out_of_range", "io_error", "unavailable"]) };
};
const software = <T extends "not_installed" | "not_running">(value: unknown, absent: T): WorkerProbe<string> | { readonly state: T; readonly checkedAt: string } => {
  const data = record(value);
  if (data.state !== absent) return probe(data, text);
  fields(data, ["state", "checkedAt"]);
  return { state: absent, checkedAt: timestamp(data.checkedAt) };
};
const assistantHost = (value: unknown, platform: TaskPlatform): WorkerAssistantHost => {
  const data = fields(value, ["protocolVersion", "observedAt", "defaultCwd", "defaultProvider", "providers", ...["creationConfigurationVersion"].filter(key => Object.hasOwn(record(value), key))]);
  const boundedText = (value: unknown, maxBytes: number): string => {
    const parsed = text(value);
    if (/\p{Cc}/u.test(parsed) || Buffer.byteLength(parsed, "utf8") > maxBytes) return malformed();
    return parsed;
  };
  const defaultCwd = boundedText(data.defaultCwd, 4096);
  const windowsPath = defaultCwd.replaceAll("\\", "/");
  const unc = windowsPath.startsWith("//") ? windowsPath.slice(2).split("/") : [];
  if (data.protocolVersion !== 1 || !(platform === "windows"
    ? /^[a-z]:\//i.test(windowsPath) || unc.length >= 2 && !!unc[0] && unc[0] !== "." && unc[0] !== "?" && !!unc[1]
    : defaultCwd.startsWith("/"))) return malformed();
  if (Object.hasOwn(data, "creationConfigurationVersion") && data.creationConfigurationVersion !== 1) return malformed();
  const providerNames = ["codex", "claude", "copilot"] as const;
  const providers = array(data.providers, value => {
    const entry = fields(value, ["provider", "available", "reason", "model", "args"]);
    const reason = entry.reason === null ? null : choice<WorkerAssistantHostReason>(entry.reason,
      ["unsupported_arguments", "invalid_cwd", "not_found", "permission_denied", "timeout", "command_failed", "invalid_output", "unavailable"]);
    const model = entry.model === null ? null : boundedText(entry.model, 256);
    const args = array(entry.args, value => boundedText(value, 4096));
    if (typeof entry.available !== "boolean" || entry.available !== (reason === null) || args.length > 128
      || reason === "unsupported_arguments" && (model !== null || args.length !== 0)) return malformed();
    return { provider: choice(entry.provider, providerNames), available: entry.available, reason, model, args };
  });
  if (providers.length !== 3 || new Set(providers.map(entry => entry.provider)).size !== 3) return malformed();
  return { protocolVersion: 1, ...(data.creationConfigurationVersion === undefined ? {} : { creationConfigurationVersion: 1 }), observedAt: timestamp(data.observedAt), defaultCwd,
    defaultProvider: choice(data.defaultProvider, providerNames), providers };
};
const telemetry = (value: unknown): WorkerTelemetry => {
  const data = fields(value, ["machine", "platform", "workingDirectory", "sampledAt", "os", "cpu", "memory", "disk", "versions", ...["assistantHost", "runtimeConfiguration"].filter(key => Object.hasOwn(record(value), key))]);
  const versions = fields(data.versions, ["daynight", "herdr", "codex", "copilot"]);
  return {
    ...(Object.hasOwn(data, "assistantHost") ? { assistantHost: assistantHost(data.assistantHost, executionPlatform(data.platform)) } : {}),
    ...(Object.hasOwn(data, "runtimeConfiguration") ? { runtimeConfiguration: parseWorkerRuntimeConfiguration(data.runtimeConfiguration) } : {}),
    machine: machine(data.machine), platform: executionPlatform(data.platform), workingDirectory: text(data.workingDirectory), sampledAt: timestamp(data.sampledAt),
    os: probe(data.os, value => {
      const os = fields(value, ["type", "release", "version", "arch"]);
      return { type: text(os.type), release: text(os.release), version: text(os.version), arch: text(os.arch) };
    }),
    cpu: probe(data.cpu, value => {
      const cpu = fields(value, ["model", "logicalProcessors", "usagePercent"]);
      const logicalProcessors = count(cpu.logicalProcessors), usagePercent = cpu.usagePercent;
      if (logicalProcessors === 0 || typeof usagePercent !== "number" || !Number.isFinite(usagePercent) || usagePercent < 0 || usagePercent > 100) return malformed();
      return { model: text(cpu.model), logicalProcessors, usagePercent };
    }),
    memory: probe(data.memory, value => {
      const memory = fields(value, ["usedBytes", "totalBytes"]);
      const usedBytes = count(memory.usedBytes), totalBytes = count(memory.totalBytes);
      if (usedBytes > totalBytes) return malformed();
      return { usedBytes, totalBytes };
    }),
    disk: probe(data.disk, value => {
      const disk = fields(value, ["availableBytes", "totalBytes"]);
      const availableBytes = count(disk.availableBytes), totalBytes = count(disk.totalBytes);
      if (availableBytes > totalBytes) return malformed();
      return { availableBytes, totalBytes };
    }),
    versions: { daynight: text(versions.daynight), herdr: software(versions.herdr, "not_running"), codex: software(versions.codex, "not_installed"), copilot: software(versions.copilot, "not_installed") },
  };
};
const summaryFields = ["workerId", "machine", "platform", "lastReportedAt", "taskObservationState", "taskObservedAt", "activeTaskCount"] as const;
const summary = (data: Record<string, unknown>): WorkerSummary => {
  const identity = { workerId: id(data.workerId), machine: machine(data.machine), platform: executionPlatform(data.platform), lastReportedAt: timestamp(data.lastReportedAt) };
  if (data.taskObservationState === "unavailable") {
    if (data.taskObservedAt !== null || data.activeTaskCount !== null) return malformed();
    return { ...identity, taskObservationState: "unavailable", taskObservedAt: null, activeTaskCount: null };
  }
  return { ...identity, taskObservationState: choice(data.taskObservationState, ["observed", "stale"]), taskObservedAt: timestamp(data.taskObservedAt), activeTaskCount: count(data.activeTaskCount) };
};
const cursor = (value: unknown): string | null => {
  if (value === null) return null;
  const parsed = plainText(value);
  if (parsed.length === 0 || parsed.length > 4096 || /[\u0000-\u001f\u007f]/u.test(parsed)) return malformed();
  return parsed;
};
export const parseWorkerPage = (value: unknown): WorkerPage => {
  const data = fields(value, ["observedAt", "items", "nextCursor"]);
  const items = array(data.items, value => summary(fields(value, summaryFields)));
  if (items.length > 100 || new Set(items.map(item => item.workerId)).size !== items.length) return malformed();
  return { observedAt: timestamp(data.observedAt), items, nextCursor: cursor(data.nextCursor) };
};
const task = (value: unknown): WorkerTaskSnapshot => {
  const data = fields(value, ["projectId", "taskId", "claimId", "title", "projectName", "status", "phase", "agent"]);
  return { projectId: id(data.projectId), taskId: id(data.taskId), claimId: id(data.claimId), title: text(data.title), projectName: text(data.projectName),
    status: choice<TaskStatus>(data.status, ["todo", "in_progress", "done"]), phase: choice<WorkerPhase>(data.phase, ["preparing", "executing", "verifying", "completing", "waiting", "paused"]), agent: choice<WorkerAgent>(data.agent, ["codex", "copilot", "claude"]) };
};
export const parseWorkerDetail = (value: unknown, workerId: string): WorkerDetailResponse => {
  const data = fields(value, ["observedAt", "worker"]);
  const worker = fields(data.worker, [...summaryFields, "telemetry", "inventoryObservedAt", "tasks"]);
  const observed = summary(worker), sampled = telemetry(worker.telemetry), tasks = array(worker.tasks, task);
  const inventoryObservedAt = worker.inventoryObservedAt === null ? null : timestamp(worker.inventoryObservedAt);
  if (observed.workerId !== canonicalId(workerId) || sampled.machine.id !== observed.machine.id || sampled.machine.name !== observed.machine.name || sampled.platform !== observed.platform || new Set(tasks.map(task => task.taskId)).size !== tasks.length) return malformed();
  if (observed.taskObservationState === "unavailable" ? inventoryObservedAt !== null || tasks.length !== 0 : inventoryObservedAt === null || observed.activeTaskCount !== tasks.length) return malformed();
  return { observedAt: timestamp(data.observedAt), worker: { ...observed, telemetry: sampled, inventoryObservedAt, tasks } };
};
