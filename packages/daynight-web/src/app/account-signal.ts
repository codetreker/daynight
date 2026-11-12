const ACTIVE_USER_KEY = "daynight.activeUser";
const CHANNEL_NAME = "daynight-identity";
const CHANGE_MESSAGE = "identity-changed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ActiveUserRead =
  | { readonly kind: "known"; readonly userId: string | null }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly cause: unknown }
  | { readonly kind: "unavailable"; readonly cause: unknown };

export type AccountSignalIssue = {
  readonly phase: "read" | "parse" | "write" | "channel-open" | "channel-send";
  readonly cause: unknown;
};

export type AccountPublication =
  | { readonly kind: "complete"; readonly changed: boolean }
  | { readonly kind: "failed"; readonly issue: AccountSignalIssue; readonly persisted: boolean }
  | { readonly kind: "superseded" };

export type AccountSignalSource = "broadcast" | "storage" | "foreground";

export type AccountSignal = {
  read: () => ActiveUserRead;
  publish: (userId: string | null) => AccountPublication;
  retryNotification: (expectedUserId: string | null) => AccountPublication;
  subscribe: (listener: (source: AccountSignalSource) => void) => () => void;
  dispose: () => void;
};

function validUserId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID.test(value));
}

function issueForRead(result: Exclude<ActiveUserRead, { kind: "known" }>): AccountSignalIssue {
  if (result.kind === "invalid") return { phase: "parse", cause: result.cause };
  if (result.kind === "unavailable") return { phase: "read", cause: result.cause };
  return { phase: "read", cause: new Error("Active user record is missing") };
}

/** A local change hint; its stored value is not authentication evidence. */
export function createAccountSignal(): AccountSignal {
  let disposed = false;
  let channel: BroadcastChannel | undefined;
  let channelOpenError: unknown;
  let pending: { userId: string | null; issue: AccountSignalIssue } | undefined;
  const listeners = new Set<(source: AccountSignalSource) => void>();

  const notify = (source: AccountSignalSource) => {
    if (disposed) return;
    for (const listener of listeners) {
      if (disposed) break;
      listener(source);
    }
  };
  const onMessage = (event: MessageEvent) => {
    if (event.data === CHANGE_MESSAGE) notify("broadcast");
  };
  const openChannel = () => {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener("message", onMessage);
      channelOpenError = undefined;
    } catch (cause) {
      channel = undefined;
      channelOpenError = cause;
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACTIVE_USER_KEY || event.key === null) notify("storage");
  };
  const onForeground = () => notify("foreground");
  const onVisibility = () => {
    if (document.visibilityState === "visible") onForeground();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onForeground);
  document.addEventListener("visibilitychange", onVisibility);
  openChannel();

  const read = (): ActiveUserRead => {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(ACTIVE_USER_KEY);
    } catch (cause) {
      return { kind: "unavailable", cause };
    }
    if (raw === null) return { kind: "missing" };
    try {
      const value: unknown = JSON.parse(raw);
      if (!validUserId(value)) return { kind: "invalid", cause: new Error("Invalid active user record") };
      return { kind: "known", userId: value };
    } catch (cause) {
      return { kind: "invalid", cause };
    }
  };

  const send = (userId: string | null): AccountPublication => {
    let issue: AccountSignalIssue;
    if (!channel) {
      issue = { phase: "channel-open", cause: channelOpenError };
    } else {
      try {
        channel.postMessage(CHANGE_MESSAGE);
        pending = undefined;
        return { kind: "complete", changed: true };
      } catch (cause) {
        issue = { phase: "channel-send", cause };
      }
    }
    pending = { userId, issue };
    return { kind: "failed", issue, persisted: true };
  };

  const disposedFailure = (): AccountPublication => ({
    kind: "failed", issue: { phase: "write", cause: new Error("Account signal is disposed") }, persisted: false,
  });

  return {
    read,
    publish(userId) {
      if (disposed) return disposedFailure();
      if (!validUserId(userId)) {
        return { kind: "failed", issue: { phase: "parse", cause: new Error("Invalid active user ID") }, persisted: false };
      }
      const current = read();
      if (current.kind === "invalid" || current.kind === "unavailable") {
        return { kind: "failed", issue: issueForRead(current), persisted: false };
      }
      if (current.kind === "known" && current.userId === userId) {
        if (pending?.userId === userId) return { kind: "failed", issue: pending.issue, persisted: true };
        pending = undefined;
        return { kind: "complete", changed: false };
      }
      if (current.kind === "known" && pending && current.userId !== pending.userId) pending = undefined;
      try {
        window.localStorage.setItem(ACTIVE_USER_KEY, JSON.stringify(userId));
      } catch (cause) {
        return { kind: "failed", issue: { phase: "write", cause }, persisted: false };
      }
      return send(userId);
    },
    retryNotification(expectedUserId) {
      if (disposed) return disposedFailure();
      if (!validUserId(expectedUserId)) {
        return { kind: "failed", issue: { phase: "parse", cause: new Error("Invalid active user ID") }, persisted: false };
      }
      const current = read();
      if (current.kind !== "known") {
        return { kind: "failed", issue: issueForRead(current), persisted: false };
      }
      if (current.userId !== expectedUserId) {
        if (pending && pending.userId !== current.userId) pending = undefined;
        return { kind: "superseded" };
      }
      if (!channel) openChannel();
      return send(expectedUserId);
    },
    subscribe(listener) {
      if (!disposed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      pending = undefined;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onVisibility);
      if (channel) {
        channel.removeEventListener("message", onMessage);
        channel.close();
        channel = undefined;
      }
    },
  };
}
