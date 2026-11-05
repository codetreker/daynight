import type { Operation } from "../../../api/operation.js";
import { SessionV2Error } from "../../../session/v2/values.js";
import { HerdrInputBlockedError } from "./agents.js";
import type { HerdrAgentObservation, HerdrTaskBinding } from "./agents.js";
import { nativeInputBlocker } from "./input-blockers.js";
import type { NativeInputBlocker } from "./input-blockers.js";
import { hasEmptyResumeComposer } from "./resume-composer.js";
import { readMacProcessTty, readMacTtySize } from "./native-tty.js";
import type { createHerdrRpcClient } from "./rpc.js";

export type HerdrInputPurpose = "automatic" | "manual" | "resume" | "cleanup";
export type HerdrInputReadiness = { width: number; height: number; herdrVersion: string; composer: "empty" | "unavailable" };
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionV2Error("target_changed");
  return value as Record<string, unknown>;
};
const list = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw new SessionV2Error("target_changed");
  return value.map(object);
};

export const readHerdrProcessTty = readMacProcessTty;
export const readHerdrTtySize = readMacTtySize;

/** Read-only checks never attach or infer a provider acknowledgement from a screen. */
export const inspectHerdrInput = async (options: {
  binding: HerdrTaskBinding;
  provider: "codex" | "claude" | "copilot";
  purpose: HerdrInputPurpose;
  operation: Operation;
  observe: () => Promise<HerdrAgentObservation>;
  rpc: Pick<ReturnType<typeof createHerdrRpcClient>, "request">;
  readTty?: (pid: number, signal: AbortSignal) => Promise<string>;
  readSize?: (tty: string, signal: AbortSignal) => Promise<{ width: number; height: number }>;
}): Promise<HerdrInputReadiness> => {
  const { binding, operation, rpc } = options;
  const verify = async (): Promise<void> => {
    const observed = await options.observe();
    if (JSON.stringify(observed.binding) !== JSON.stringify(binding)) throw new SessionV2Error("target_changed");
    // A completed turn may retain its interactive process and accept continuation.
    if (observed.kind !== options.provider || observed.launchPending || observed.status === "unknown" || (observed.status === "done" && !observed.interactiveReady)) throw new SessionV2Error("automation_suspended");
    if (options.purpose !== "manual" && ((observed.status !== "idle" && observed.status !== "done") || !observed.interactiveReady)) throw new SessionV2Error("automation_suspended");
  };
  const topology = async () => {
    const result = await rpc.request("session.snapshot", {}, operation);
    if (result.type !== "session_snapshot") throw new SessionV2Error("target_changed");
    const snapshot = object(result.snapshot);
    const panes = list(snapshot.panes).filter(pane => pane.pane_id === binding.paneId);
    if (panes.length !== 1 || panes[0]!.workspace_id !== binding.workspaceId || panes[0]!.terminal_id !== binding.terminalId) throw new SessionV2Error("target_changed");
    const pane = panes[0]!;
    const infoResult = await rpc.request("pane.process_info", { pane_id: binding.paneId }, operation);
    const info = object(infoResult.process_info);
    if (infoResult.type !== "pane_process_info" || info.pane_id !== binding.paneId || !Number.isSafeInteger(info.shell_pid) || Number(info.shell_pid) <= 0) throw new SessionV2Error("target_changed");
    const tty = info.tty ?? await (options.readTty ?? readHerdrProcessTty)(Number(info.shell_pid), operation.signal);
    if (typeof tty !== "string" || !/^\/dev\/ttys[0-9]+$/.test(tty)) throw new SessionV2Error("target_changed");
    const size = await (options.readSize ?? readHerdrTtySize)(tty, operation.signal);
    if (![size.width, size.height].every(value => Number.isInteger(value) && value >= 1 && value <= 1000)) throw new SessionV2Error("invalid_payload");
    return { tabId: pane.tab_id, tty, shellPid: Number(info.shell_pid), ...size };
  };
  await verify();
  const version = await rpc.request("ping", {}, operation);
  if (version.type !== "pong" || version.version !== "0.9.5") throw new SessionV2Error("unsupported_protocol");
  const before = await topology();
  let composer: HerdrInputReadiness["composer"] = "unavailable";
  let blocker: NativeInputBlocker | null = null;
  let resumeEmpty = false;
  if (options.purpose !== "manual" && options.provider !== "copilot") {
    const format = options.purpose === "resume" ? "ansi" : "text";
    const result = await rpc.request("pane.read", { pane_id: binding.paneId, source: "visible", format, strip_ansi: format === "text" }, operation);
    const read = object(result.read);
    if (result.type !== "pane_read" || read.pane_id !== binding.paneId || read.workspace_id !== binding.workspaceId || read.tab_id !== before.tabId || read.source !== "visible" || read.format !== format || read.truncated !== false || typeof read.text !== "string") throw new SessionV2Error("target_changed");
    if (options.purpose === "resume") resumeEmpty = hasEmptyResumeComposer(options.provider, read.text);
    else blocker = nativeInputBlocker(options.provider, read.text);
  }
  // Copilot exposes no cross-version empty-composer proof. Explicit handback
  // remains a human decision; native idle alone never leaves manual/suspended.
  const after = await topology();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new SessionV2Error("target_changed");
  await verify(); operation.check();
  if (options.purpose === "resume" && options.provider !== "copilot") {
    if (!resumeEmpty) throw new SessionV2Error("automation_suspended");
    composer = "empty";
  }
  if (blocker !== null) throw new HerdrInputBlockedError(blocker);
  return { width: after.width, height: after.height, herdrVersion: version.version, composer };
};
