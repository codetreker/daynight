import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { me, type User } from "../api/auth";
import { ApiError } from "../api/client";
import { createAccountSignal, type AccountPublication, type AccountSignalIssue, type ActiveUserRead } from "./account-signal";

export type AccountSession =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly cause: unknown }
  | { readonly status: "anonymous" }
  | { readonly status: "authenticated"; readonly user: User; readonly generation: number };

export type AccountSync =
  | { readonly status: "idle" }
  | { readonly status: "complete" }
  | { readonly status: "error"; readonly issue: AccountSignalIssue; readonly persisted: boolean };

export type AccountSessionValue = {
  readonly session: AccountSession;
  readonly requiresRefresh: boolean;
  readonly sync: AccountSync;
  readonly retryInitialization: () => void;
  readonly retryPublication: () => void;
};

const Context = createContext<AccountSessionValue | null>(null);

const sameKnown = (a: ActiveUserRead, b: ActiveUserRead): boolean =>
  a.kind === "known" && b.kind === "known" && a.userId === b.userId;

const readIssue = (read: ActiveUserRead): AccountSignalIssue | null => {
  if (read.kind === "invalid") return { phase: "parse", cause: read.cause };
  if (read.kind === "unavailable") return { phase: "read", cause: read.cause };
  return null;
};

/** Owns server-confirmed initialization and its local cross-tab publication. */
export function AccountSessionProvider({ children }: { readonly children: ReactNode }) {
  const [view, setView] = useState<{ session: AccountSession; requiresRefresh: boolean; sync: AccountSync }>({
    session: { status: "loading" }, requiresRefresh: false, sync: { status: "idle" },
  });
  const actions = useRef({ retryInitialization: () => {}, retryPublication: () => {} });

  useEffect(() => {
    const signal = createAccountSignal();
    let disposed = false;
    let generation = 0;
    let controller: AbortController | undefined;
    let state: typeof view = { session: { status: "loading" }, requiresRefresh: false, sync: { status: "idle" } };
    let confirmed: { userId: string | null; baseline: ActiveUserRead; phase: "write" | "notification" | "complete" } | undefined;
    let baseline: ActiveUserRead = { kind: "missing" };
    let changedDuringInitialization = false;

    const update = (patch: Partial<typeof state>) => {
      if (disposed) return;
      state = { ...state, ...patch };
      setView(state);
    };
    const refresh = () => update({ requiresRefresh: true });
    const observe = (read: ActiveUserRead) => {
      const issue = readIssue(read);
      if (issue) update({ sync: { status: "error", issue, persisted: confirmed?.phase === "notification" } });
      if (read.kind !== "known") return;
      if (confirmed) {
        if (read.userId !== confirmed.userId) refresh();
      } else if (!sameKnown(read, baseline)) {
        changedDuringInitialization = true;
      }
    };
    const unsubscribe = signal.subscribe(() => { if (!disposed) observe(signal.read()); });

    const publish = () => {
      if (disposed || state.requiresRefresh || !confirmed) return;
      const current = signal.read();
      const issue = readIssue(current);
      if (issue) {
        update({ sync: { status: "error", issue, persisted: confirmed.phase === "notification" } });
        return;
      }
      // A stale starting marker is allowed, but a newly observed known value is not.
      if (current.kind === "known" && !sameKnown(current, confirmed.baseline) && current.userId !== confirmed.userId) {
        refresh();
        return;
      }
      if (confirmed.phase === "complete") {
        update({ sync: { status: "complete" } });
        return;
      }
      const result: AccountPublication = confirmed.phase === "notification"
        ? signal.retryNotification(confirmed.userId)
        : signal.publish(confirmed.userId);
      if (result.kind === "superseded") { refresh(); return; }
      if (result.kind === "failed") {
        // A failed notification retry remains pending even if its own reread fails.
        if (result.persisted) confirmed.phase = "notification";
        if (confirmed.phase === "notification") confirmed.baseline = { kind: "known", userId: confirmed.userId };
        update({ sync: { status: "error", issue: result.issue, persisted: confirmed.phase === "notification" } });
        return;
      }
      confirmed.phase = "complete";
      confirmed.baseline = { kind: "known", userId: confirmed.userId };
      update({ sync: { status: "complete" } });
    };

    const initialize = () => {
      if (disposed || state.requiresRefresh || confirmed) return;
      controller?.abort();
      const currentGeneration = ++generation;
      controller = new AbortController();
      const request = controller;
      baseline = signal.read();
      changedDuringInitialization = false;
      const issue = readIssue(baseline);
      update({ session: { status: "loading" }, sync: issue ? { status: "error", issue, persisted: false } : { status: "idle" } });
      void (async () => {
        let user: User | null;
        try { user = await me(request.signal); }
        catch (cause) {
          if (disposed || request.signal.aborted || currentGeneration !== generation || state.requiresRefresh) return;
          if (cause instanceof ApiError && cause.kind === "server" && cause.status === 401) user = null;
          else { controller = undefined; update({ session: { status: "error", cause } }); return; }
        }
        if (disposed || request.signal.aborted || currentGeneration !== generation || state.requiresRefresh) return;
        controller = undefined;
        const latest = signal.read();
        if (latest.kind === "known" && !sameKnown(latest, baseline)) changedDuringInitialization = true;
        const userId = user?.id ?? null;
        if (changedDuringInitialization && latest.kind === "known" && latest.userId !== userId) { refresh(); return; }
        confirmed = { userId, baseline: latest, phase: "write" };
        update({ session: user === null ? { status: "anonymous" } : { status: "authenticated", user, generation: currentGeneration } });
        publish();
      })();
    };
    actions.current = { retryInitialization: () => { if (state.session.status === "error") initialize(); }, retryPublication: publish };
    initialize();
    return () => {
      disposed = true;
      generation++;
      controller?.abort();
      unsubscribe();
      signal.dispose();
      actions.current = { retryInitialization: () => {}, retryPublication: () => {} };
    };
  }, []);

  return <Context value={{ ...view, retryInitialization: () => actions.current.retryInitialization(), retryPublication: () => actions.current.retryPublication() }}>{children}</Context>;
}

export function useAccountSession(): AccountSessionValue {
  const value = useContext(Context);
  if (value === null) throw new Error("An account session provider is required.");
  return value;
}
