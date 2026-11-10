import { watch } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const writeGate = async (filename, value) => {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" }); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
};
const waitGate = async filename => await new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true; clearTimeout(timer); observer.close();
    if (error !== null) reject(error); else resolve(value);
  };
  const inspect = async () => {
    try { finish(null, JSON.parse(await readFile(filename, "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") finish(error); }
  };
  const observer = watch(path.dirname(filename), (_event, file) => { if (file?.toString() === path.basename(filename)) void inspect(); });
  observer.once("error", error => finish(error));
  const timer = setTimeout(() => finish(new Error("The diagnostic capture acknowledgement was not received.")), 30_000);
  void inspect();
});
export const requestCapture = async (folder, kind, value) => {
  await writeGate(path.join(folder, `${kind}.request.json`), { kind, ...value });
  const ack = await waitGate(path.join(folder, `${kind}.ack.json`));
  if (ack.kind !== kind || ack.accepted !== true) throw new Error(`The diagnostic ${kind} capture was not acknowledged: ${ack.error?.message}`);
};
const describe = (error, depth = 0) => ({ name: error.name, message: error.message, code: error.code,
  ...(depth < 4 && error.cause instanceof Error ? { cause: describe(error.cause, depth + 1) } : {}),
  ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.map(value => value instanceof Error ? describe(value, depth + 1) : { name: "NonError", message: String(value) }) } : {}) });
export const serveCapture = (folder, moduleId, handlers) => {
  const seen = new Set(), errors = [], requests = [];
  let queue = Promise.resolve();
  const inspect = async kind => {
    if (seen.has(kind)) return;
    let value;
    try { value = JSON.parse(await readFile(path.join(folder, `${kind}.request.json`), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    seen.add(kind);
    if (value.kind !== kind || path.normalize(value.moduleId) !== path.normalize(moduleId) || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("Capture gate did not identify the original Bot worker.");
    requests.push(value);
    try { await handlers[kind](value); await writeGate(path.join(folder, `${kind}.ack.json`), { kind, accepted: true }); }
    catch (error) {
      const details = describe(error);
      errors.push({ kind, ...details });
      await writeGate(path.join(folder, `${kind}.ack.json`), { kind, accepted: false, error: details });
    }
  };
  const enqueue = kind => {
    queue = queue.then(() => inspect(kind)).catch(error => { errors.push({ kind, ...describe(error) }); });
  };
  const observer = watch(folder, (_event, file) => { if (file?.toString() === "start.request.json") enqueue("start"); else if (file?.toString() === "end.request.json") enqueue("end"); });
  observer.on("error", error => errors.push(describe(error)));
  enqueue("start"); enqueue("end");
  return { close: async () => { observer.close(); await queue; return { requests, errors, startSeen: seen.has("start"), endSeen: seen.has("end") }; } };
};

export const beginCapture = async (begin, stop) => {
  try { await begin(); }
  catch (error) {
    try { await stop(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Capture setup and owned trace cleanup failed.", { cause: error }); }
    throw error;
  }
};
