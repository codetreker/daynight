import { OperationError, type Operation } from "../../api/operation.js";
import { boundToolPathTelemetry, parseToolPathsBootstrap, sameToolPathChoice, toolPathErrorCode, type ToolPathActual, type ToolPathObservation, type ToolPathTelemetry } from "../../api/worker-tool-paths.js";
import { captureToolEnvironment, resolveToolLaunch, verifyToolLaunch, ToolSelectionError, type ResolvedToolLaunch, type Tool, type ToolContext, type ToolPathChoice, type ToolPaths } from "../../platform/tool-executables.js";
import type { FrozenToolObservation } from "./types.js";
import { withinOperation } from "../../platform/tool-io.js";

export type ToolSelectionTargets = { readonly source: "local" | "cloud"; readonly revision: string | null; readonly choices: ToolPaths };
export type ToolSelectionProbe = {
  reconcile?(launch: ResolvedToolLaunch, operation: Operation): Promise<unknown>;
  admit?(launch: ResolvedToolLaunch, receipt: unknown): void;
  check(launch: ResolvedToolLaunch, operation: Operation): Promise<{ version: string; checkedAt?: string }>;
  assertAvailable?(launch: ResolvedToolLaunch): void;
  cacheToken?(launch: ResolvedToolLaunch): unknown;
  close(operation: Operation): Promise<void>;
};
/** Durable execution inventory only. A new probe cannot supply a missing historical version. */
export type ActiveToolSelection = {
  readonly tool: Tool; readonly context: ToolContext; readonly launch: ResolvedToolLaunch | null;
  readonly version: string | null; readonly checkedAt: string | null;
  readonly executionCount: number | null; readonly instanceCount: number | null; readonly unconfirmedCount: number;
};
export type HerdrToolAdmission = (launch: ResolvedToolLaunch, operation: Operation) => Promise<{ state: "applied"; version: string; checkedAt: string } | { state: "pending"; reason: "active_instance" | "cleanup_unconfirmed" }>;
type Options = {
  readonly admitHerdr?: HerdrToolAdmission;
  readonly environment: NodeJS.ProcessEnv; readonly cwd: string; readonly workerNode?: string;
  readonly probe: ToolSelectionProbe; readonly readActiveSelections: () => readonly ActiveToolSelection[];
  readonly prepareLaunch?: (source: ResolvedToolLaunch, operation: Operation) => Promise<ResolvedToolLaunch>;
  readonly resolve?: typeof resolveToolLaunch; readonly verify?: (launch: ResolvedToolLaunch, operation: Operation) => Promise<void>;
  readonly now?: () => string;
};
type Slot = {
  tool: Tool; context: ToolContext; epoch: number; state: ToolPathObservation["state"]; reason: ToolPathObservation["reason"];
  actual: ToolPathActual | null; candidate: ToolPathActual | null; launch: ResolvedToolLaunch | undefined; token: unknown;
  error: ToolPathObservation["error"]; pending: { epoch: number; promise: Promise<void> } | undefined;
  probeRecipe: ResolvedToolLaunch | undefined; tail: Promise<void> | undefined;
};
const contexts = [["codex", "web"], ["codex", "herdr"], ["copilot", "web"], ["copilot", "herdr"], ["herdr", "herdr"]] as const;
const automatic = (): ToolPaths => ({ codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } });
const clone = <T>(value: T): T => structuredClone(value);
const selection = (launch: ResolvedToolLaunch): ToolPathChoice => launch.source === "explicit" ? { kind: "path", path: launch.entryPath } : { kind: "auto" };
const actual = (launch: ResolvedToolLaunch, version: string, checkedAt: string): ToolPathActual => ({ selection: selection(launch), selectionKey: launch.selectionKey, entryPath: launch.entryPath, executablePath: launch.executablePath, interpreterPath: launch.interpreterPath, source: launch.source, version, checkedAt });
const validVersion = (value: string): boolean => value.trim() !== "" && value.isWellFormed() && !/\p{Cc}/u.test(value) && Buffer.byteLength(value) <= 256;
const validTime = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && !value.startsWith("0000-");
const count = (value: number | null): boolean => value === null || Number.isSafeInteger(value) && value >= 0;

/** Own target generations and admission facts; process owners retain their cleanup acknowledgements. */
export class ToolSelectionManager {
  private targets: ToolSelectionTargets = { source: "local", revision: null, choices: automatic() };
  private readonly slots = new Map<string, Slot>(contexts.map(([tool, context]) => [`${tool}/${context}`, { tool, context, epoch: 0, state: "not_checked", reason: null, actual: null, candidate: null, launch: undefined, token: undefined, error: null, pending: undefined, probeRecipe: undefined, tail: undefined }]));
  private readonly inFlight = new Set<Promise<void>>();
  private probeClosing: Promise<void> | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private closed = false;
  private suspended = false;
  constructor(private readonly options: Options) { this.environment = captureToolEnvironment(options.environment); }
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  private slot(tool: Tool, context: ToolContext): Slot { const result = this.slots.get(`${tool}/${context}`); if (!result) throw new TypeError("Unsupported tool context."); return result; }
  private checkOpen(slot: Slot, operation: Operation): void { operation.check(); if (this.closed) throw new ToolSelectionError(slot.tool, slot.context, "launch", "cancelled"); }
  private usable(slot: Slot): boolean {
    if (this.closed || this.suspended || slot.state !== "applied" || !slot.launch || !sameToolPathChoice(selection(slot.launch), this.targets.choices[slot.tool])) return false;
    try { this.options.probe.assertAvailable?.(slot.launch); return Object.is(slot.token, this.options.probe.cacheToken?.(slot.launch)); } catch { return false; }
  }
  private fail(slot: Slot, error: unknown): void { slot.state = "error"; slot.reason = null; slot.launch = undefined; slot.error = { code: toolPathErrorCode(error), occurredAt: this.now() }; }
  suspendTargets(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    for (const slot of this.slots.values()) {
      slot.epoch++; slot.pending = undefined; slot.launch = undefined; slot.candidate = null; slot.error = null;
      slot.state = "pending"; slot.reason = "configuration_unavailable";
    }
  }
  setTargets(input: ToolSelectionTargets): void {
    if (this.closed) throw new Error("Tool selection manager is closed.");
    if (input.source === "local" ? input.revision !== null : input.source !== "cloud" || typeof input.revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(input.revision) || BigInt(input.revision) > 9_223_372_036_854_775_807n) throw new TypeError("Invalid tool target revision.");
    this.suspended = false;
    const next = { source: input.source, revision: input.revision, choices: parseToolPathsBootstrap(input.choices) };
    for (const slot of this.slots.values()) {
      const sameChoice = sameToolPathChoice(this.targets.choices[slot.tool], next.choices[slot.tool]);
      if (sameChoice && this.targets.source === next.source && this.targets.revision === next.revision) continue;
      slot.epoch++; slot.pending = undefined;
      if (sameChoice && this.usable(slot)) continue;
      slot.launch = undefined; slot.candidate = null; slot.error = null; slot.state = slot.actual === null ? "not_checked" : "pending"; slot.reason = slot.actual === null ? null : "configuration_unavailable";
    }
    this.targets = clone(next);
  }
  /** Configuration proof keys are read without I/O. */
  currentSelection(tool: Tool, context: ToolContext): ResolvedToolLaunch | undefined { const slot = this.slot(tool, context); return this.usable(slot) ? clone(slot.launch!) : undefined; }
  /** Historical facts may be frozen only from the same successfully inspected recipe. */
  observationFor(launch: ResolvedToolLaunch): FrozenToolObservation | undefined {
    const slot = this.slot(launch.tool, launch.context);
    return this.usable(slot) && slot.actual?.selectionKey === launch.selectionKey ? { version: slot.actual.version, checkedAt: slot.actual.checkedAt } : undefined;
  }
  async prepare(tool: Tool, context: ToolContext, operation: Operation): Promise<void> {
    const slot = this.slot(tool, context); this.checkOpen(slot, operation);
    if (this.suspended) throw new Error("Worker tool configuration is unavailable.");
    if (context === "herdr" && this.options.admitHerdr === undefined) {
      if (this.targets.choices[tool].kind === "auto") return;
      const error = new ToolSelectionError(tool, context, "launch", "incompatible_runtime"); this.fail(slot, error); throw error;
    }
    if (this.usable(slot)) {
      const verified = slot.launch!, verifiedEpoch = slot.epoch;
      try { await this.verifyFrozen(verified, operation); this.options.probe.assertAvailable?.(verified); }
      catch (error) {
        if (slot.epoch === verifiedEpoch && slot.launch === verified) { slot.epoch++; this.fail(slot, error); }
        if (toolPathErrorCode(error) !== "tool_identity_changed") throw error;
      }
      // A file recipe can remain valid after its shared daemon exits. Re-enter
      // instance admission before publishing Herdr readiness for new execution.
      if (slot.epoch === verifiedEpoch && this.usable(slot) && tool !== "herdr") return;
    }
    if (slot.pending?.epoch === slot.epoch) return withinOperation(slot.pending.promise, operation);
    const epoch = slot.epoch, choice = clone(this.targets.choices[tool]); slot.state = "checking"; slot.reason = null; slot.error = null;
    const previous = slot.tail;
    const running = (async () => {
      try {
        // A superseded inspection may still own a process. Join it before
        // reconciling its recipe, even when the new target has a different key.
        if (previous) await withinOperation(previous, operation);
        this.checkOpen(slot, operation); if (slot.epoch !== epoch) return;
        const priorRecipe = slot.probeRecipe;
        let receipt: unknown;
        if (priorRecipe && this.options.probe.reconcile) receipt = await withinOperation(this.options.probe.reconcile(priorRecipe, operation), operation);
        this.checkOpen(slot, operation); if (slot.epoch !== epoch) return;
        let launch = await (this.options.resolve ?? resolveToolLaunch)({ tool, context, choice, environment: this.environment, cwd: this.options.cwd, ...(this.options.workerNode === undefined ? {} : { workerNode: this.options.workerNode }) }, operation);
        this.checkOpen(slot, operation); if (slot.epoch !== epoch) return;
        if (this.options.prepareLaunch) launch = await this.options.prepareLaunch(launch, operation);
        await (this.options.verify ?? verifyToolLaunch)(launch, operation); this.checkOpen(slot, operation); if (slot.epoch !== epoch) return;
        // Recovery must reach the original process owner before the read-only
        // admission gate, and its result precedes the new inspection generation.
        if ((!priorRecipe || priorRecipe.selectionKey !== launch.selectionKey) && this.options.probe.reconcile) receipt = await withinOperation(this.options.probe.reconcile(launch, operation), operation);
        this.checkOpen(slot, operation); if (slot.epoch !== epoch) return;
        this.options.probe.assertAvailable?.(launch); const token = this.options.probe.cacheToken?.(launch);
        this.options.probe.admit?.(launch, receipt);
        slot.probeRecipe = clone(launch);
        let result = await this.options.probe.check(launch, operation); operation.check();
        if (!validVersion(result.version)) throw new ToolSelectionError(tool, context, "probe", "unrecognized_output");
        const checkedAt = result.checkedAt ?? this.now();
        if (!validTime(checkedAt) || Date.parse(checkedAt) > Date.parse(this.now())) throw new ToolSelectionError(tool, context, "probe", "unrecognized_output");
        this.options.probe.assertAvailable?.(launch);
        if (!Object.is(token, this.options.probe.cacheToken?.(launch))) throw new ToolSelectionError(tool, context, "probe", "cleanup_unknown");
        if (this.closed || slot.epoch !== epoch) return;
        if (tool === "herdr" && this.options.admitHerdr !== undefined) {
          slot.candidate = actual(launch, result.version, checkedAt);
          const admission = await this.options.admitHerdr(launch, operation); this.checkOpen(slot, operation);
          if (slot.epoch !== epoch) return;
          if (admission.state === "pending") { slot.state = "pending"; slot.reason = admission.reason; slot.launch = undefined; return; }
          if (!validVersion(admission.version) || !validTime(admission.checkedAt) || Date.parse(admission.checkedAt) > Date.parse(this.now())) throw new ToolSelectionError(tool, context, "probe", "unrecognized_output");
          result = admission;
        }
        slot.candidate = null;
        slot.launch = clone(launch); slot.token = token; slot.actual = actual(launch, result.version, result.checkedAt ?? checkedAt); slot.state = "applied"; slot.reason = null; slot.error = null;
      } catch (error) {
        const failure = error instanceof OperationError ? new ToolSelectionError(tool, context, "probe", error.kind === "cancelled" || error.kind === "disposed" ? "cancelled" : "probe_timeout", { cause: error }) : error;
        if (!this.closed && slot.epoch === epoch) this.fail(slot, failure);
        throw failure;
      }
    })();
    slot.pending = { epoch, promise: running }; slot.tail = running.then(() => {}, () => {}); this.inFlight.add(running);
    try { await running; } finally { this.inFlight.delete(running); if (slot.pending?.promise === running) slot.pending = undefined; }
  }
  async selectForNewExecution(tool: Tool, context: ToolContext, operation: Operation): Promise<ResolvedToolLaunch> {
    const slot = this.slot(tool, context); this.checkOpen(slot, operation);
    if (context === "herdr" && this.options.admitHerdr === undefined) throw new ToolSelectionError(tool, context, "launch", "incompatible_runtime");
    for (;;) {
      await this.prepare(tool, context, operation); this.checkOpen(slot, operation);
      if (slot.state === "pending" && (slot.reason === "active_instance" || slot.reason === "cleanup_unconfirmed")) throw new Error(`Herdr tool selection is pending: ${slot.reason}.`);
      if (!this.usable(slot)) continue;
      const epoch = slot.epoch, launch = slot.launch!;
      try { await this.verifyFrozen(launch, operation); this.options.probe.assertAvailable?.(launch); }
      catch (error) {
        if (slot.epoch === epoch && slot.launch === launch) { slot.epoch++; this.fail(slot, error); }
        if (toolPathErrorCode(error) === "tool_identity_changed") continue;
        throw error;
      }
      if (epoch === slot.epoch && this.usable(slot)) return clone(launch);
    }
  }
  verifyFrozen(launch: ResolvedToolLaunch, operation: Operation): Promise<void> { return (this.options.verify ?? verifyToolLaunch)(launch, operation); }
  snapshot(): ToolPathTelemetry {
    let records: readonly ActiveToolSelection[] = [], inventoryFailed = false; try { records = this.options.readActiveSelections(); } catch { inventoryFailed = true; }
    const observedAt = this.now();
    const entries = [...this.slots.values()].map((slot): ToolPathObservation => {
      const invalidated = slot.state === "applied" && !this.usable(slot);
      const groups = new Map<string, ToolPathObservation["activeSelections"][number]>();
      let error: ToolPathObservation["activeObservationError"] = inventoryFailed ? "inventory_unavailable" : null, unknownCount = inventoryFailed;
      for (const record of records) {
        if (record.tool !== slot.tool || record.context !== slot.context) continue;
        if (!record.launch) { error = "legacy_tool_identity_missing"; unknownCount = true; continue; }
        if (record.version === null || record.checkedAt === null || !validVersion(record.version) || !validTime(record.checkedAt) || Date.parse(record.checkedAt) > Date.parse(observedAt) || !count(record.executionCount) || !count(record.instanceCount) || !count(record.unconfirmedCount)) {
          if (error !== "legacy_tool_identity_missing") error = "inventory_unavailable"; unknownCount = true; continue;
        }
        if (record.unconfirmedCount > 0 && error === null) error = "cleanup_unknown";
        const previous = groups.get(record.launch.selectionKey), sum = (left: number | null, right: number | null) => left === null || right === null ? null : left + right;
        groups.set(record.launch.selectionKey, { actual: previous?.actual ?? actual(record.launch, record.version, record.checkedAt), executionCount: previous ? sum(previous.executionCount, record.executionCount) : record.executionCount,
          instanceCount: previous ? sum(previous.instanceCount, record.instanceCount) : record.instanceCount, unconfirmedCount: (previous?.unconfirmedCount ?? 0) + record.unconfirmedCount });
      }
      return { tool: slot.tool, context: slot.context, configurationSource: this.targets.source, targetRevision: this.targets.revision, target: clone(this.targets.choices[slot.tool]), state: invalidated ? "pending" : slot.state, reason: invalidated ? "cleanup_unconfirmed" : slot.reason, actual: slot.actual, candidate: slot.candidate, error: slot.error,
        activeSelectionCount: unknownCount ? null : groups.size, activeSelectionsComplete: !unknownCount && error === null, activeObservationError: error, activeSelections: [...groups.values()] };
    });
    return boundToolPathTelemetry({ schemaVersion: 1, observedAt, entries });
  }
  async close(operation: Operation): Promise<void> {
    this.closed = true;
    operation.check();
    if (this.probeClosing === undefined) {
      const pending = Promise.resolve().then(() => { operation.check(); return this.options.probe.close(operation); });
      this.probeClosing = pending;
      const clear = () => { if (this.probeClosing === pending) this.probeClosing = undefined; };
      void pending.then(clear, clear);
    }
    const results = await Promise.allSettled([withinOperation(Promise.allSettled([...this.inFlight]), operation), withinOperation(this.probeClosing, operation)]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []); if (failures.length) throw new AggregateError(failures, "Tool selection cleanup remains unconfirmed.");
  }
}
