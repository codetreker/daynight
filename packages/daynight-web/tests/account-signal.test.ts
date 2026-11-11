import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountSignal } from "../src/app/account-signal";

const KEY = "daynight.activeUser";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

// JSDOM does not provide a browser BroadcastChannel. Keep its event boundary
// controllable so delayed messages and infrastructure errors can be exercised.
class TestChannel extends EventTarget {
  static instances: TestChannel[] = [];
  static openError: unknown = undefined;
  readonly name: string;
  readonly postMessage = vi.fn<(message: unknown) => void>();
  readonly close = vi.fn();
  onmessage: ((event: MessageEvent) => void) | null = null;
  private messageListeners: EventListenerOrEventListenerObject[] = [];

  constructor(name: string) {
    super();
    if (TestChannel.openError !== undefined) throw TestChannel.openError;
    this.name = name;
    TestChannel.instances.push(this);
  }

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (type === "message" && callback) this.messageListeners.push(callback);
    super.addEventListener(type, callback, options);
  }

  emit(data: unknown): void {
    const event = new MessageEvent("message", { data });
    this.dispatchEvent(event);
    this.onmessage?.(event);
  }

  deliverQueued(data: unknown): void {
    const event = new MessageEvent("message", { data });
    for (const listener of this.messageListeners) {
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    }
    this.onmessage?.(event);
  }
}

beforeEach(() => {
  TestChannel.instances = [];
  TestChannel.openError = undefined;
  vi.stubGlobal("BroadcastChannel", TestChannel);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("account signal", () => {
  it("distinguishes missing, explicit logout and canonical UUIDs from invalid records", () => {
    const signal = createAccountSignal();
    expect(signal.read()).toEqual({ kind: "missing" });
    localStorage.setItem(KEY, "null");
    expect(signal.read()).toEqual({ kind: "known", userId: null });
    localStorage.setItem(KEY, JSON.stringify(USER_A));
    expect(signal.read()).toEqual({ kind: "known", userId: USER_A });

    for (const raw of ["{", '""', '"ABCDEFAB-1234-1234-1234-123456789ABC"', '"not-a-uuid"', "true", "42", "{}", "[]"]) {
      localStorage.setItem(KEY, raw);
      const result = signal.read();
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") expect(result.cause).toBeDefined();
    }
    signal.dispose();
  });

  it("preserves storage read and write errors without reporting persistence", () => {
    const signal = createAccountSignal();
    const readError = new Error("read unavailable");
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw readError; });
    expect(signal.read()).toEqual({ kind: "unavailable", cause: readError });
    expect(signal.publish(USER_A)).toEqual({ kind: "failed", issue: { phase: "read", cause: readError }, persisted: false });
    get.mockRestore();

    const writeError = new Error("write unavailable");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw writeError; });
    expect(signal.publish(USER_A)).toEqual({ kind: "failed", issue: { phase: "write", cause: writeError }, persisted: false });
    expect(TestChannel.instances[0]?.postMessage).not.toHaveBeenCalled();
    signal.dispose();
  });

  it("rejects malformed stored and published values without writing or broadcasting", () => {
    const signal = createAccountSignal();
    localStorage.setItem(KEY, '"old invalid value"');
    const set = vi.spyOn(Storage.prototype, "setItem");
    const result = signal.publish(USER_A);
    expect(result).toMatchObject({ kind: "failed", issue: { phase: "parse" }, persisted: false });
    expect(set).not.toHaveBeenCalled();
    expect(TestChannel.instances[0]?.postMessage).not.toHaveBeenCalled();
    localStorage.removeItem(KEY);
    expect(signal.publish("NOT-A-UUID")).toMatchObject({ kind: "failed", issue: { phase: "parse" }, persisted: false });
    expect(set).not.toHaveBeenCalled();
    signal.dispose();
  });

  it("writes the new value before broadcasting and skips both for an unchanged value", () => {
    const signal = createAccountSignal();
    const channel = TestChannel.instances[0]!;
    expect(channel.name).toBe("daynight-identity");
    const set = vi.spyOn(Storage.prototype, "setItem");
    channel.postMessage.mockImplementation((message) => {
      expect(localStorage.getItem(KEY)).toBe(JSON.stringify(USER_A));
      expect(message).toBe("identity-changed");
    });
    expect(signal.publish(USER_A)).toEqual({ kind: "complete", changed: true });
    expect(set).toHaveBeenCalledExactlyOnceWith(KEY, JSON.stringify(USER_A));
    expect(channel.postMessage).toHaveBeenCalledExactlyOnceWith("identity-changed");
    expect(signal.publish(USER_A)).toEqual({ kind: "complete", changed: false });
    expect(set).toHaveBeenCalledTimes(1);
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
    channel.postMessage.mockReset();
    expect(signal.publish(null)).toEqual({ kind: "complete", changed: true });
    expect(localStorage.getItem(KEY)).toBe("null");
    expect(channel.postMessage).toHaveBeenCalledExactlyOnceWith("identity-changed");
    signal.dispose();
  });

  it("keeps a failed send distinct from a normal same-value no-op and retries only the notification", () => {
    const signal = createAccountSignal();
    const channel = TestChannel.instances[0]!;
    const failure = new Error("send unavailable");
    channel.postMessage.mockImplementationOnce(() => { throw failure; });
    const set = vi.spyOn(Storage.prototype, "setItem");
    expect(signal.publish(USER_A)).toEqual({ kind: "failed", issue: { phase: "channel-send", cause: failure }, persisted: true });
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(USER_A));
    expect(signal.publish(USER_A).kind).toBe("failed");
    expect(signal.retryNotification(USER_A)).toEqual({ kind: "complete", changed: true });
    expect(set).toHaveBeenCalledTimes(1);
    expect(channel.postMessage).toHaveBeenCalledTimes(2);
    expect(signal.publish(USER_A)).toEqual({ kind: "complete", changed: false });
    signal.dispose();
  });

  it("reopens a failed channel on explicit retry without rewriting the value", () => {
    const failure = new Error("channel unavailable");
    TestChannel.openError = failure;
    const signal = createAccountSignal();
    expect(signal.publish(USER_A)).toEqual({ kind: "failed", issue: { phase: "channel-open", cause: failure }, persisted: true });
    const set = vi.spyOn(Storage.prototype, "setItem");
    TestChannel.openError = undefined;
    expect(signal.retryNotification(USER_A)).toEqual({ kind: "complete", changed: true });
    expect(set).not.toHaveBeenCalled();
    expect(TestChannel.instances[0]?.postMessage).toHaveBeenCalledExactlyOnceWith("identity-changed");
    signal.dispose();
  });

  it("retains a pending notification if a later change fails to write", () => {
    const signal = createAccountSignal();
    const channel = TestChannel.instances[0]!;
    const sendFailure = new Error("send unavailable");
    channel.postMessage.mockImplementationOnce(() => { throw sendFailure; });
    expect(signal.publish(USER_A)).toMatchObject({ kind: "failed", persisted: true });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("write unavailable"); });
    expect(signal.publish(USER_B)).toMatchObject({ kind: "failed", issue: { phase: "write" }, persisted: false });
    write.mockRestore();
    expect(signal.publish(USER_A)).toEqual({ kind: "failed", issue: { phase: "channel-send", cause: sendFailure }, persisted: true });
    expect(signal.retryNotification(USER_A)).toEqual({ kind: "complete", changed: true });
    signal.dispose();
  });

  it("does not discard a newer pending notification when an old retry is superseded", () => {
    const signal = createAccountSignal();
    const channel = TestChannel.instances[0]!;
    const failure = new Error("send unavailable");
    channel.postMessage.mockImplementationOnce(() => { throw failure; });
    expect(signal.publish(USER_B)).toMatchObject({ kind: "failed", persisted: true });
    expect(signal.retryNotification(USER_A)).toEqual({ kind: "superseded" });
    expect(signal.publish(USER_B)).toEqual({ kind: "failed", issue: { phase: "channel-send", cause: failure }, persisted: true });
    expect(signal.retryNotification(USER_B)).toEqual({ kind: "complete", changed: true });
    signal.dispose();
  });

  it("does not overwrite a newer account or fabricate a known value during retry", () => {
    const signal = createAccountSignal();
    const channel = TestChannel.instances[0]!;
    localStorage.setItem(KEY, JSON.stringify(USER_B));
    const set = vi.spyOn(Storage.prototype, "setItem");
    expect(signal.retryNotification(USER_A)).toEqual({ kind: "superseded" });
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(USER_B));
    localStorage.removeItem(KEY);
    expect(signal.retryNotification(USER_A)).toMatchObject({ kind: "failed", issue: { phase: "read" } });
    localStorage.setItem(KEY, '"invalid"');
    expect(signal.retryNotification(USER_A)).toMatchObject({ kind: "failed", issue: { phase: "parse" } });
    const failure = new Error("read unavailable");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw failure; });
    expect(signal.retryNotification(USER_A)).toMatchObject({ kind: "failed", issue: { phase: "read", cause: failure } });
    expect(set).toHaveBeenCalledTimes(1); // only the explicit invalid fixture write
    expect(channel.postMessage).not.toHaveBeenCalled();
    signal.dispose();
  });

  it("signals subscribers to read current storage for supported events without feedback or network", () => {
    const signal = createAccountSignal();
    const channel = TestChannel.instances[0]!;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    localStorage.setItem(KEY, JSON.stringify(USER_B));
    const set = vi.spyOn(Storage.prototype, "setItem");
    const reads: unknown[] = [];
    const unsubscribe = signal.subscribe(() => reads.push(signal.read()));

    channel.emit({ type: "identity-changed", userId: USER_A });
    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: JSON.stringify(USER_A) }));
    expect(reads).toEqual([]);
    channel.emit("identity-changed");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: JSON.stringify(USER_A) }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    window.dispatchEvent(new Event("focus"));
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    visible.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(reads).toEqual(Array(5).fill({ kind: "known", userId: USER_B }));
    expect(set).not.toHaveBeenCalled();
    expect(channel.postMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    unsubscribe();
    channel.emit("identity-changed");
    expect(reads).toHaveLength(5);
    signal.dispose();
  });

  it("disposes listeners and suppresses already queued channel events", () => {
    const signal = createAccountSignal();
    const channel = TestChannel.instances[0]!;
    const listener = vi.fn();
    signal.subscribe(listener);
    signal.dispose();
    expect(channel.close).toHaveBeenCalledTimes(1);
    channel.emit("identity-changed");
    channel.deliverQueued("identity-changed");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();
    signal.dispose();
    expect(channel.close).toHaveBeenCalledTimes(1);
  });
});
