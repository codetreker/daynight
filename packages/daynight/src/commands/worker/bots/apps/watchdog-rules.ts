import { Worker } from "node:worker_threads";
import type { JsonValue } from "../../../../api/assistant-task.js";

export type WatchdogRule = { id: string; category: "stalled"; match?: { contains?: string; regex?: string; projectIds?: string[] }; action: { kind: "send_message"; message: string } };

/** Match only the portable subset admitted by the service's Watchdog validator. */
export const watchdogRegex = (pattern: string): string => {
  if (Buffer.byteLength(pattern) > 1024 || pattern.includes("(?") || pattern.includes("[[:")) throw new Error("Unsupported Watchdog regular expression.");
  let result = "", escaped = false, inClass = false;
  for (const char of pattern) {
    if (escaped) {
      if (!"\\.*+?()[]{}^$|/nrt-".includes(char)) throw new Error("Unsupported Watchdog regular expression escape.");
      // JavaScript Unicode mode rejects identity escapes that RE2 accepts.
      result += char === "-" && !inClass ? "-" : `\\${char}`;
      escaped = false;
    } else if (char === "\\") escaped = true;
    else {
      if (char === "[") inClass = true;
      if (char === "]") inClass = false;
      result += char === "$" && !inClass ? "(?![\\s\\S])" : char === "." && !inClass ? "[^\\n]" : char;
    }
  }
  if (escaped) throw new Error("Invalid Watchdog regular expression.");
  new RegExp(result, "u");
  return result;
};

// JS backtracking can be expensive even for patterns accepted by RE2. Keep it
// outside the host thread with a bounded lifetime; a timeout never authorizes input.
export const matchWatchdogRegex = async (pattern: string, text: string, signal: AbortSignal): Promise<boolean> => {
  signal.throwIfAborted();
  const source = watchdogRegex(pattern);
  const worker = new Worker('const {parentPort,workerData}=require("node:worker_threads"); parentPort.postMessage(new RegExp(workerData.source,"u").test(workerData.text));', { eval: true, workerData: { source, text } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => resolve(false), 250);
      worker.once("message", value => resolve(value === true));
      worker.once("error", reject);
      worker.once("exit", () => resolve(false));
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener("abort", abort);
    await worker.terminate();
  }
};

export const matchingWatchdogRule = async (rules: JsonValue, projectId: string, lastAssistantText: string | null, signal: AbortSignal): Promise<WatchdogRule | null> => {
  if (rules === null) return null;
  // Generic applications historically stored {} for a report-only manual.
  if (typeof rules === "object" && !Array.isArray(rules) && Object.keys(rules).length === 0) return null;
  if (!Array.isArray(rules)) throw new Error("Invalid Watchdog rules.");
  for (const value of rules) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Watchdog rule.");
    const rule = value as unknown as WatchdogRule;
    if (typeof rule.id !== "string" || rule.category !== "stalled" || rule.action?.kind !== "send_message" || typeof rule.action.message !== "string" || !rule.action.message.trim()) throw new Error("Invalid Watchdog action.");
    if (rule.match?.projectIds !== undefined && rule.match.projectIds.length > 0 && !rule.match.projectIds.includes(projectId)) continue;
    if (rule.match?.contains !== undefined && (lastAssistantText === null || !lastAssistantText.includes(rule.match.contains))) continue;
    if (rule.match?.regex !== undefined && (lastAssistantText === null || !await matchWatchdogRegex(rule.match.regex, lastAssistantText, signal))) continue;
    return rule;
  }
  return null;
};
