import type { Operation } from "../../../api/operation.js";
import { SESSION_V2_LIMITS, SessionV2Error, canonicalSessionJson } from "../../../session/v2/values.js";
import type { TerminalFrame } from "../../../session/v2/types.js";
import type { HerdrTaskBinding } from "./agents.js";
import { readHerdrProcessTty, readHerdrTtySize } from "./input-readiness.js";
import type { HerdrLocalSegment } from "./lifecycle-types.js";
import type { HerdrRpcClient } from "./rpc.js";
import { normalizeHerdrAnsi } from "./recording-ansi.js";
import type { HerdrRecordingStore } from "./recording-store.js";
import type { HerdrRecordingBoundary, HerdrRecordingScreen } from "./recording-types.js";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionV2Error("target_changed");
  return value as Record<string, unknown>;
};

/** No native attach, input, resize, or provider readiness inference is involved. */
export const readHerdrTerminalSnapshot = async (options: {
  binding: HerdrTaskBinding; operation: Operation; rpc: Pick<HerdrRpcClient, "request">;
  /** Verifies original owner, worktree and daemon identity, before and after read. */
  verify(): Promise<void>;
  readTty?: (pid: number, signal: AbortSignal) => Promise<string>;
  readSize?: (tty: string, signal: AbortSignal) => Promise<{ width: number; height: number }>;
}): Promise<HerdrRecordingScreen> => {
  const { binding, operation, rpc } = options;
  const topology = async () => {
    const result = await rpc.request("session.snapshot", {}, operation), snapshot = object(result.snapshot);
    if (result.type !== "session_snapshot" || !Array.isArray(snapshot.panes)) throw new SessionV2Error("target_changed");
    const panes = snapshot.panes.map(object).filter(pane => pane.pane_id === binding.paneId);
    const pane = panes[0];
    if (panes.length !== 1 || !pane || pane.workspace_id !== binding.workspaceId || pane.terminal_id !== binding.terminalId || typeof pane.tab_id !== "string") throw new SessionV2Error("target_changed");
    const infoResult = await rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), info = object(infoResult.process_info);
    if (infoResult.type !== "pane_process_info" || info.pane_id !== binding.paneId || !Number.isSafeInteger(info.shell_pid) || Number(info.shell_pid) < 1) throw new SessionV2Error("target_changed");
    const tty = info.tty ?? await (options.readTty ?? readHerdrProcessTty)(Number(info.shell_pid), operation.signal);
    if (typeof tty !== "string" || !/^\/dev\/ttys[0-9]+$/.test(tty)) throw new SessionV2Error("target_changed");
    const size = await (options.readSize ?? readHerdrTtySize)(tty, operation.signal);
    if (![size.width, size.height].every(n => Number.isInteger(n) && n > 0 && n <= SESSION_V2_LIMITS.maxDimension)) throw new SessionV2Error("recording_limit");
    return { tabId: pane.tab_id, shellPid: Number(info.shell_pid), tty, ...size };
  };
  await options.verify(); const before = await topology();
  const result = await rpc.request("pane.read", { pane_id: binding.paneId, source: "visible", format: "ansi", strip_ansi: false }, operation), read = object(result.read);
  if (result.type !== "pane_read" || read.pane_id !== binding.paneId || read.workspace_id !== binding.workspaceId || read.tab_id !== before.tabId || read.source !== "visible" || read.format !== "ansi" || read.truncated !== false || typeof read.text !== "string" || !Number.isSafeInteger(read.revision) || Number(read.revision) < 0) throw new SessionV2Error("target_changed");
  const after = await topology();
  if (canonicalSessionJson(before) !== canonicalSessionJson(after)) throw new SessionV2Error("target_changed");
  await options.verify(); operation.check();
  return { width: after.width, height: after.height, rows: normalizeHerdrAnsi(read.text, after.width, after.height) };
};

/** A single pending complete frame bounds live delivery independently of disk. */
export const startHerdrRecordingSampler = (options: {
  store: HerdrRecordingStore; segment: HerdrLocalSegment;
  read(signal: AbortSignal): Promise<HerdrRecordingScreen>;
  publish?: (frame: TerminalFrame, recorded: boolean, signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
}) => {
  const { store, segment } = options, controller = new AbortController();
  const began = performance.now(); let latestTime = segment.startedAt, stopped = false;
  let stoppedBoundary: HerdrRecordingBoundary | null = null, stopping: Promise<HerdrRecordingBoundary> | null = null;
  let latest: { frame: TerminalFrame; recorded: boolean } | null = null, publishing = false;
  const elapsed = () => String(Math.max(0, Math.floor(performance.now() - began)));
  const wallTime = () => new Date(Math.max(Date.now(), Date.parse(latestTime))).toISOString();
  const report = (error: unknown): void => { try { options.onError?.(error); } catch { /* Reporting cannot interrupt recording or shutdown. */ } };
  const publish = (): void => {
    if (publishing || latest === null || options.publish === undefined || stopped) return;
    const pending = latest; latest = null; publishing = true;
    const publication = new AbortController(), timer = setTimeout(() => publication.abort(new Error("Live frame delivery stalled.")), SESSION_V2_LIMITS.viewerStallMs);
    timer.unref();
    // The publication callback must honor cancellation; race also prevents a
    // broken transport from retaining an unbounded chain of scheduled frames.
    const signal = AbortSignal.any([controller.signal, publication.signal]);
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel(); });
    void Promise.race([Promise.resolve().then(() => options.publish!(pending.frame, pending.recorded, signal)), cancelled])
      .catch(error => { if (!stopped) report(error); })
      .finally(() => { clearTimeout(timer); signal.removeEventListener("abort", cancel); publishing = false; if (!signal.aborted) publish(); else latest = null; });
  };
  const wait = (): Promise<void> => new Promise(resolve => {
    if (controller.signal.aborted) { resolve(); return; }
    const finish = (): void => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, SESSION_V2_LIMITS.sampleIntervalMs); controller.signal.addEventListener("abort", finish, { once: true }); timer.unref();
  });
  const done = (async () => {
    while (!stopped) {
      try {
        const screen = await options.read(controller.signal);
        if (stopped) break;
        const capturedAt = wallTime(); latestTime = capturedAt;
        const result = store.sample(segment.segmentId, screen, { capturedAt, elapsedMs: elapsed() });
        if (result.changed) { latest = { frame: result.frame, recorded: result.recorded }; publish(); }
      } catch (error) {
        if (stopped) break;
        try {
          if (error instanceof SessionV2Error && error.code === "recording_limit") store.limit(segment.segmentId, elapsed(), wallTime());
          else store.interrupt(segment.segmentId, elapsed(), wallTime());
        } catch (failure) { store.fail(segment.executionGeneration); report(failure); }
        report(error);
      }
      // Start-to-start cadence would sample faster after a slow read; the policy
      // instead waits a full interval after all work in this iteration finishes.
      if (!stopped) await wait();
    }
  })();
  const cancel = (): void => {
    if (stopped) return;
    stoppedBoundary = { durationMs: elapsed(), endedAt: wallTime() };
    stopped = true; latest = null; controller.abort(new Error("Recording sampler stopped."));
  };
  return {
    done,
    cancel,
    stop: (): Promise<HerdrRecordingBoundary> => {
      cancel();
      stopping ??= done.then(() => { store.checkpoint(segment.segmentId); return { ...stoppedBoundary! }; });
      return stopping;
    },
  };
};
export type HerdrRecordingSampler = ReturnType<typeof startHerdrRecordingSampler>;
