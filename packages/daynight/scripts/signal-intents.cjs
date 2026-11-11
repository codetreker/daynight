"use strict";

const { ChildProcess } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { writeFileSync, mkdirSync, writeSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { constants } = require("node:os");
const path = require("node:path");
const { getCallSites, types: { isProxy } } = require("node:util");
const { threadId } = require("node:worker_threads");

const limits = Object.freeze({ event: 16_384, bytes: 262_144, events: 1_024, frames: 12, field: 512 });
module.exports = { limits };

// Capture operations before test code can replace them. Selected records have no
// prototype, so a later Object.prototype.toJSON cannot enter the diagnostic path.
const apply = Reflect.apply, own = Object.getOwnPropertyDescriptor;
const create = Object.create, assign = Object.assign, setPrototype = Object.setPrototypeOf;
const define = Object.defineProperty, stringify = JSON.stringify;
const bytes = Buffer.byteLength, slice = String.prototype.slice, upper = String.prototype.toUpperCase;
const now = Date.now, monotonic = process.hrtime.bigint, number = Number, finite = Number.isFinite;
const ceil = Math.ceil, signals = constants.signals;
const data = value => assign(create(null), value);
const text = value => {
  const candidate = apply(slice, value, [0, limits.field]);
  if (candidate.length === value.length && bytes(stringify(candidate)) <= limits.field) return candidate;
  const suffix = "... [truncated]";
  let low = 0, high = limits.field;
  while (low < high) {
    const middle = ceil((low + high) / 2);
    if (bytes(stringify(apply(slice, candidate, [0, middle]) + suffix)) <= limits.field) low = middle;
    else high = middle - 1;
  }
  return apply(slice, candidate, [0, low]) + suffix;
};

function install(directory) {
  const identity = data({ version: 1, pid: process.pid, ppid: process.ppid, threadId, token: randomUUID() });
  const filename = path.join(directory, `${identity.pid}-${threadId}-${identity.token}.jsonl`);
  let sequence = 0, used = 0, count = 0, exhausted = false, unavailable = false;
  const envelope = value => assign(data(identity), { sequence: ++sequence, at: now(), monotonicMs: number(monotonic()) / 1e6 }, value);
  const failed = () => {
    if (unavailable) return;
    unavailable = true;
    try { writeSync(2, stringify(envelope(data({ kind: "diagnostic-write-failed", target: "signal-intents", message: "Signal evidence is unavailable; original calls continue." }))) + "\n"); } catch { /* No usable diagnostic sink remains. */ }
  };
  const write = event => {
    const line = stringify(event) + "\n";
    // appendFileSync delegates through mutable fs.writeFileSync. The captured
    // UTF-8 writer goes directly to Node's native write path for this owned file.
    writeFileSync(filename, line, data({ mode: 0o600, flag: "a", encoding: "utf8" }));
    used += bytes(line);
  };
  const record = value => {
    if (unavailable || exhausted) return;
    try {
      const event = envelope(value), size = bytes(stringify(event) + "\n");
      if (count >= limits.events || size > limits.event || used + size > limits.bytes - 1_024) {
        exhausted = true;
        write(envelope(data({ kind: "diagnostics-truncated", reason: "process-budget", message: "Later signal requests are omitted; original calls continue." })));
        return;
      }
      count++; write(event);
    } catch { failed(); }
  };
  try { mkdirSync(directory, { recursive: true }); } catch { failed(); }

  const selected = (value, signal = false) => {
    const type = value === null ? "null" : typeof value;
    if (type === "number") return data({ type, value: finite(value) ? value : null });
    if (signal && type === "string" && value.length <= 32 && own(signals, apply(upper, value, []))) return data({ type, value });
    // Unknown strings and objects may contain private data or executable coercion.
    return data({ type });
  };
  const childTarget = receiver => {
    if ((typeof receiver !== "object" && typeof receiver !== "function") || receiver === null || isProxy(receiver)) return data({ type: "unavailable" });
    const descriptor = own(receiver, "pid");
    return descriptor && own(descriptor, "value") ? selected(descriptor.value) : data({ type: "unavailable" });
  };
  const stack = () => {
    if (typeof getCallSites !== "function") return data({ stackUnavailable: "getCallSites-unavailable" });
    // This public API bypasses Error.prepareStackTrace. Disabling source maps
    // also avoids resolving user-controlled source-map data while sending a signal.
    const sites = getCallSites(limits.frames, { sourceMap: false });
    const frames = setPrototype([], null);
    for (let index = 2; index < sites.length; index++) {
      const site = sites[index];
      frames[index - 2] = data({ file: text(site.scriptName), function: text(site.functionName), line: site.lineNumber, column: site.columnNumber });
    }
    return data({ stack: frames, stackAtFrameLimit: sites.length === limits.frames });
  };
  const intent = (api, target, signal, supplied) => {
    if (unavailable || exhausted) return;
    let trace;
    try { trace = stack(); } catch { trace = data({ stackUnavailable: "capture-failed" }); }
    record(assign(data({ kind: "signal-intent", api, target, signal: selected(signal, true), signalSupplied: supplied }), trace));
  };
  const hooks = data({});
  for (const [object, name, api] of [[process, "kill", "process.kill"], [ChildProcess.prototype, "kill", "ChildProcess.kill"]]) {
    const descriptor = own(object, name), original = descriptor?.value;
    if (typeof original !== "function") { hooks[api] = false; continue; }
    const wrapped = function () {
      try {
        if (api === "process.kill") intent(api, selected(arguments.length > 0 ? arguments[0] : undefined), arguments.length > 1 ? arguments[1] : undefined, arguments.length > 1);
        else intent(api, childTarget(this), arguments.length > 0 ? arguments[0] : undefined, arguments.length > 0);
      } catch { failed(); }
      // Do not catch, translate, repeat or suppress the original call's outcome.
      return apply(original, this, arguments);
    };
    try { define(object, name, { ...descriptor, value: wrapped }); hooks[api] = true; }
    catch { hooks[api] = false; }
  }
  try { syncBuiltinESMExports(); } catch { hooks.esmExports = false; }
  record(data({ kind: "bootstrap", executable: path.basename(process.execPath), node: process.version, hooks, limits: data(limits) }));
}

const directory = process.env.DAYNIGHT_SIGNAL_INTENTS_DIRECTORY;
if (directory) {
  try { install(directory); }
  catch {
    try { writeSync(2, '{"kind":"signal-intents-unavailable","message":"Signal preload initialization failed; command execution continues."}\n'); } catch { /* Preserve command execution. */ }
  }
}
