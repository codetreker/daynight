import type { WorkerExecutableProbe, WorkerHerdrProbe, WorkerProbe } from "../../api/types.js";
import { terminalText } from "../../platform/terminal.js";
import type { WorkerDetailResponse, WorkerList, WorkerSummary } from "./query-api.js";

const line = (name: string, value: string): string => `${name}: ${terminalText(value)}`;
const recentReport = (observedAt: string, reportedAt: string): boolean => {
  const age = Date.parse(observedAt) - Date.parse(reportedAt);
  return age >= 0 && age < 120_000;
};
const summary = (worker: WorkerSummary, observedAt: string): string[] => [
  line("ID", worker.workerId),
  line("Machine", `${worker.machine.name} (${worker.machine.id})`),
  line("Platform", worker.platform),
  line("Connection", `${recentReport(observedAt, worker.lastReportedAt) ? "online" : "offline"} (at observation)`),
  line("Last reported", worker.lastReportedAt),
  line("Task inventory", worker.taskObservationState),
  line("Tasks observed", worker.taskObservedAt ?? "unknown"),
  line("Active tasks", worker.activeTaskCount === null ? "unknown" : `${worker.activeTaskCount}${worker.taskObservationState === "stale" ? " (stale)" : ""}`),
];
const probe = <T>(name: string, value: WorkerProbe<T>, describe: (value: T) => string): string =>
  line(name, `${value.state === "ok" ? describe(value.value) : `error (${value.code})`} [checked ${value.checkedAt}]`);
const software = (name: string, value: WorkerExecutableProbe | WorkerHerdrProbe): string =>
  line(name, `${value.state === "ok" ? value.value : value.state === "error" ? `error (${value.code})` : value.state} [checked ${value.checkedAt}]`);

export const renderWorkerList = (result: WorkerList): string => {
  const heading = `${line("Observed", result.observedAt)}\n`;
  if (result.items.length === 0) return `${heading}No recently reported Workers.\n`;
  return `${heading}\n${result.items.map(worker => summary(worker, result.observedAt).join("\n")).join("\n\n")}\n`;
};

export const renderWorkerDetail = (result: WorkerDetailResponse): string => {
  const worker = result.worker, telemetry = worker.telemetry;
  const output = [line("Observed", result.observedAt), ...summary(worker, result.observedAt),
    line("Working directory", telemetry.workingDirectory), line("Sampled", telemetry.sampledAt),
    probe("OS", telemetry.os, value => `${value.type} ${value.release} ${value.version} (${value.arch})`),
    probe("CPU", telemetry.cpu, value => `${value.model}; ${value.logicalProcessors} logical processors; ${value.usagePercent}% used`),
    probe("Memory", telemetry.memory, value => `${value.usedBytes}/${value.totalBytes} bytes used`),
    probe("Disk", telemetry.disk, value => `${value.availableBytes}/${value.totalBytes} bytes available`),
    line("Daynight", telemetry.versions.daynight), software("Herdr", telemetry.versions.herdr),
    software("Codex", telemetry.versions.codex), software("Copilot", telemetry.versions.copilot),
  ];
  const host = telemetry.assistantHost;
  if (host === undefined) output.push("Assistant hosting: unsupported (not reported)");
  else {
    output.push(line("Assistant hosting", `protocol ${host.protocolVersion}; ${recentReport(result.observedAt, host.observedAt) ? "reported" : "stale"}; observed ${host.observedAt}`),
      line("Assistant default directory", host.defaultCwd), line("Assistant default Agent", host.defaultProvider));
    for (const provider of host.providers) output.push(line(`Assistant ${provider.provider}`, `${provider.available ? "available at preflight" : `unavailable (${provider.reason})`}; model=${provider.model ?? "native default"}; args=${JSON.stringify(provider.args)}`));
  }
  output.push(line("Inventory sampled", worker.inventoryObservedAt ?? "unknown"));
  for (const task of worker.tasks) output.push("", line("Task", `${task.title} (${task.taskId})`), line("Project", `${task.projectName} (${task.projectId})`), line("Claim", task.claimId), line("Task status", task.status), line("Phase", task.phase), line("Agent", task.agent));
  return `${output.join("\n")}\n`;
};
