import type { SessionControls } from "../../../session/controls.js";
import type { ChildProcess } from "node:child_process";
import type { InteractionResponse, SessionCapabilities, SessionSnapshot, TimelineEntry } from "../../../session/protocol.js";
export type ProviderEntry = TimelineEntry extends infer T ? T extends TimelineEntry ? Omit<T, "entrySeq"> : never : never;
export type ProviderState = { nativeSessionId: string | null; activity: SessionSnapshot["activity"]; currentTurnId: string | null; capabilities: SessionCapabilities; controls?: SessionControls; turnStartedAt?: string | null };
export type ProviderOptions = {
  cwd: string; model: string | null; args: readonly string[]; resumeNativeSessionId: string | null;
  unattended?: boolean;
  agentCliEnvironment?: Readonly<{ PATH: string; DN_CONFIG_DIR: string }>;
  env?: NodeJS.ProcessEnv; executable?: string; controlsRevisionFloor?: string;
  onTimeline(entry: ProviderEntry): void;
  onState(state: ProviderState): void;
  onSpawn(child: ChildProcess): void;
  onDiagnostic?(line: string): void;
  onFatalError?(error: Error): void;
  onControlConfirmed?(operationId: string): void;
  onInputObserved?(operationId: string): void;
};
export type ProviderReceipt = { disposition: "started" | "queued" | "handled"; turnId?: string };
export interface NativeProvider {
  readonly nativeSessionId: string;
  send(text: string, operationId: string, expectedTurnId: string | null): Promise<ProviderReceipt>;
  cancel(expectedTurnId: string): Promise<ProviderReceipt>;
  respond(interactionId: string, revision: string, response: InteractionResponse): Promise<ProviderReceipt>;
  setSetting?(settingId: string, value: string, operationId: string, expectedControlsRevision: string): Promise<ProviderReceipt>;
  executeCommand?(commandId: string, args: string, operationId: string, expectedControlsRevision: string, expectedTurnId: string | null): Promise<ProviderReceipt>;
  refreshControls?(): Promise<ProviderReceipt>;
  waitForTurn(turnId: string, deadline: number): Promise<void>;
  close(): Promise<void>;
}
