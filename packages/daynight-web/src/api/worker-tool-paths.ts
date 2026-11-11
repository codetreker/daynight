import { array, boolean as bool, malformed, record, timestamp } from "./parse";
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : malformed();
export type Tool = "codex" | "copilot" | "herdr";
export type ToolContext = "web" | "herdr";
export type ToolPathChoice = { readonly kind: "auto" } | { readonly kind: "path"; readonly path: string };
export type ToolPaths = Readonly<Record<Tool, ToolPathChoice>>;

export type WorkerCloudToolPaths = Readonly<Record<Tool, ToolPathChoice | null>>;
export type WorkerConfigurationCapabilities = { readonly controlMode: boolean; readonly toolPaths: boolean };
export type WorkerConfigurationCapabilityInput = WorkerConfigurationCapabilities | boolean;
export const workerConfigurationCapabilities = (value: WorkerConfigurationCapabilityInput = false): WorkerConfigurationCapabilities =>
  typeof value === "boolean" ? { controlMode: value, toolPaths: false } : value;
export const TOOL_PATH_REPORT_BYTES = 256 * 1024;
export type ToolPathErrorCode = "not_found" | "permission_denied" | "not_executable" | "invalid_path" | "unsupported_launcher" | "unrecognized_output" | "incompatible_runtime" | "probe_timeout" | "cleanup_unknown" | "tool_identity_changed" | "legacy_tool_identity_missing" | "io_error" | "unavailable";
export type ToolPathActual = {
  readonly selection: ToolPathChoice; readonly selectionKey: string; readonly entryPath: string; readonly executablePath: string;
  readonly interpreterPath: string | null; readonly source: "explicit" | "path" | "bundled"; readonly version: string; readonly checkedAt: string;
};
export type ToolPathObservation = {
  readonly tool: Tool; readonly context: ToolContext; readonly configurationSource: "local" | "cloud"; readonly targetRevision: string | null;
  readonly target: ToolPathChoice; readonly state: "not_checked" | "checking" | "pending" | "applied" | "error";
  readonly reason: "active_instance" | "cleanup_unconfirmed" | "configuration_unavailable" | "report_budget_exceeded" | null;
  readonly actual: ToolPathActual | null; readonly candidate: ToolPathActual | null;
  readonly activeSelectionCount: number | null; readonly activeSelectionsComplete: boolean;
  readonly activeObservationError: "legacy_tool_identity_missing" | "cleanup_unknown" | "inventory_unavailable" | null;
  readonly activeSelections: readonly { readonly actual: ToolPathActual; readonly executionCount: number | null; readonly instanceCount: number | null; readonly unconfirmedCount: number }[];
  readonly error: { readonly code: ToolPathErrorCode; readonly occurredAt: string } | null;
};
export type ToolPathTelemetry = { readonly schemaVersion: 1; readonly observedAt: string; readonly entries: readonly ToolPathObservation[] };
type Platform = "macos" | "linux" | "windows";
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return malformed();
  return data;
};
const choice = <T extends string>(value: unknown, choices: readonly T[]): T => typeof value === "string" && choices.includes(value as T) ? value as T : malformed();
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
// Match the server's JSON encoder, including HTML and line-separator escaping.
export const toolPathTelemetryBytes = (value: ToolPathTelemetry): number => bytes(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
const text = (value: unknown, limit: number): string => typeof value === "string" && value.trim() !== "" && value.isWellFormed() && !/\p{Cc}/u.test(value) && bytes(value) <= limit ? value : malformed();
const instant = (value: unknown): string => { const result = timestamp(value); return result.startsWith("0000-") || /^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(result) ? malformed() : result; };
const timeKey = (value: string) => value.slice(0, 19) + (value.slice(19, -1).replace(/^\./, "").padEnd(9, "0"));
const revision = (value: unknown): string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n ? value : malformed();
export const parseToolPath = (value: unknown, platform?: Platform): string => {
  const result = text(value, 4096);
  const windowsAbsolute = /^[a-z]:[\\/]/i.test(result) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(result);
  if (!(platform === "windows" ? windowsAbsolute : platform === undefined ? result.startsWith("/") || windowsAbsolute : result.startsWith("/"))) return malformed();
  return result;
};
export const parseToolPathChoice = (value: unknown, platform?: Platform): ToolPathChoice => {
  const data = record(value);
  if (data.kind === "auto") { exact(data, ["kind"]); return { kind: "auto" }; }
  exact(data, ["kind", "path"]);
  return data.kind === "path" ? { kind: "path", path: parseToolPath(data.path, platform) } : malformed();
};
export const parseWorkerCloudToolPaths = (value: unknown): WorkerCloudToolPaths => {
  const data = exact(value, ["codex", "copilot", "herdr"]);
  const entry = (value: unknown) => value === null ? null : parseToolPathChoice(value);
  return { codex: entry(data.codex), copilot: entry(data.copilot), herdr: entry(data.herdr) };
};
export const parseToolPathsBootstrap = (value: unknown): ToolPaths => {
  const data = parseWorkerCloudToolPaths(value);
  if (data.codex === null || data.copilot === null || data.herdr === null) return malformed();
  return { codex: data.codex, copilot: data.copilot, herdr: data.herdr };
};
export const sameToolPathChoice = (left: ToolPathChoice, right: ToolPathChoice): boolean => left.kind === right.kind && (left.kind === "auto" || right.kind === "path" && left.path === right.path);
const actual = (value: unknown, platform: Platform | undefined, observedAt: string): ToolPathActual => {
  const data = exact(value, ["selection", "selectionKey", "entryPath", "executablePath", "interpreterPath", "source", "version", "checkedAt"]);
  const checkedAt = instant(data.checkedAt), selection = parseToolPathChoice(data.selection, platform), source = choice(data.source, ["explicit", "path", "bundled"]);
  if (typeof data.selectionKey !== "string" || !/^[0-9a-f]{64}$/.test(data.selectionKey) || timeKey(checkedAt) > timeKey(observedAt) || (source === "explicit") !== (selection.kind === "path")) return malformed();
  return { selection, selectionKey: data.selectionKey, entryPath: parseToolPath(data.entryPath, platform), executablePath: parseToolPath(data.executablePath, platform), interpreterPath: data.interpreterPath === null ? null : parseToolPath(data.interpreterPath, platform), source, version: text(data.version, 256), checkedAt };
};
const errorCodes: readonly ToolPathErrorCode[] = ["not_found", "permission_denied", "not_executable", "invalid_path", "unsupported_launcher", "unrecognized_output", "incompatible_runtime", "probe_timeout", "cleanup_unknown", "tool_identity_changed", "legacy_tool_identity_missing", "io_error", "unavailable"];
export const parseToolPathTelemetry = (value: unknown, platform?: Platform, enforceBudget = true): ToolPathTelemetry => {
  const data = exact(value, ["schemaVersion", "observedAt", "entries"]), observedAt = instant(data.observedAt), seen = new Set<string>();
  if (data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > 5 || enforceBudget && toolPathTelemetryBytes(value as ToolPathTelemetry) > TOOL_PATH_REPORT_BYTES) return malformed();
  const entries = array(data.entries, value => {
    const data = exact(value, ["tool", "context", "configurationSource", "targetRevision", "target", "state", "reason", "actual", "candidate", "activeSelectionCount", "activeSelectionsComplete", "activeObservationError", "activeSelections", "error"]);
    const tool = choice(data.tool, ["codex", "copilot", "herdr"]), context = choice(data.context, ["web", "herdr"]), key = `${tool}/${context}`;
    if (tool === "herdr" && context === "web" || seen.has(key)) return malformed();
    seen.add(key);
    const configurationSource = choice(data.configurationSource, ["local", "cloud"]), target = parseToolPathChoice(data.target);
    const targetRevision = configurationSource === "cloud" ? revision(data.targetRevision) : data.targetRevision === null ? null : malformed();
    const state = choice(data.state, ["not_checked", "checking", "pending", "applied", "error"]), reason = data.reason === null ? null : choice(data.reason, ["active_instance", "cleanup_unconfirmed", "configuration_unavailable", "report_budget_exceeded"]);
    const current = data.actual === null ? null : actual(data.actual, platform, observedAt), candidate = data.candidate === null ? null : actual(data.candidate, platform, observedAt);
    const activeSelectionCount = data.activeSelectionCount === null ? null : count(data.activeSelectionCount), activeSelectionsComplete = bool(data.activeSelectionsComplete);
    const activeObservationError = data.activeObservationError === null ? null : choice(data.activeObservationError, ["legacy_tool_identity_missing", "cleanup_unknown", "inventory_unavailable"]);
    let previous = "";
    const activeSelections = array(data.activeSelections, value => {
      const group = exact(value, ["actual", "executionCount", "instanceCount", "unconfirmedCount"]), selected = actual(group.actual, platform, observedAt);
      if (selected.selectionKey <= previous) return malformed(); previous = selected.selectionKey;
      return { actual: selected, executionCount: group.executionCount === null ? null : count(group.executionCount), instanceCount: group.instanceCount === null ? null : count(group.instanceCount), unconfirmedCount: count(group.unconfirmedCount) };
    });
    let error: ToolPathObservation["error"] = null;
    if (data.error !== null) { const failure = exact(data.error, ["code", "occurredAt"]); error = { code: choice(failure.code, errorCodes), occurredAt: instant(failure.occurredAt) }; if (timeKey(error.occurredAt) > timeKey(observedAt)) return malformed(); }
    if (activeSelections.length > 8 || activeSelectionCount !== null && activeSelectionCount < activeSelections.length || activeSelectionsComplete && (activeSelectionCount !== activeSelections.length || activeObservationError !== null)
      || (state === "error") !== (error !== null) || state === "applied" && (current === null || !sameToolPathChoice(current.selection, target)) || state === "not_checked" && (current !== null || candidate !== null) || reason !== null && state !== "pending") return malformed();
    return { tool, context, configurationSource, targetRevision, target, state, reason, actual: current, candidate, activeSelectionCount, activeSelectionsComplete, activeObservationError, activeSelections, error };
  });
  return { schemaVersion: 1, observedAt, entries };
};
