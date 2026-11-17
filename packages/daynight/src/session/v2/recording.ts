import { SESSION_V2_LIMITS, bool, canonicalSessionJson, choice, errorCode, exact, fail, integer, list, literal, nativeText, nullable, origin, seq, text, timestamp, unique, utf8, uuid as uuidValue } from "./values.js";
import type { SessionV2Owner, SessionV2PreparedStopProof, SessionV2Run, SessionV2StopProof, SessionV2UnavailableEvidence, SessionV2UnavailableReason, TerminalBinding, TerminalFrame } from "./recording-types.js";

export const assertNativeSessionIdProgression = (previous: string | null, next: string | null): void => {
  nullable(previous, nativeText); nullable(next, nativeText);
  if (previous !== null && previous !== next) fail("target_changed");
};
export const parseTerminalBinding = (value: unknown): TerminalBinding => {
  const o = exact(value, ["instanceId", "sessionId", "workspaceId", "paneId", "terminalId", "nativeSessionId"]);
  return { instanceId: nativeText(o.instanceId), sessionId: nativeText(o.sessionId), workspaceId: nativeText(o.workspaceId), paneId: typeof o.paneId === "number" ? integer(o.paneId, 0, 4294967295) : nativeText(o.paneId), terminalId: nativeText(o.terminalId), nativeSessionId: nullable(o.nativeSessionId, nativeText) };
};
export const assertTerminalBinding = (original: TerminalBinding, current: TerminalBinding): void => {
  const { nativeSessionId: before, ...a } = original, { nativeSessionId: after, ...b } = current;
  if (canonicalSessionJson(a) !== canonicalSessionJson(b)) fail("target_changed");
  assertNativeSessionIdProgression(before, after);
};
export const parseSessionV2Owner = (value: unknown): SessionV2Owner => {
  const o = exact(value, ["projectId", "taskId", "workerId", "worktreeId", "ownerUserId", "serverOrigin", "provider"]);
  return { projectId: uuidValue(o.projectId), taskId: uuidValue(o.taskId), workerId: uuidValue(o.workerId), worktreeId: uuidValue(o.worktreeId), ownerUserId: uuidValue(o.ownerUserId), serverOrigin: origin(o.serverOrigin), provider: choice(o.provider, ["codex", "claude", "copilot"]) };
};
const color = (value: unknown): string => typeof value === "string" && /^#[0-9a-f]{6}$/.test(value) ? value : fail();
export const parseTerminalFrame = (value: unknown): TerminalFrame => {
  const o = exact(value, ["frameSeq", "capturedAt", "elapsedMs", "width", "height", "full", "rows"]);
  const rows = list(o.rows, row => {
    const runs = list(row, run => {
      const p = exact(run, ["text", "foreground", "background", "bold", "italic", "underline", "inverse"]);
      const content = text(p.text, SESSION_V2_LIMITS.maxRowBytes, true); if (/\p{Cc}/u.test(content)) return fail();
      return { text: content, foreground: nullable(p.foreground, color), background: nullable(p.background, color), bold: bool(p.bold), italic: bool(p.italic), underline: bool(p.underline), inverse: bool(p.inverse) };
    }, SESSION_V2_LIMITS.maxTextRuns);
    if (runs.reduce((sum, run) => sum + utf8.encode(run.text).length, 0) > SESSION_V2_LIMITS.maxRowBytes) return fail();
    return runs;
  });
  const result: TerminalFrame = { frameSeq: seq(o.frameSeq), capturedAt: timestamp(o.capturedAt), elapsedMs: seq(o.elapsedMs, true), width: integer(o.width, 1, 1000), height: integer(o.height, 1, 1000), full: literal(o.full, true), rows };
  if (rows.length !== result.height || utf8.encode(canonicalSessionJson(result)).length > SESSION_V2_LIMITS.frameMaxBytes) return fail("recording_limit");
  return result;
};
export const isPreparedSessionV2StopProof = (proof: SessionV2StopProof): proof is SessionV2PreparedStopProof => "nativeLaunch" in proof;
const parseStopProof = (value: unknown): SessionV2StopProof => {
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "nativeLaunch")) {
    const o = exact(value, ["recordId", "executionGeneration", "binding", "bootId", "stoppedAt", "method", "terminalStopped", "nativeLaunch", "daemon", "processes"]);
    const daemon = exact(o.daemon, ["pid", "birthToken", "bootId"]);
    const processes = list(o.processes, raw => {
      const p = exact(raw, ["role", "pid", "birthToken", "bootId"]);
      return { role: literal(p.role, "shell"), pid: integer(p.pid, 1, 2147483647), birthToken: nativeText(p.birthToken), bootId: nativeText(p.bootId) };
    }, 1, 1);
    const proof: SessionV2PreparedStopProof = { recordId: uuidValue(o.recordId), executionGeneration: seq(o.executionGeneration), binding: parseTerminalBinding(o.binding), bootId: nativeText(o.bootId), stoppedAt: timestamp(o.stoppedAt), method: choice(o.method, ["instances_exited", "boot_changed"]), terminalStopped: literal(o.terminalStopped, true), nativeLaunch: literal(o.nativeLaunch, "not_submitted"), daemon: { pid: integer(daemon.pid, 1, 2147483647), birthToken: nativeText(daemon.birthToken), bootId: nativeText(daemon.bootId) }, processes: [processes[0]!] };
    if (proof.daemon.bootId !== proof.bootId || proof.processes[0].bootId !== proof.bootId || proof.daemon.pid === proof.processes[0].pid) return fail("stop_unknown");
    return proof;
  }
  const o = exact(value, ["recordId", "executionGeneration", "binding", "bootId", "stoppedAt", "method", "terminalStopped", "processes"]);
  const processes = unique(list(o.processes, raw => {
    const p = exact(raw, ["role", "pid", "birthToken", "bootId"]);
    return { role: choice(p.role, ["shell", "agent"]), pid: integer(p.pid, 1, 2147483647), birthToken: nativeText(p.birthToken), bootId: nativeText(p.bootId) };
  }, 1000, 2), p => canonicalSessionJson([p.bootId, p.pid, p.birthToken]));
  const bootId = nativeText(o.bootId);
  if (!processes.some(p => p.role === "shell") || !processes.some(p => p.role === "agent") || processes.some(p => p.bootId !== bootId)) return fail("stop_unknown");
  return { recordId: uuidValue(o.recordId), executionGeneration: seq(o.executionGeneration), binding: parseTerminalBinding(o.binding), bootId, stoppedAt: timestamp(o.stoppedAt), method: choice(o.method, ["instances_exited", "boot_changed"]), terminalStopped: literal(o.terminalStopped, true), processes };
};
const parseRun = (value: unknown): SessionV2Run => {
  const o = exact(value, ["executionGeneration", "owner", "binding", "startedAt", "stoppedAt", "stopProof", "segmentIds"]);
  const run: SessionV2Run = { executionGeneration: seq(o.executionGeneration), owner: parseSessionV2Owner(o.owner), binding: parseTerminalBinding(o.binding), startedAt: timestamp(o.startedAt), stoppedAt: nullable(o.stoppedAt, timestamp), stopProof: nullable(o.stopProof, parseStopProof), segmentIds: unique(list(o.segmentIds, uuidValue), v => v) };
  if ((run.stoppedAt === null) !== (run.stopProof === null)) return fail("stop_unknown");
  if (run.stopProof !== null) {
    if (run.stopProof.executionGeneration !== run.executionGeneration || run.stopProof.stoppedAt !== run.stoppedAt || Date.parse(run.stoppedAt!) < Date.parse(run.startedAt)) return fail("stop_unknown");
    assertTerminalBinding(run.binding, run.stopProof.binding);
    if (isPreparedSessionV2StopProof(run.stopProof) && (run.segmentIds.length !== 0 || run.binding.nativeSessionId !== run.stopProof.binding.nativeSessionId)) return fail("stop_unknown");
  }
  return run;
};
export const parseSessionV2Runs = (value: unknown, finalGeneration: string, allStopped: boolean): SessionV2Run[] => {
  const runs = list(value, parseRun, SESSION_V2_LIMITS.maxRuns, 1), seen = new Set<string>(); let nativeSession: string | null = null;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.executionGeneration !== String(i + 1) || canonicalSessionJson(run.owner) !== canonicalSessionJson(runs[0]!.owner) || ((i < runs.length - 1 || allStopped) && run.stopProof === null)) return fail("stale_fence");
    assertNativeSessionIdProgression(nativeSession, run.binding.nativeSessionId); nativeSession = run.binding.nativeSessionId;
    if (run.stopProof) { assertNativeSessionIdProgression(nativeSession, run.stopProof.binding.nativeSessionId); nativeSession = run.stopProof.binding.nativeSessionId; }
    for (const id of run.segmentIds) { if (seen.has(id)) return fail("stale_fence"); seen.add(id); }
  }
  if (runs.at(-1)!.executionGeneration !== finalGeneration) return fail("stale_fence");
  return runs;
};
export const parseSessionV2UnavailableEvidence = (value: unknown, reason: SessionV2UnavailableReason): SessionV2UnavailableEvidence => {
  const p = exact(value, ["recordingEnabled", "selectedFrameCount", "registeredFrameCount", "captureError"]);
  const evidence = { recordingEnabled: bool(p.recordingEnabled), selectedFrameCount: seq(p.selectedFrameCount, true), registeredFrameCount: seq(p.registeredFrameCount, true), captureError: nullable(p.captureError, errorCode) };
  if (evidence.selectedFrameCount !== "0" || evidence.registeredFrameCount !== "0" || evidence.captureError !== null || evidence.recordingEnabled !== (reason === "ended_before_first_sample")) return fail();
  return evidence;
};
