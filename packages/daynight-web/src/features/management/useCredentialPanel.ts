import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { authRequestsPaused, isAbortError, readAuthRequestGeneration, subscribeAuthPause, waitForAuthRequests } from "../../api/client";
import { mergeCredentialUses } from "./CredentialLastUse";

type Credential = { readonly id: string; readonly lastUsedAt: string | null };
export type CredentialOperation = { readonly signal: AbortSignal; readonly onDispatch: () => void; readonly current: () => boolean; readonly dispatched: () => boolean; readonly settled: () => void };
export type CredentialPanel<T extends Credential> = {
  readonly items: readonly T[] | null;
  readonly setItems: Dispatch<SetStateAction<readonly T[] | null>>;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly error: unknown;
  readonly read: (publish?: (items: readonly T[]) => void) => Promise<void>;
  readonly write: (operation: (context: CredentialOperation) => Promise<void>, abandoned?: (dispatched: boolean) => void) => Promise<void>;
  readonly busy: () => boolean;
};

export const useCredentialPanel = <T extends Credential>(userId: string, transport: (signal: AbortSignal, userId: string, mismatch: () => void) => Promise<readonly T[]>, mismatch: () => void, initialRead = true): CredentialPanel<T> => {
  const [items, setItems] = useState<readonly T[] | null>(null);
  const [loading, setLoading] = useState(initialRead), [pending, setPending] = useState(false), [error, setError] = useState<unknown>(null);
  const lifetime = useRef<AbortController | null>(null);
  const reading = useRef<AbortController | null>(null), writing = useRef(false);
  const skipInitialRead = useRef(false);
  const mutation = useRef<{ controller: AbortController; dispatched: boolean; abandoned: ((dispatched: boolean) => void) | undefined } | null>(null);
  const callbacks = useRef({ transport, mismatch }); callbacks.current = { transport, mismatch };
  const queued = useRef<(() => void)[]>([]);
  const readGeneration = useRef(0);
  const read = async (publish?: (result: readonly T[]) => void): Promise<void> => {
    const active = lifetime.current;
    if (active === null || active.signal.aborted) return;
    if (writing.current || reading.current !== null) {
      await new Promise<void>(resolve => queued.current.push(() => { void read(publish).then(resolve); }));
      return;
    }
    const owner = new AbortController(), generation = readAuthRequestGeneration(), request = ++readGeneration.current;
    reading.current = owner;
    const signal = AbortSignal.any([active.signal, owner.signal]);
    const current = () => !signal.aborted && generation === readAuthRequestGeneration() && reading.current === owner && request === readGeneration.current;
    setLoading(true); setError(null);
    try {
      if (authRequestsPaused()) await waitForAuthRequests(signal);
      if (!current()) return;
      const result = await callbacks.current.transport(signal, userId, callbacks.current.mismatch);
      await waitForAuthRequests(signal);
      if (!current()) return;
      setItems(before => mergeCredentialUses(before, result)); publish?.(result);
    } catch (failure) {
      if (current() && !isAbortError(failure)) setError(failure);
    } finally {
      if (reading.current === owner) { reading.current = null; if (!active.signal.aborted) setLoading(false); }
      if (!writing.current && !active.signal.aborted) queued.current.shift()?.();
    }
  };
  const write = async (operation: (context: CredentialOperation) => Promise<void>, abandoned?: (dispatched: boolean) => void) => {
    const active = lifetime.current;
    if (active === null || active.signal.aborted || writing.current || reading.current !== null || authRequestsPaused()) return;
    writing.current = true; setPending(true);
    const generation = readAuthRequestGeneration();
    const owner = { controller: new AbortController(), dispatched: false, abandoned }; mutation.current = owner;
    const context: CredentialOperation = { signal: AbortSignal.any([active.signal, owner.controller.signal]), onDispatch: () => { owner.dispatched = true; }, dispatched: () => owner.dispatched, current: () => !active.signal.aborted && generation === readAuthRequestGeneration(), settled: () => { if (!active.signal.aborted) setPending(false); } };
    try { await operation(context); }
    finally {
      if (mutation.current === owner) {
        mutation.current = null; writing.current = false;
        if (!active.signal.aborted) { setPending(false); queued.current.shift()?.(); }
      }
    }
  };
  const latestRead = useRef(read); latestRead.current = read;
  useEffect(() => {
    const active = new AbortController(); lifetime.current = active;
    if (initialRead && !skipInitialRead.current) void latestRead.current();
    skipInitialRead.current = false;
    const unsubscribe = subscribeAuthPause(() => {
      if (mutation.current !== null && !mutation.current.dispatched) mutation.current.controller.abort();
    });
    return () => {
      unsubscribe(); active.abort(); reading.current?.abort(); reading.current = null; ++readGeneration.current;
      if (mutation.current !== null) { skipInitialRead.current = true; mutation.current.controller.abort(); mutation.current.abandoned?.(mutation.current.dispatched); mutation.current = null; }
      writing.current = false; setPending(false); queued.current = [];
    };
  }, [userId, transport]);
  return { items, setItems, loading, pending, error, read, write, busy: () => writing.current || reading.current !== null || authRequestsPaused() };
};
