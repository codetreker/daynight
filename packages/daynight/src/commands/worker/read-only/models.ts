import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createOperation, OperationError, type Operation } from "../../../api/operation.js";
import type { WorkerCloudNative } from "../../../api/worker-configuration.js";
import type { WorkerAgent, WorkerRuntimeNative } from "../../../api/types.js";
import type { NativeModelObservation, NativeModelOption } from "../../controller/providers/native-selection.js";
import { assertNativeModelSelection } from "../../controller/providers/native-selection.js";
import { BotCliProbeCleanupError } from "../bots/cli-probe.js";

export type WorkerModelInput = { provider: WorkerAgent; cwd?: string; model?: string; includeHidden?: boolean; limit?: number; cursor?: string };
export type WorkerModelDefault = { value: string | null; source: "explicit" | "local" | "cloud" | "native" | "unknown" };
export type WorkerModelEntry = { id: string; label: string; aliases: string[]; hidden: boolean; reasoningEfforts: string[] | null; defaultReasoningEffort: string | null };
export type WorkerModelResult = {
  schemaVersion: 1; provider: WorkerAgent; cwd: string; configurationGeneration: string; catalogGeneration: string;
  models: WorkerModelEntry[]; defaults: { model: WorkerModelDefault; reasoningEffort: WorkerModelDefault };
  selectionError: { code: "unknown_default" | "unsupported_selection"; message: string } | null; nextCursor: string | null;
};
export type WorkerModelDiscoveryErrorCode = "invalid_input" | "capability_error" | "cleanup_unknown" | "stale_configuration" | "invalid_cursor" | "limit_exceeded" | "timeout" | "cancelled" | "invalid_path" | "not_found" | "permission_denied" | "busy";
export class WorkerModelDiscoveryError extends Error {
  constructor(readonly code: WorkerModelDiscoveryErrorCode, options?: ErrorOptions) { super(`Worker model discovery failed (${code}).`, options); this.name = "WorkerModelDiscoveryError"; }
}
const text = (value: unknown, bytes: number): value is string => typeof value === "string" && value.trim() !== "" && value.isWellFormed() && !/\p{Cc}/u.test(value) && Buffer.byteLength(value) <= bytes;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const absolute = (value: unknown): value is string => text(value, 4096) && (process.platform === "win32" ? /^[a-z]:[\\/]|^\\\\[^\\/?.][^\\/]*[\\/][^\\/]+(?:[\\/]|$)/i.test(value) : path.isAbsolute(value));
export const parseWorkerModelInput = (value: unknown): WorkerModelInput => {
  if (!record(value) || Object.keys(value).some(key => !["provider", "cwd", "model", "includeHidden", "limit", "cursor"].includes(key))
    || typeof value.provider !== "string" || !["codex", "claude", "copilot"].includes(value.provider)
    || Object.hasOwn(value, "cwd") && !absolute(value.cwd) || Object.hasOwn(value, "model") && !text(value.model, 256)
    || Object.hasOwn(value, "includeHidden") && typeof value.includeHidden !== "boolean"
    || Object.hasOwn(value, "limit") && (!Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)
    || Object.hasOwn(value, "cursor") && !text(value.cursor, 4096)) throw new WorkerModelDiscoveryError("invalid_input");
  return { ...value } as WorkerModelInput;
};
const hasCleanup = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (seen.has(error)) return false;
  seen.add(error);
  return error instanceof BotCliProbeCleanupError || record(error) && error.code === "cleanup_unknown" || error instanceof AggregateError && error.errors.some(child => hasCleanup(child, seen))
    || error instanceof Error && error.cause !== undefined && hasCleanup(error.cause, seen);
};
const failure = (error: unknown, operation: Operation, signal: AbortSignal): WorkerModelDiscoveryError => {
  if (hasCleanup(error)) return new WorkerModelDiscoveryError("cleanup_unknown", { cause: error });
  if (error instanceof WorkerModelDiscoveryError) return error;
  if (signal.aborted) return new WorkerModelDiscoveryError("cancelled", { cause: error });
  if (operation.signal.aborted || error instanceof OperationError) return new WorkerModelDiscoveryError("timeout", { cause: error });
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new WorkerModelDiscoveryError(code === "EACCES" || code === "EPERM" ? "permission_denied" : code === "ENOENT" ? "not_found"
    : code === "ENOTDIR" || code === "ELOOP" ? "invalid_path" : code === "limit_exceeded" ? "limit_exceeded" : "capability_error", { cause: error });
};
const list = (value: unknown, count: number, bytes: number): value is readonly string[] => Array.isArray(value) && value.length <= count && value.every(item => text(item, bytes)) && new Set(value).size === value.length;
const entry = (model: NativeModelOption): WorkerModelEntry => {
  if (!text(model.id, 256) || model.label !== undefined && !text(model.label, 1024) || model.hidden !== undefined && typeof model.hidden !== "boolean"
    || model.aliases !== undefined && !list(model.aliases, 16, 256) || model.efforts !== null && !list(model.efforts, 32, 64)
    || model.defaultEffort !== undefined && model.defaultEffort !== null && !text(model.defaultEffort, 64)) throw new WorkerModelDiscoveryError("limit_exceeded");
  if (model.defaultEffort != null && !model.efforts?.includes(model.defaultEffort)) throw new WorkerModelDiscoveryError("capability_error");
  return { id: model.id, label: model.label ?? model.id, aliases: [...model.aliases ?? []], hidden: model.hidden ?? false,
    reasoningEfforts: model.efforts === null ? null : [...model.efforts], defaultReasoningEffort: model.defaultEffort ?? null };
};
const defaults = (input: WorkerModelInput, report: WorkerRuntimeNative, observation: NativeModelObservation, models: WorkerModelEntry[]): Pick<WorkerModelResult, "defaults" | "selectionError"> => {
  const model: WorkerModelDefault = input.model !== undefined ? { value: input.model, source: "explicit" } : report.model.value !== null ? { ...report.model }
    : observation.model === null ? { value: null, source: "unknown" } : { value: observation.model, source: "native" };
  const matching = models.filter(item => item.id === observation.model || item.aliases.includes(observation.model ?? ""));
  const selected = matching.find(item => item.id === model.value) ?? matching.find(item => item.aliases.includes(model.value ?? "")) ?? matching[0];
  const reasoningEffort: WorkerModelDefault = report.reasoningEffort.value !== null ? { ...report.reasoningEffort }
    : { value: observation.effort ?? selected?.defaultReasoningEffort ?? null, source: "native" };
  let selectionError: WorkerModelResult["selectionError"] = null;
  if (observation.model === null) selectionError = { code: "unknown_default", message: "The native provider did not confirm the effective model." };
  else {
    try { assertNativeModelSelection(input.provider, { model: input.model ?? report.model.value, ...(report.reasoningEffort.value === null ? {} : { effort: report.reasoningEffort.value }) }, observation); }
    catch { selectionError = { code: "unsupported_selection", message: "The native provider did not confirm a supported effective model and reasoning effort selection." }; }
  }
  return { defaults: { model, reasoningEffort }, selectionError };
};

type Configuration = { native: WorkerCloudNative; report: WorkerRuntimeNative };
type Snapshot = { result: Omit<WorkerModelResult, "nextCursor">; configuration: string; query: string; expires: number };
type Verifier = { discover(options: { native: WorkerCloudNative; cwd: string; environment: NodeJS.ProcessEnv }, operation: Operation): Promise<NativeModelObservation> };
/** A catalog is read on demand. Only bounded pagination snapshots survive a request; no existing Session is consulted. */
export const createWorkerModelDiscovery = (options: { configuration(): Configuration; defaultCwd: string; environment: NodeJS.ProcessEnv; verifier: Verifier }) => {
  const snapshots = new Map<string, Snapshot>(), secret = randomBytes(32), environment = { ...options.environment };
  let closed = false, occupied = 0, epoch = 0;
  const signature = (): string => JSON.stringify(options.configuration());
  const cursor = (id: string, offset: number): string => {
    const body = `${id}:${offset}`;
    return `${body}:${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };
  const decode = (value: string): { id: string; offset: number } => {
    const parts = value.split(":"), body = `${parts[0]}:${parts[1]}`;
    if (parts.length !== 3 || !/^\d+$/.test(parts[1] ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? "")) throw new WorkerModelDiscoveryError("invalid_cursor");
    const expected = createHmac("sha256", secret).update(body).digest(), supplied = Buffer.from(parts[2]!, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new WorkerModelDiscoveryError("invalid_cursor");
    return { id: parts[0]!, offset: Number(parts[1]) };
  };
  const page = (snapshot: Snapshot, limit: number, offset: number): WorkerModelResult => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= snapshot.result.models.length && offset !== 0) throw new WorkerModelDiscoveryError("invalid_cursor");
    let end = Math.min(snapshot.result.models.length, offset + limit);
    while (end >= offset) {
      const result = { ...snapshot.result, models: snapshot.result.models.slice(offset, end), nextCursor: end < snapshot.result.models.length ? cursor(snapshot.result.catalogGeneration, end) : null };
      if (Buffer.byteLength(JSON.stringify(result)) <= 65_536 && (end > offset || snapshot.result.models.length === 0)) return structuredClone(result);
      end--;
    }
    throw new WorkerModelDiscoveryError("limit_exceeded");
  };
  return {
    discover: async (unvalidated: WorkerModelInput, signal: AbortSignal): Promise<WorkerModelResult> => {
      const input = parseWorkerModelInput(unvalidated);
      if (closed || signal.aborted) throw new WorkerModelDiscoveryError("cancelled");
      if (occupied >= 4) throw new WorkerModelDiscoveryError("busy");
      occupied++;
      const admittedEpoch = epoch;
      const operation = createOperation({ signal, limits: { totalMs: 25_000, requestMs: 25_000, responseBytes: 65_536, totalBytes: 65_536 } });
      let directory: Promise<string> | undefined;
      try {
        const configurationSignature = signature(), configuration = JSON.parse(configurationSignature) as Configuration;
        const requestedPath = input.cwd ?? options.defaultCwd;
        if (!absolute(requestedPath)) throw new WorkerModelDiscoveryError("invalid_path");
        directory = (async () => {
          const cwd = await realpath(requestedPath);
          if (!absolute(cwd) || !(await stat(cwd)).isDirectory()) throw new WorkerModelDiscoveryError("invalid_path");
          await access(cwd, constants.R_OK | constants.X_OK);
          return cwd;
        })();
        const cwd = await new Promise<string>((resolve, reject) => {
          const abort = (): void => { operation.signal.removeEventListener("abort", abort); reject(operation.signal.reason); };
          operation.signal.addEventListener("abort", abort, { once: true });
          if (operation.signal.aborted) abort();
          directory!.then(value => { operation.signal.removeEventListener("abort", abort); resolve(value); }, error => { operation.signal.removeEventListener("abort", abort); reject(error); });
        });
        operation.check();
        if (admittedEpoch !== epoch) throw new WorkerModelDiscoveryError("stale_configuration");
        for (const [id, value] of snapshots) if (value.expires <= Date.now()) snapshots.delete(id);
        const limit = input.limit ?? 100, query = JSON.stringify({ provider: input.provider, cwd, model: input.model ?? null, includeHidden: input.includeHidden ?? false, limit });
        if (input.cursor !== undefined) {
          const position = decode(input.cursor), snapshot = snapshots.get(position.id);
          if (snapshot === undefined || snapshot.query !== query) throw new WorkerModelDiscoveryError("invalid_cursor");
          if (snapshot.configuration !== configurationSignature || signature() !== configurationSignature) throw new WorkerModelDiscoveryError("stale_configuration");
          return page(snapshot, limit, position.offset);
        }
        const sameProvider = configuration.native.agent === input.provider;
        const selectedNative: WorkerCloudNative = sameProvider ? { ...configuration.native, args: [...configuration.native.args] } : { agent: input.provider, model: null, args: [] };
        const native = input.model === undefined ? selectedNative : { ...selectedNative, model: input.model };
        const report: WorkerRuntimeNative = sameProvider ? configuration.report : { agent: input.provider, model: { value: null, source: "native" }, reasoningEffort: { value: null, source: "native" } };
        const observation = await options.verifier.discover({ native, cwd, environment }, operation);
        operation.check();
        if (closed) throw new WorkerModelDiscoveryError("cancelled");
        if (admittedEpoch !== epoch) throw new WorkerModelDiscoveryError("stale_configuration");
        if (signature() !== configurationSignature) throw new WorkerModelDiscoveryError("stale_configuration");
        if (!Array.isArray(observation.models) || observation.models.length > 500) throw new WorkerModelDiscoveryError("limit_exceeded");
        if (observation.model !== null && !text(observation.model, 256) || observation.effort != null && !text(observation.effort, 64)) throw new WorkerModelDiscoveryError("capability_error");
        const models = observation.models.map(entry);
        if (new Set(models.map(model => model.id)).size !== models.length) throw new WorkerModelDiscoveryError("capability_error");
        const resolved = defaults(input, report, observation, models), catalogGeneration = randomUUID();
        const snapshot: Snapshot = { configuration: configurationSignature, query, expires: Date.now() + 30_000,
          result: { schemaVersion: 1, provider: input.provider, cwd,
            configurationGeneration: createHash("sha256").update(JSON.stringify([configurationSignature, input.provider, cwd, input.model ?? null])).digest("hex"),
            catalogGeneration, models: input.includeHidden ? models : models.filter(model => !model.hidden), ...resolved } };
        const result = page(snapshot, limit, 0);
        if (result.nextCursor !== null) {
          while (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value!);
          snapshots.set(catalogGeneration, snapshot);
        }
        return result;
      } catch (error) { throw failure(error, operation, signal); }
      finally {
        operation.dispose();
        // Timed-out filesystem calls keep their slot until they really settle.
        if (directory !== undefined) void directory.then(() => { occupied--; }, () => { occupied--; });
        else occupied--;
      }
    },
    invalidate: (): void => { epoch++; snapshots.clear(); },
    close: (): void => { closed = true; epoch++; snapshots.clear(); },
  };
};
