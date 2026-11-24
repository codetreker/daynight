import { clearImageDraftScope, imageDraftCleanupFailures, retryImageDraftScopeCleanup } from '../features/task-agent-session/drafts/draft-store-cleanup';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { logout, me, type User } from "../api/auth";
import { ApiError, cancelAuthNetworkRequests, invalidateAuthRequests, isAbortError, pauseAuthRequests, subscribeUnauthorized } from "../api/client";
import { createTaskCacheScope, type TaskCacheScope } from "../features/task-cache/TaskCacheProvider";
import { clearPendingBotDeletions } from '../features/bots/deletion-coordinator';
import { clearBotDisplaySnapshots, retryBotDisplaySnapshotCleanup } from '../features/bots/display-snapshot-coordinator';
import { clearPendingBotCreation } from '../features/bots/pending-creation';
import { clearWebhookPending } from '../features/webhook-intents/controller';
import { clearSessionDrafts } from '../features/task-agent-session/client';
import { clearBotSessionStorage } from '../features/bots/session-storage';
import { clearSessionDisplayPreference } from '../features/task-agent-session/useSessionDisplayPreference';
import { loginUrl, navigate, replaceRoute } from "./router";
import { createAccountSignal, type AccountPublication, type AccountSignalIssue, type AccountSignalSource, type ActiveUserRead } from "./account-signal";

type SessionNotice = "expired" | "signedOut" | "logoutFailed";
export type AccountSession =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly cause: unknown }
  | { readonly status: "anonymous"; readonly notice?: SessionNotice }
  | { readonly status: "authenticated"; readonly user: User; readonly generation: number };
export type AccountSync =
  | { readonly status: "idle" }
  | { readonly status: "complete" }
  | { readonly status: "error"; readonly issue: AccountSignalIssue; readonly persisted: boolean };
export type AccountSessionValue = {
  readonly session: AccountSession;
  readonly scope: TaskCacheScope | null;
  readonly requiresRefresh: boolean;
  readonly sync: AccountSync;
  readonly logoutPending: boolean;
  readonly logoutFailed: boolean;
  readonly privateCleanup: ReadonlyMap<string, Error>;
  readonly retryPrivateCleanup: () => void;
  readonly retryInitialization: () => void;
  readonly retryPublication: () => void;
  readonly requireAccountRefresh: (reason?: string) => void;
  readonly signOut: (continuation?: string | null) => void;
  readonly reloadCurrentPage: () => void;
};

const Context = createContext<AccountSessionValue | null>(null);
const sameKnown = (a: ActiveUserRead, b: ActiveUserRead): boolean =>
  a.kind === "known" && b.kind === "known" && a.userId === b.userId;
const readIssue = (read: ActiveUserRead): AccountSignalIssue | null => {
  if (read.kind === "invalid") return { phase: "parse", cause: read.cause };
  if (read.kind === "unavailable") return { phase: "read", cause: read.cause };
  return null;
};
async function clearPrivateSessionState(userId: string): Promise<Error | null> {
  const snapshotsCleared = clearBotDisplaySnapshots(userId);
  const imageDraftsCleared = clearImageDraftScope({ origin: window.location.origin, actorUserId: userId, sessionId: null, reason: 'account_changed' });
  const webhookCleanupError = clearWebhookPending(window.location.origin, userId);
  clearSessionDrafts(userId);
  clearPendingBotCreation(userId);
  clearPendingBotDeletions(userId);
  for (const sessionId of clearBotSessionStorage(userId)) clearSessionDisplayPreference({ userId, sessionId });
  const [imageCleanupError, snapshotsComplete] = await Promise.all([imageDraftsCleared, snapshotsCleared]);
  return imageCleanupError ?? (snapshotsComplete ? webhookCleanupError : new Error('Assistant display snapshots could not be cleared.'));
}

type SyncSource = AccountSignalSource | "bootstrap" | "logout" | "unauthorized" | "principal";
const safeCauseCategory = (cause: unknown): string => {
  if (cause instanceof DOMException) return "DOMException";
  if (cause instanceof TypeError) return "TypeError";
  if (cause instanceof Error) return "Error";
  return "unknown";
};
type View = Pick<AccountSessionValue, "session" | "scope" | "requiresRefresh" | "sync" | "logoutPending" | "logoutFailed" | "privateCleanup">;
const initialView = (): View => ({ session: { status: "loading" }, scope: null, requiresRefresh: false, sync: { status: "idle" }, logoutPending: false, logoutFailed: false, privateCleanup: new Map() });

/** Owns the confirmed account and the lifetime of its document. */
export function AccountSessionProvider({ children }: { readonly children: ReactNode }) {
  const [view, setView] = useState<View>(initialView);
  const actions = useRef({ retryInitialization: () => {}, retryPublication: () => {}, retryPrivateCleanup: () => {}, requireAccountRefresh: (_reason?: string) => {}, signOut: (_continuation?: string | null) => {} });

  useEffect(() => {
    const signal = createAccountSignal();
    let disposed = false;
    let generation = 0;
    let controller: AbortController | undefined;
    let logoutController: AbortController | undefined;
    let logoutOperation = 0;
    let logoutSource: string | null = null;
    let logoutContinuation: string | null = null;
    let resumePause: (() => void) | undefined;
    let state: View = initialView();
    let confirmed: { userId: string | null; baseline: ActiveUserRead; phase: "write" | "notification" | "complete" } | undefined;
    let baseline: ActiveUserRead = { kind: "missing" };
    let changedDuringInitialization = false;
    let publicationSource: SyncSource = "bootstrap";
    const update = (patch: Partial<View>) => {
      if (disposed) return;
      state = { ...state, ...patch };
      setView(state);
    };
    const reportIssue = (issue: AccountSignalIssue, persisted: boolean, source: SyncSource) => {
      console.warn({ component: "account-sync", phase: issue.phase, source, category: safeCauseCategory(issue.cause) });
      update({ sync: { status: "error", issue, persisted } });
    };
    const refresh = (source: SyncSource = "principal") => {
      if (disposed || state.requiresRefresh) return;
      // Set the synchronous latch before stopping any producer: abort listeners may reenter.
      update({ requiresRefresh: true, logoutPending: false });
      console.debug({ component: "account-sync", phase: "invalidate", source });
      ++generation; ++logoutOperation;
      controller?.abort(); controller = undefined;
      logoutController?.abort(); logoutController = undefined;
      resumePause = pauseAuthRequests();
      cancelAuthNetworkRequests();
    };
    const observe = (read: ActiveUserRead, source: AccountSignalSource) => {
      const issue = readIssue(read);
      if (issue) reportIssue(issue, confirmed?.phase === "notification", source);
      if (read.kind !== "known") return;
      if (confirmed) {
        if (read.userId !== confirmed.userId) refresh(source);
      } else if (!sameKnown(read, baseline)) changedDuringInitialization = true;
    };
    const unsubscribe = signal.subscribe(source => { if (!disposed) observe(signal.read(), source); });
    const sourceCurrent = (source: string | null, trigger: SyncSource) => {
      if (disposed || state.requiresRefresh) return false;
      const current = signal.read();
      const issue = readIssue(current);
      if (issue) reportIssue(issue, confirmed?.phase === "notification", trigger);
      if (current.kind === "known" && current.userId !== source) { refresh(trigger); return false; }
      return true;
    };
    const publish = () => {
      if (disposed || state.requiresRefresh || !confirmed) return;
      const current = signal.read();
      const issue = readIssue(current);
      if (issue) { reportIssue(issue, confirmed.phase === "notification", publicationSource); return; }
      if (current.kind === "known" && !sameKnown(current, confirmed.baseline) && current.userId !== confirmed.userId) { refresh(publicationSource); return; }
      if (confirmed.phase === "complete") { update({ sync: { status: "complete" } }); return; }
      const result: AccountPublication = confirmed.phase === "notification" ? signal.retryNotification(confirmed.userId) : signal.publish(confirmed.userId);
      if (result.kind === "superseded") { refresh(publicationSource); return; }
      if (result.kind === "failed") {
        if (result.persisted) confirmed.phase = "notification";
        if (confirmed.phase === "notification") confirmed.baseline = { kind: "known", userId: confirmed.userId };
        reportIssue(result.issue, confirmed.phase === "notification", publicationSource);
        return;
      }
      confirmed.phase = "complete";
      confirmed.baseline = { kind: "known", userId: confirmed.userId };
      update({ sync: { status: "complete" } });
    };
    const cleanup = (userId: string) => {
      void clearPrivateSessionState(userId).then(error => {
        if (disposed) return;
        const next = new Map(state.privateCleanup);
        if (error === null) next.delete(userId); else next.set(userId, error);
        update({ privateCleanup: next });
      });
    };
    const clearSession = (notice: SessionNotice) => {
      const user = state.session.status === "authenticated" ? state.session.user : null;
      if (user) cleanup(user.id);
      void state.scope?.invalidateScope();
      invalidateAuthRequests();
      ++generation; controller?.abort(); controller = undefined;
      update({ scope: null, session: { status: "anonymous", notice } });
    };
    const publishSignedOut = (source: string | null, trigger: "logout" | "unauthorized") => {
      if (!sourceCurrent(source, trigger)) return false;
      publicationSource = trigger;
      confirmed = { userId: null, baseline: { kind: "known", userId: source }, phase: "write" };
      publish();
      return !state.requiresRefresh;
    };
    const unsubscribeUnauthorized = subscribeUnauthorized(() => {
      // Initialization and logout handle their own 401 results.
      if (disposed || state.requiresRefresh || logoutController || state.session.status !== "authenticated") return;
      const source = state.session.user.id;
      if (!sourceCurrent(source, "unauthorized")) return;
      clearSession("expired");
      publishSignedOut(source, "unauthorized");
    });
    const initialize = () => {
      if (disposed || state.requiresRefresh || confirmed) return;
      controller?.abort();
      const currentGeneration = ++generation;
      controller = new AbortController();
      const request = controller;
      baseline = signal.read();
      changedDuringInitialization = false;
      const issue = readIssue(baseline);
      update({ session: { status: "loading" }, sync: { status: "idle" } });
      if (issue) reportIssue(issue, false, "bootstrap");
      void (async () => {
        let user: User | null;
        try { user = await me(request.signal); }
        catch (cause) {
          if (disposed || request.signal.aborted || currentGeneration !== generation || state.requiresRefresh) return;
          if (cause instanceof ApiError && cause.kind === "server" && cause.status === 401) user = null;
          else { controller = undefined; console.warn({ component: "account-sync", phase: "initial", source: "bootstrap", category: safeCauseCategory(cause) }); update({ session: { status: "error", cause } }); return; }
        }
        if (disposed || request.signal.aborted || currentGeneration !== generation || state.requiresRefresh) return;
        controller = undefined;
        const latest = signal.read();
        if (latest.kind === "known" && !sameKnown(latest, baseline)) changedDuringInitialization = true;
        const userId = user?.id ?? null;
        if (changedDuringInitialization && latest.kind === "known" && latest.userId !== userId) { refresh("bootstrap"); return; }
        confirmed = { userId, baseline: latest, phase: "write" };
        publicationSource = "bootstrap";
        const scope = user === null ? null : createTaskCacheScope({ userId: user.id, onIdentityMismatch: () => refresh("principal") });
        update({ scope, session: user === null ? { status: "anonymous" } : { status: "authenticated", user, generation: currentGeneration } });
        publish();
      })();
    };
    const signOut = (continuation: string | null = null) => {
      if (disposed || state.requiresRefresh || logoutController) return;
      const source = state.session.status === "authenticated" ? state.session.user.id : logoutSource;
      if (!sourceCurrent(source, "logout")) return;
      logoutSource = source; logoutContinuation = continuation;
      const operation = ++logoutOperation;
      const request = new AbortController(); logoutController = request;
      update({ logoutPending: true, logoutFailed: false });
      const result = logout(request.signal);
      if (state.session.status === "authenticated") clearSession("signedOut");
      const complete = () => {
        if (disposed || request.signal.aborted || operation !== logoutOperation || !publishSignedOut(source, "logout")) return;
        logoutController = undefined;
        update({ logoutPending: false });
        if (logoutContinuation === null) navigate("/"); else replaceRoute(loginUrl(logoutContinuation));
      };
      void result.then(complete).catch((error: unknown) => {
        if (disposed || request.signal.aborted || operation !== logoutOperation || isAbortError(error)) return;
        if (error instanceof ApiError && error.status === 401) { complete(); return; }
        logoutController = undefined;
        console.warn({ component: "account-sync", phase: "complete", source: "logout", category: safeCauseCategory(error) });
        update({ logoutPending: false, logoutFailed: true, session: { status: "anonymous", notice: "logoutFailed" } });
      });
    };
    const retryPrivateCleanup = () => {
      const imageCleanup = retryImageDraftScopeCleanup();
      for (const userId of state.privateCleanup.keys()) {
        const webhookError = clearWebhookPending(window.location.origin, userId);
        void Promise.all([retryBotDisplaySnapshotCleanup(userId), imageCleanup]).then(([cleared]) => {
          if (disposed) return;
          const next = new Map(state.privateCleanup);
          const imageError = imageDraftCleanupFailures().find(failure => failure.actorUserId === userId)?.error;
          const error = imageError ?? (cleared ? webhookError : new Error('Assistant display snapshots could not be cleared.'));
          if (error === null) next.delete(userId); else next.set(userId, error);
          update({ privateCleanup: next });
        });
      }
    };
    actions.current = { retryInitialization: () => { if (state.session.status === "error") initialize(); }, retryPublication: publish, retryPrivateCleanup, requireAccountRefresh: () => refresh("principal"), signOut };
    initialize();
    return () => {
      disposed = true; ++generation; ++logoutOperation;
      controller?.abort(); logoutController?.abort();
      unsubscribeUnauthorized(); unsubscribe(); signal.dispose();
      state.scope?.dispose(); resumePause?.();
      actions.current = { retryInitialization: () => {}, retryPublication: () => {}, retryPrivateCleanup: () => {}, requireAccountRefresh: () => {}, signOut: () => {} };
    };
  }, []);
  const stableActions = useMemo(() => ({
    retryInitialization: () => actions.current.retryInitialization(),
    retryPublication: () => actions.current.retryPublication(),
    retryPrivateCleanup: () => actions.current.retryPrivateCleanup(),
    requireAccountRefresh: (reason?: string) => actions.current.requireAccountRefresh(reason),
    signOut: (continuation?: string | null) => actions.current.signOut(continuation),
    reloadCurrentPage: () => window.location.reload(),
  }), []);
  return <Context value={{ ...view, ...stableActions }}>{children}</Context>;
}
export function useAccountSession(): AccountSessionValue {
  const value = useContext(Context);
  if (value === null) throw new Error("An account session provider is required.");
  return value;
}

export function useOptionalAccountSession(): AccountSessionValue | null { return useContext(Context); }
