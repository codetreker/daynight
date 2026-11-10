import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { checkPrototype, storageProbeScript } from "./check-prototype.mjs";

// The fake page answers the in-page probe by operation, so these tests cover the orchestration;
// the probe itself runs in a real browser when the reference's example is followed.
function fakePage({ controls = [], actions = 0, overflow = () => [], tabbable = { keys: [], total: 0 }, focusOrder = [], storage = [], click, selectOption } = {}) {
  const listeners = new Map();
  let focusIndex = 0;
  const page = {
    calls: [],
    on: (event, listener) => listeners.set(event, listener),
    off: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
    listeners,
    emit: (event, value) => listeners.get(event)?.(value),
    evaluate: async (fn, input) => {
      assert.equal(typeof fn, "function");
      page.calls.push(["evaluate", input.op]);
      switch (input.op) {
        case "controls": return controls;
        case "actions": return actions;
        case "overflow": return overflow(page.calls.filter(([name]) => name === "selectOption").length);
        case "tabbable": return tabbable;
        case "focused": return focusOrder[focusIndex++ % Math.max(focusOrder.length, 1)] ?? null;
        case "storage": return storage;
        default: throw new Error(`unexpected ${input.op}`);
      }
    },
    selectOption: async (selector, value) => { page.calls.push(["selectOption", selector, value]); await selectOption?.(selector, value); },
    click: async (selector, options) => { page.calls.push(["click", selector, options.timeout]); await click?.(page, selector); },
    waitForTimeout: async () => {},
    reload: async () => { page.calls.push(["reload"]); },
    keyboard: { press: async (key) => { page.calls.push(["press", key]); } },
  };
  return page;
}

const controls = [
  { index: 0, label: "版本", values: ["proposal", "current"] },
  { index: 1, label: "宽度", values: ["224", "294", "760"] },
];

test("visits every inspection option, bounds clicks per state and checks keyboard reach", async () => {
  const page = fakePage({ controls, actions: 3, tabbable: { keys: ["form:0>button:1", "form:0>textarea:0"], total: 4 }, focusOrder: [null, "form:0>textarea:0", "form:0>button:1"] });
  const result = await checkPrototype(page, { maxActionsPerState: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.states, 5);
  assert.deepEqual(result.controls, [{ label: "版本", values: 2 }, { label: "宽度", values: 3 }]);
  assert.deepEqual(page.calls.filter(([name]) => name === "selectOption").map(([, selector, value]) => [selector, value]), [
    [".proto-bar select >> nth=0", "proposal"], [".proto-bar select >> nth=0", "current"],
    [".proto-bar select >> nth=1", "224"], [".proto-bar select >> nth=1", "294"], [".proto-bar select >> nth=1", "760"],
  ]);
  assert.equal(result.actionsClicked, 10);
  assert.ok(page.calls.filter(([name]) => name === "click").every(([, selector]) => selector.startsWith("#device :is(") && selector.includes(">> visible=true >> nth=")));
  assert.equal(page.calls.filter(([name]) => name === "reload").length, 1);
  assert.equal(page.calls.filter(([name]) => name === "press").length, 4 * 2 + 8);
  assert.deepEqual(result.focus, { tabbable: 2, reached: 2, missing: [] });
  assert.equal(page.listeners.size, 0);
});

test("reports storage access, overflow, unreachable controls, page errors and dialogs", async () => {
  let dismissed = 0;
  const page = fakePage({
    controls: [{ index: 0, label: "", values: ["224"] }],
    actions: 1,
    overflow: () => ["div:0>button:2.send"],
    tabbable: { keys: ["button:0", "button:1"], total: 2 },
    focusOrder: ["button:0"],
    storage: ["localStorage", "cookie"],
    click: async (current) => {
      current.emit("pageerror", new Error("draft is undefined"));
      current.emit("console", { type: () => "error", text: () => "Failed to load resource" });
      current.emit("console", { type: () => "log", text: () => "ignored" });
      current.emit("dialog", { type: () => "confirm", dismiss: async () => { dismissed++; } });
    },
  });
  const result = await checkPrototype(page);
  assert.equal(result.ok, false);
  assert.deepEqual(result.overflow, [{ state: "control 0=224", elements: ["div:0>button:2.send"] }]);
  assert.deepEqual(result.focus.missing, ["button:1"]);
  assert.deepEqual(result.storage, ["localStorage", "cookie"]);
  assert.deepEqual(result.errors.map((error) => error.kind), ["pageerror", "console", "dialog"]);
  assert.equal(dismissed, 1);
});

test("counts vanished click targets without stopping the check", async () => {
  const page = fakePage({ actions: 2, click: async () => { throw new Error("Timeout 2000ms exceeded"); } });
  const result = await checkPrototype(page);
  assert.equal(result.states, 1);
  assert.equal(result.actionsClicked, 0);
  assert.equal(result.actionFailures, 2);
});

test("removes its listeners when the product area is missing or a control fails", async () => {
  const missing = fakePage({ controls: { missingArea: true } });
  await assert.rejects(checkPrototype(missing), /product area #device was not found/);
  assert.equal(missing.listeners.size, 0);
  const failing = fakePage({ controls, selectOption: async () => { throw new Error("option detached"); } });
  await assert.rejects(checkPrototype(failing), /option detached/);
  assert.equal(failing.listeners.size, 0);
  await assert.rejects(checkPrototype(fakePage(), { maxActionsPerState: -1 }), /maxActionsPerState/);
});

test("the storage probe records each persistent storage access", () => {
  class Document {}
  const sandbox = { Document };
  vm.createContext(sandbox);
  vm.runInContext(storageProbeScript, sandbox);
  assert.equal(vm.runInContext("localStorage", sandbox), undefined);
  vm.runInContext("try { sessionStorage.setItem('x', '1') } catch {}", sandbox);
  vm.runInContext("indexedDB; caches", sandbox);
  vm.runInContext("const d = new Document(); d.cookie = 'a=1'; d.cookie", sandbox);
  assert.deepEqual([...vm.runInContext("__prototypeStorageAccess", sandbox)], ["localStorage", "sessionStorage", "indexedDB", "caches", "cookie", "cookie"]);
});
