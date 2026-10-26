import { mockSidebarMediaQuery } from "./helpers/mediaQuery";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { runInThisContext } from "node:vm";
import { setImmediate } from 'node:timers/promises';
import { IDBFactory, IDBDatabase, IDBRequest, IDBOpenDBRequest, IDBTransaction, IDBObjectStore, IDBCursor, IDBCursorWithValue, IDBIndex, IDBKeyRange, IDBVersionChangeEvent } from "fake-indexeddb";

declare module "vitest" {
  interface Matchers<R, T> extends TestingLibraryMatchers<unknown, R> {}
}

// JSDOM has no layout and returns grouped selector matches out of document order.
// We use upstream traversal in tests; real browser checks own visibility and focus behavior.
// https://github.com/focus-trap/tabbable/blob/7dbb9e9bf1636b02c2fc6955f0719648bb465743/README.md#testing-in-jsdom
vi.mock("tabbable", async (original) => {
  const actual = await original<typeof import("tabbable")>();
  return { ...actual, tabbable: (container: Element, options?: Parameters<typeof actual.tabbable>[1]) => actual.tabbable(container, { ...options, displayCheck: "none", getShadowRoot: true }) };
});

// JSDOM does not implement the native top layer. These shims expose open state;
// browser acceptance owns modal focus, inertness, positioning and light dismissal.
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
  close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } },
});
Object.defineProperties(HTMLElement.prototype, {
  showPopover: { configurable: true, value: function (this: HTMLElement) { this.hidden = false; this.style.display = "block"; } },
  hidePopover: { configurable: true, value: function (this: HTMLElement) { this.hidden = true; this.style.display = "none"; } },
});

expect.extend(matchers);

const pendingStorage = new Set<Promise<void>>();
const databaseHandles = new Set<IDBDatabase>();
let cleaningStorage = false;
const trackStorageOperation = (target: EventTarget, events: readonly string[]) => {
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => { settle = resolve; });
  const complete = () => {
    for (const event of events) target.removeEventListener(event, complete);
    pendingStorage.delete(pending);
    settle();
  };
  for (const event of events) target.addEventListener(event, complete);
  pendingStorage.add(pending);
};

beforeEach(() => {
  window.history.replaceState(null, "", "/projects");
  cleaningStorage = false;
  mockSidebarMediaQuery();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  if (globalThis.structuredClone === undefined) vi.stubGlobal("structuredClone", runInThisContext("structuredClone"));
  const indexedDB = new IDBFactory();
  for (const [name, value] of Object.entries({ indexedDB, IDBFactory, IDBDatabase, IDBRequest, IDBOpenDBRequest, IDBTransaction, IDBObjectStore, IDBCursor, IDBCursorWithValue, IDBIndex, IDBKeyRange, IDBVersionChangeEvent })) vi.stubGlobal(name, value);
  const open = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
    const request = open(name, version);
    trackStorageOperation(request, ['success', 'error']);
    request.addEventListener('success', () => {
      databaseHandles.add(request.result);
      if (cleaningStorage) request.result.close();
    }, { once: true });
    return request;
  });
  const remove = indexedDB.deleteDatabase.bind(indexedDB);
  vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation((name) => {
    const request = remove(name);
    trackStorageOperation(request, ['success', 'error']);
    return request;
  });
  const transaction = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    const result = transaction.apply(this, args);
    trackStorageOperation(result, ['complete', 'abort']);
    return result;
  });
});

afterEach(async () => {
  cleanup();
  cleaningStorage = true;
  for (const database of databaseHandles) database.close();
  do {
    await Promise.all([...pendingStorage]);
    await setImmediate();
  } while (pendingStorage.size !== 0);
  databaseHandles.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/projects");
});
