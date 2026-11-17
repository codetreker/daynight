import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalId } from "../../api/parse.js";
import { decodeStrictSessionJson } from "../../session/v2/values.js";
import { ensureDurableDirectory } from "../../platform/durable-directory.js";
import { writeDurableJson } from "../../platform/durable-json.js";
import { acquireInstanceLockSync, InstanceLockHeldError } from "../../platform/instance-lock.js";

const MAX_SEQUENCE = 9_223_372_036_854_775_807n;
type PreparedCut = { activationId: string; sequence: string };
type PendingClosure = { key: string; sequence: string };
type DomainState = { schemaVersion: 1; domainId: string; sequence: string; activation: PreparedCut | null; pendingClosure: PendingClosure | null };
export type TerminationDomain = { readonly domainId: string; readonly sequence: string; readonly pending: Readonly<PendingClosure> | null; advance(): string; beginClosure(key: string): string; finishClosure(key: string): void };
export type TerminationCut = TerminationDomain & { readonly prepared: Readonly<PreparedCut> | null; prepare(activationId: string): string; settle(activationId: string): void };
type DomainOptions = { signal?: AbortSignal; expectedDomainId?: string; pendingKey?: string };
const tails = new Map<string, Promise<void>>();

const parseState = (value: unknown): DomainState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Termination domain state is invalid.");
  const state = value as Record<string, unknown>;
  if (Object.keys(state).sort().join() !== "activation,domainId,pendingClosure,schemaVersion,sequence" || state.schemaVersion !== 1 ||
      typeof state.domainId !== "string" || canonicalId(state.domainId) !== state.domainId ||
      typeof state.sequence !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(state.sequence) || BigInt(state.sequence) > MAX_SEQUENCE ||
      !(state.activation === null || typeof state.activation === "object" && !Array.isArray(state.activation) &&
        Object.keys(state.activation).sort().join() === "activationId,sequence" &&
        typeof (state.activation as PreparedCut).activationId === "string" && canonicalId((state.activation as PreparedCut).activationId) === (state.activation as PreparedCut).activationId &&
        (state.activation as PreparedCut).sequence === state.sequence && state.sequence !== "0") ||
      !(state.pendingClosure === null || typeof state.pendingClosure === "object" && !Array.isArray(state.pendingClosure) &&
        Object.keys(state.pendingClosure).sort().join() === "key,sequence" && validClosureKey((state.pendingClosure as PendingClosure).key) &&
        (state.pendingClosure as PendingClosure).sequence === state.sequence && state.sequence !== "0") ||
      state.activation !== null && state.pendingClosure !== null) throw new Error("Termination domain state is invalid.");
  return state as DomainState;
};
const validClosureKey = (key: unknown): key is string => {
  if (typeof key !== "string") return false;
  const [backend, ...ids] = key.split("/");
  return (backend === "web" || backend === "herdr") && ids.length === 4 && ids.every(id => canonicalId(id) === id);
};
const readState = (file: string): DomainState => {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Termination domain state must be a private regular file.");
  return parseState(decodeStrictSessionJson(readFileSync(file), Number.POSITIVE_INFINITY));
};

/** Observes a durable intent without taking the Controller storage permit. */
export const readTerminationPending = (directory: string): Readonly<PendingClosure> | null => {
  if (!path.isAbsolute(directory)) throw new Error("Termination domain requires an absolute directory.");
  try { const pending = readState(path.join(directory, "domain.json")).pendingClosure; return pending === null ? null : { ...pending }; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
};
const lockHeld = (error: unknown): boolean => {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof InstanceLockHeldError || "code" in current && current.code === "SQLITE_BUSY") return true;
  }
  return false;
};
const waitForTurn = async (previous: Promise<void>, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { await Promise.race([previous, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
};

const withDomain = async <T>(directory: string, operation: (domain: TerminationCut) => Promise<T>, options: DomainOptions, mode: "normal" | "cut" | "physical-stop"): Promise<T> => {
  if (!path.isAbsolute(directory)) throw new Error("Termination domain requires an absolute directory.");
  const timeout = AbortSignal.timeout(10_000);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const resolved = path.resolve(directory);
  const previous = tails.get(resolved) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const gate = new Promise<void>(resolve => { releaseQueue = resolve; });
  const tail = previous.then(() => gate);
  tails.set(resolved, tail);
  try {
    await waitForTurn(previous, signal);
    signal.throwIfAborted();
    ensureDurableDirectory(resolved);
    const lockFile = path.join(resolved, "domain.lock"), gateFile = path.join(resolved, "domain-lock.sqlite");
    let lock: ReturnType<typeof acquireInstanceLockSync>;
    for (;;) {
      signal.throwIfAborted();
      try { lock = acquireInstanceLockSync(lockFile, gateFile, undefined, { timeoutMs: () => 100 }); break; }
      catch (error) {
        if (!lockHeld(error)) throw error;
        await delay(50, undefined, { signal });
      }
    }
    let failure: unknown;
    let failed = false;
    try {
      const file = path.join(resolved, "domain.json");
      let state: DomainState;
      try {
        state = readState(file);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        if (options.expectedDomainId !== undefined) throw new Error("The original termination domain state is missing; its identity cannot be replaced.", { cause: error });
        state = { schemaVersion: 1, domainId: randomUUID(), sequence: "0", activation: null, pendingClosure: null };
        writeDurableJson(file, state);
      }
      if (options.expectedDomainId !== undefined && state.domainId !== options.expectedDomainId) throw new Error("Termination domain identity does not match the original binding.");
      if (mode === "normal" && state.activation !== null) throw new Error("Termination metadata is waiting for the prepared policy activation to settle.");
      if (state.pendingClosure !== null && (mode === "cut" || mode === "normal" && options.pendingKey !== state.pendingClosure.key)) throw new Error("The original termination closure intent must be reconciled before another metadata operation or policy cut.");
      let active = true;
      const ensureActive = (): void => { if (!active) throw new Error("Termination domain permit is no longer held."); };
      const domain: TerminationCut = {
        domainId: state.domainId,
        get sequence() { return state.sequence; },
        get pending() { return state.pendingClosure === null ? null : { ...state.pendingClosure }; },
        get prepared() { return state.activation === null ? null : { ...state.activation }; },
        advance: () => {
          ensureActive();
          if (mode === "physical-stop") throw new Error("Physical stop cannot allocate a termination sequence.");
          if (state.activation !== null) throw new Error("Termination metadata is waiting for the prepared policy activation to settle.");
          if (state.pendingClosure !== null) throw new Error("The original termination closure intent is still pending.");
          const next = BigInt(state.sequence) + 1n;
          if (next > MAX_SEQUENCE) throw new Error("Termination domain sequence is exhausted.");
          state = { ...state, sequence: String(next) };
          writeDurableJson(file, state);
          return state.sequence;
        },
        beginClosure: key => {
          ensureActive();
          if (mode !== "normal" || !validClosureKey(key) || options.pendingKey !== key) throw new Error("Termination closure requires its original identity.");
          if (state.pendingClosure !== null) return state.pendingClosure.sequence;
          const next = BigInt(state.sequence) + 1n;
          if (next > MAX_SEQUENCE) throw new Error("Termination domain sequence is exhausted.");
          const sequence = String(next);
          state = { ...state, sequence, pendingClosure: { key, sequence } };
          writeDurableJson(file, state);
          return sequence;
        },
        finishClosure: key => {
          ensureActive();
          if (mode !== "normal" || options.pendingKey !== key || state.pendingClosure?.key !== key) throw new Error("The original termination closure intent does not match.");
          state = { ...state, pendingClosure: null };
          writeDurableJson(file, state);
        },
        prepare: activationId => {
          ensureActive();
          if (mode !== "cut" || canonicalId(activationId) !== activationId) throw new Error("A policy cut requires its canonical activation identity.");
          if (state.activation !== null) throw new Error("The original policy activation is still prepared.");
          const next = BigInt(state.sequence) + 1n;
          if (next > MAX_SEQUENCE) throw new Error("Termination domain sequence is exhausted.");
          const sequence = String(next);
          state = { ...state, sequence, activation: { activationId, sequence } };
          writeDurableJson(file, state);
          return sequence;
        },
        settle: activationId => {
          ensureActive();
          if (mode !== "cut" || state.activation?.activationId !== activationId) throw new Error("The prepared policy activation identity does not match.");
          state = { ...state, activation: null };
          writeDurableJson(file, state);
        },
      };
      try { return await operation(domain); }
      finally { active = false; }
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      try { lock.release(); }
      catch (error) {
        if (failed) throw new AggregateError([failure, error], "Termination domain operation and lock release failed.", { cause: failure });
        throw error;
      }
    }
  } finally {
    releaseQueue();
    if (tails.get(resolved) === tail) tails.delete(resolved);
  }
};

/** Serializes short local metadata operations, excluding prepared policy cuts. */
export const withTerminationDomain = <T>(directory: string, operation: (domain: TerminationDomain) => Promise<T>, options: DomainOptions = {}): Promise<T> => withDomain(directory, operation, options, "normal");

/** Prepares or reconciles one cut; network operations must run outside this permit. */
export const withTerminationDomainCut = <T>(directory: string, operation: (domain: TerminationCut) => Promise<T>, options: DomainOptions = {}): Promise<T> => withDomain(directory, operation, options, "cut");

/** Record an already verified physical stop while a policy cut is unresolved. */
export const withTerminationPhysicalStop = <T>(directory: string, operation: (domain: Pick<TerminationDomain, "domainId">) => Promise<T>, options: Omit<DomainOptions, "pendingKey"> = {}): Promise<T> => withDomain(directory, domain => operation({ domainId: domain.domainId }), options, "physical-stop");
