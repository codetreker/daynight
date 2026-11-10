import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const waitCompanionReady = async (filename, completion, moduleId) => await new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true; clearTimeout(timer); observer.close();
    if (error !== null) reject(error); else resolve(value);
  };
  const inspect = async () => {
    try {
      const value = JSON.parse(await readFile(filename, "utf8"));
      if (value.kind !== "ready" || path.normalize(value.moduleId) !== path.normalize(moduleId)) throw new Error("Companion ready receipt does not identify the selected Task CLI module.");
      finish(null, value);
    } catch (error) { if (error.code !== "ENOENT") finish(error); }
  };
  const observer = watch(path.dirname(filename), (_event, changed) => { if (changed?.toString() === path.basename(filename)) void inspect(); });
  observer.once("error", error => finish(error));
  const timer = setTimeout(() => finish(new Error("Task CLI companion did not publish its first public case-ready receipt.")), 30_000);
  completion.then(() => finish(new Error("Task CLI companion completed before its readiness was observed.")), error => finish(error));
  void inspect();
});

export const overlappingCases = (original, companion, moduleId) => {
  const start = Date.parse(original.startTime), end = Date.parse(original.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Original diagnostic case has an invalid public timing window.");
  return companion.flatMap(test => {
    if (path.normalize(test.moduleId) !== path.normalize(moduleId)) throw new Error("Companion result does not identify the selected Task CLI module.");
    const companionStart = Date.parse(test.startTime), companionEnd = Date.parse(test.endTime);
    if (!Number.isFinite(companionStart) || !Number.isFinite(companionEnd) || companionEnd < companionStart) throw new Error("Companion diagnostic case has an invalid public timing window.");
    const overlapStart = Math.max(start, companionStart), overlapEnd = Math.min(end, companionEnd);
    return overlapStart < overlapEnd ? [{ name: test.name, moduleId: test.moduleId, overlapStart: new Date(overlapStart).toISOString(), overlapEnd: new Date(overlapEnd).toISOString() }] : [];
  });
};
