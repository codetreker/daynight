export type ExecutionOwnerKind = "task" | "bot" | "assistant" | "probe" | "repository" | "configuration" | "controller";
export type OwnerStopResult = {
  resourceId: string;
  ownerKind: ExecutionOwnerKind;
  generation: string;
  stop: "confirmed" | "unknown";
  save: "durable" | "failed";
  error?: unknown;
  identity?: unknown;
};
export type ExecutionOwner = {
  resourceId: string;
  ownerKind: ExecutionOwnerKind;
  closeAdmission?: (reason: unknown) => void;
  stop: (options: { deadline: number }) => Promise<void>;
  snapshot?: () => unknown;
};
export type ExecutionScopeSnapshot = {
  generation: string; stopped: boolean; admission: "closed" | "open";
  resources: { resourceId: string; ownerKind: ExecutionOwnerKind; result: OwnerStopResult | null; detail: unknown }[];
};
export type ExecutionScope = {
  generation: string; signal: AbortSignal;
  closeAdmission(reason?: unknown): void;
  register(owner: ExecutionOwner): void;
  snapshot(): ExecutionScopeSnapshot;
  stop(options?: { deadline: number }): Promise<OwnerStopResult[]>;
  reconcile(options?: { deadline: number }): Promise<OwnerStopResult[]>;
};

/** A deadline bounds observation, never claims that timed-out work was cancelled. */
export const withinExecutionDeadline = async <T>(work: Promise<T>, deadline: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Worker execution owner stop deadline elapsed; responsibility is retained.")), Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
};

export const createExecutionScope = (generation: string, parentSignal: AbortSignal): ExecutionScope => {
  if (!/^[1-9][0-9]*$/.test(generation) || BigInt(generation) > 9223372036854775807n) throw new TypeError("Execution scope generation must be a positive int64 string.");
  const cancellation = new AbortController();
  const owners = new Map<string, { owner: ExecutionOwner; result?: OwnerStopResult; detail?: unknown; work?: Promise<void> }>();
  const observe = (owner: ExecutionOwner): unknown => {
    try { return owner.snapshot?.(); }
    catch (error) { return { observation: "unknown", error }; }
  };
  let stopping: Promise<OwnerStopResult[]> | undefined;
  let observing = false;
  let runStop!: ExecutionScope["stop"];
  let closed = false;
  let stopped = false;
  const admissionErrors: unknown[] = [];
  const closeAdmission = (reason: unknown = new Error("Worker execution admission is closed.")): void => {
    if (closed) return;
    closed = true;
    cancellation.abort(reason);
    for (const { owner } of owners.values()) {
      try { owner.closeAdmission?.(reason); } catch (error) { admissionErrors.push(error); }
    }
  };
  const abort = (): void => closeAdmission(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) abort();
  return {
    generation, signal: cancellation.signal, closeAdmission,
    register: (owner: ExecutionOwner): void => {
      if (closed) throw new Error("Cannot register an execution owner after admission closes.");
      if (owners.has(owner.resourceId)) throw new Error("Execution resource identity is already registered.");
      owners.set(owner.resourceId, { owner });
    },
    snapshot: () => ({ generation, stopped, admission: closed ? "closed" as const : "open" as const,
      resources: [...owners.values()].map(({ owner, result, detail }) => ({ resourceId: owner.resourceId, ownerKind: owner.ownerKind, result: result === undefined ? null : { ...result }, detail: result === undefined ? observe(owner) : detail })) }),
    stop: runStop = (options: { deadline: number } = { deadline: Date.now() + 60_000 }): Promise<OwnerStopResult[]> => {
      if (stopping !== undefined) return stopping;
      closeAdmission();
      observing = true;
      stopping = (async () => {
        // Every owner is invoked even when another rejects synchronously.
        const results = await Promise.allSettled([...owners.values()].map(async entry => {
          if (entry.result?.stop === "confirmed" && entry.result.save === "durable") return entry.result;
          entry.detail = observe(entry.owner);
          const base = { resourceId: entry.owner.resourceId, ownerKind: entry.owner.ownerKind, generation, identity: entry.detail };
          try {
            const deadline = Math.min(options.deadline, Date.now() + 20_000);
            // Observation can time out while the original owner still writes. A
            // reconciliation must join that attempt before starting another one.
            if (entry.work === undefined) {
              const work = Promise.resolve().then(() => entry.owner.stop({ deadline }));
              entry.work = work;
              void work.catch(() => { if (entry.work === work) delete entry.work; });
            }
            await withinExecutionDeadline(entry.work, deadline);
            entry.result = { ...base, stop: "confirmed", save: "durable" };
          } catch (error) { entry.result = { ...base, stop: "unknown", save: "failed", error }; }
          return entry.result;
        }));
        parentSignal.removeEventListener("abort", abort);
        const observed = results.map(result => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });
        if (admissionErrors.length) observed.push({ resourceId: "admission", ownerKind: "configuration", generation, stop: "unknown", save: "failed", error: new AggregateError(admissionErrors, "Execution admission closure failed.") });
        stopped = observed.every(result => result.stop === "confirmed" && result.save === "durable");
        observing = false;
        return observed;
      })();
      return stopping;
    },
    reconcile: options => {
      if (!observing && !stopped) stopping = undefined;
      return runStop(options);
    },
  };
};

/** Retain the old scope until all owners have proved closure. */
export const createExecutionScopeManager = (signal: AbortSignal): { current(): ExecutionScope | undefined; create(generation?: string): ExecutionScope } => {
  let current: ExecutionScope | undefined;
  let generation = 0n;
  return {
    current: () => current,
    create: (requestedGeneration?: string): ExecutionScope => {
      signal.throwIfAborted();
      if (current !== undefined) {
        const snapshot = current.snapshot();
        if (!snapshot.stopped) throw new Error("Previous execution scope retains unconfirmed resources.");
      }
      const next = requestedGeneration === undefined ? generation + 1n : BigInt(requestedGeneration);
      if (next <= generation) throw new Error("Execution scope generation must advance monotonically.");
      generation = next;
      current = createExecutionScope(String(generation), signal);
      return current;
    },
  };
};
