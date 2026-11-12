import type { Operation } from "../../api/operation.js";
import { probeResourceKey, type ResolvedToolLaunch } from "../../platform/tool-executables.js";
import { withinOperation } from "../../platform/tool-io.js";
import { hasHerdrCommandCleanupFailure, hasUnconfirmedHerdrCommandCleanup } from "./herdr/command.js";
import { BotCliProbeCleanupError } from "./bots/cli-probe.js";
export { captureToolEnvironment as captureCodexProbeEnvironment } from "../../platform/tool-environment.js";

const runningCleanups = new Map<string, Promise<void>>();
const completedCleanups = new WeakSet<BotCliProbeCleanupError>();
/** Nested probe owners join the same original process cleanup, including after a caller times out. */
export const joinNativeProbeCleanup = (error: BotCliProbeCleanupError): Promise<void> => {
  if (completedCleanups.has(error)) return Promise.resolve();
  const id = error.ownership.launchId, existing = runningCleanups.get(id);
  if (existing) return existing.then(() => { completedCleanups.add(error); });
  const pending = Promise.resolve().then(() => error.retryCleanup()).then(() => { completedCleanups.add(error); });
  runningCleanups.set(id, pending);
  const clear = () => { if (runningCleanups.get(id) === pending) runningCleanups.delete(id); };
  void pending.then(clear, clear);
  return pending;
};

type CodexInvocation = { file: string; environment: NodeJS.ProcessEnv; workingDirectory: string; toolLaunch?: ResolvedToolLaunch };
export type CodexProbeOwner = {
  observe<T>(invocation: CodexInvocation, operation: Operation, probe: () => Promise<T>): Promise<T>;
  reconcileRecipe(launch: ResolvedToolLaunch, operation: Operation): Promise<number>;
  admitRecipe(launch: ResolvedToolLaunch, receipt: unknown): void;
  assertAvailable(invocation: CodexInvocation): void;
  revision(invocation: CodexInvocation): number;
  close(operation?: Operation): Promise<void>;
};
const searchValue = (environment: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = process.platform === "win32" ? Object.keys(environment).filter(key => key.toUpperCase() === name).sort()[0] : name;
  return key === undefined ? undefined : environment[key];
};

/** Canonical tools share their serial owner even when a target or lexical alias changes. */
export const createCodexProbeOwner = (environment: NodeJS.ProcessEnv, workingDirectory: string, onCleanupFailure?: () => void): CodexProbeOwner => {
  const search = searchValue(environment, "PATH"), extensions = searchValue(environment, "PATHEXT");
  type State = { tail: Promise<void>; failures: unknown[]; pending: Map<string, BotCliProbeCleanupError>; revision: number; recipes: Set<string> };
  const owners = new Map<string, State>(), retiredRecipes = new Map<string, number>(); let closed = false, generation = 0;
  const recipe = (launch: ResolvedToolLaunch): string => probeResourceKey(launch, { cwd: "", environment: {} });
  const owner = (invocation: CodexInvocation): State | undefined => {
    const key = invocation.toolLaunch ? probeResourceKey(invocation.toolLaunch, { cwd: invocation.workingDirectory, environment: invocation.environment })
      : invocation.file === "codex" && invocation.workingDirectory === workingDirectory && searchValue(invocation.environment, "PATH") === search &&
        (process.platform !== "win32" || searchValue(invocation.environment, "PATHEXT") === extensions) ? "legacy" : undefined;
    if (key === undefined) return;
    let state = owners.get(key);
    if (!state) { state = { tail: Promise.resolve(), failures: [], pending: new Map(), revision: 0, recipes: new Set() }; owners.set(key, state); }
    if (invocation.toolLaunch) state.recipes.add(recipe(invocation.toolLaunch));
    return state;
  };
  const retain = (state: State, error: unknown, seen = new Set<unknown>()): void => {
    if (seen.has(error)) return; seen.add(error);
    if (error instanceof BotCliProbeCleanupError) state.pending.set(error.ownership.launchId, error);
    if (error instanceof AggregateError) for (const child of error.errors) retain(state, child, seen);
    if (error instanceof Error && error.cause !== undefined) retain(state, error.cause, seen);
  };
  const assert = (state: State | undefined): void => {
    if (closed) throw new Error("Native tool probe owner is closed.");
    const failure = state?.failures.find(error => hasUnconfirmedHerdrCommandCleanup(error));
    if (failure) throw failure;
    if (state?.pending.size) throw Object.assign(new Error("Native tool probe cleanup remains unconfirmed."), { code: "cleanup_unknown" });
  };
  const cleanup = async (state: State, operation?: Operation): Promise<void> => {
    const errors: unknown[] = [];
    for (const [id, error] of [...state.pending]) {
      try {
        operation?.check();
        const pending = joinNativeProbeCleanup(error).then(() => { state.pending.delete(id); }, failure => { retain(state, failure); throw failure; });
        await (operation ? withinOperation(pending, operation) : pending);
      } catch (failure) { errors.push(failure); if (operation?.signal.aborted) break; }
    }
    state.failures = state.failures.filter(error => hasUnconfirmedHerdrCommandCleanup(error));
    errors.push(...state.failures);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw Object.assign(new AggregateError(errors, "Native tool probe cleanup remains unconfirmed."), { code: "cleanup_unknown" });
  };
  const enqueue = async <T>(state: State, operation: Operation, probe: () => Promise<T>, guard?: () => void): Promise<T> => {
      if (closed) throw new Error("Native tool probe owner is closed.");
      const previous = state.tail; let release!: () => void;
      state.tail = new Promise<void>(resolve => { release = resolve; });
      try {
        await previous; operation.check(); await cleanup(state, operation); assert(state); guard?.();
        try { return await probe(); }
        catch (error) {
          retain(state, error);
          if (hasHerdrCommandCleanupFailure(error) || state.pending.size || error instanceof Error && "code" in error && error.code === "cleanup_unknown") {
            if (hasHerdrCommandCleanupFailure(error)) state.failures.push(error);
            state.revision++; onCleanupFailure?.();
          }
          throw error;
        }
      } finally { release(); }
  };
  return {
    assertAvailable: invocation => assert(owner(invocation)),
    revision: invocation => owner(invocation)?.revision ?? 0,
    observe: (invocation, operation, probe) => {
      if (closed) return Promise.reject(new Error("Native tool probe owner is closed."));
      const id = invocation.toolLaunch && recipe(invocation.toolLaunch);
      const guard = () => { if (id && retiredRecipes.has(id)) throw Object.assign(new Error("The tool probe recipe is no longer admitted."), { code: "tool_identity_changed" }); };
      try { guard(); } catch (error) { return Promise.reject(error); }
      const state = owner(invocation); return state ? enqueue(state, operation, probe, guard) : probe();
    },
    reconcileRecipe: async (launch, operation) => {
      operation.check(); if (closed) throw new Error("Native tool probe owner is closed.");
      const id = recipe(launch), receipt = ++generation; retiredRecipes.set(id, receipt);
      // Queue all matching scopes before awaiting any of them, so an in-flight
      // probe cannot leave an older scope behind while another is reconciled.
      await Promise.all([...owners.values()].filter(state => state.recipes.has(id)).map(state => enqueue(state, operation, async () => {})));
      return receipt;
    },
    admitRecipe: (launch, receipt) => {
      if (closed) throw new Error("Native tool probe owner is closed.");
      const id = recipe(launch);
      if (retiredRecipes.get(id) !== receipt || typeof receipt !== "number") throw Object.assign(new Error("The tool probe reconciliation was superseded."), { code: "tool_identity_changed" });
      retiredRecipes.delete(id);
    },
    close: async (operation?: Operation): Promise<void> => {
      closed = true;
      const errors: unknown[] = [];
      for (const state of owners.values()) {
        try {
          operation?.check();
          await (operation ? withinOperation(state.tail, operation) : state.tail);
          await cleanup(state, operation);
        } catch (error) { errors.push(error); if (operation?.signal.aborted) break; }
      }
      if (errors.length) throw Object.assign(new AggregateError(errors, "Native tool probe cleanup remains unconfirmed."), { code: "cleanup_unknown" });
    },
  };
};
