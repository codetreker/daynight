import type { CaptureStageInput } from "../media/preparations.js";
import type { ImageCaptureRequest, ImageCaptureReceipt, ImageError, ImageOccurrence, NativeImageSource, InputObservation, ValidatedImage } from "../../../session/image-values.js";
import type { SessionControls } from "../../../session/controls.js";
import type { ChildProcess } from "node:child_process";
import type { InteractionResponse, SessionCapabilities, SessionSnapshot, TimelineEntry, TextPart } from "../../../session/protocol.js";
/** Private immutable files are supplied only by the Controller's input lease. */
export type NativeImagePart = { readonly type: "image"; readonly imageId: string; readonly resourceId: string; readonly mediaType: string; readonly byteLength: string; readonly sha256: string; readonly localPath: string };
export type NativeInput = { readonly content: readonly (TextPart | NativeImagePart)[] };
export type ProviderEntry = TimelineEntry extends infer T ? T extends TimelineEntry ? Omit<T, "entrySeq"> : never : never;
/** Native body lifecycle, supplied by the adapter rather than source text. */
export type MarkdownTimelineMetadata = {
  complete: boolean;
  format: "markdown" | "plain";
  truncated: boolean;
};
export type ProviderState = { nativeSessionId: string | null; activity: SessionSnapshot["activity"]; currentTurnId: string | null; capabilities: SessionCapabilities; controls?: SessionControls; turnStartedAt?: string | null };
export type ProviderOptions = {
  cwd: string; model: string | null; args: readonly string[]; resumeNativeSessionId: string | null;
  /** Frozen role text for native prompt append on start and resume, separate from user input. */
  instructions?: string;
  unattended?: boolean;
  validateNativeSelection?: true;
  agentCliEnvironment?: Readonly<{ PATH: string; DN_CONFIG_DIR: string }>;
  env?: NodeJS.ProcessEnv; executable?: string; controlsRevisionFloor?: string;
  onTimeline(entry: ProviderEntry, metadata?: MarkdownTimelineMetadata): void;
  /** Whether this Session already durably owns a projected timeline identity. */
  hasTimelineEntry?(entryId: string): boolean;
  onState(state: ProviderState): void;
  onSpawn(child: ChildProcess): void;
  onDiagnostic?(line: string): void;
  onFatalError?(error: Error): void;
  onControlConfirmed?(operationId: string): void;
  onInputObserved?(observation: string | InputObservation): void;
  /** Registration is durable; capture must wait until the original position is acknowledged. */
  onImageOccurrence?(occurrence: ImageOccurrence, source: NativeImageSource | null): boolean;
  imageOccurrenceAcknowledged?(imageId: string): boolean;
  registerImageCapture?(request: ImageCaptureRequest): Promise<ImageCaptureReceipt>;
  queryImageCapture?(captureId: string): Promise<ImageCaptureReceipt>;
  commitImageCapture?(captureId: string, attemptId: string, validated: ValidatedImage): Promise<ImageCaptureReceipt>;
  failImageCapture?(captureId: string, attemptId: string, error: ImageError): Promise<ImageCaptureReceipt>;
  stageImageCapture?(input: CaptureStageInput): Promise<ValidatedImage>;
};
export type ProviderReceipt = { disposition: "started" | "queued" | "handled"; turnId?: string };
export interface NativeProvider {
  readonly nativeSessionId: string;
  send(input: NativeInput, operationId: string, expectedTurnId: string | null): Promise<ProviderReceipt>;
  cancel(expectedTurnId: string): Promise<ProviderReceipt>;
  respond(interactionId: string, revision: string, response: InteractionResponse): Promise<ProviderReceipt>;
  setSetting?(settingId: string, value: string, operationId: string, expectedControlsRevision: string): Promise<ProviderReceipt>;
  executeCommand?(commandId: string, args: string, operationId: string, expectedControlsRevision: string, expectedTurnId: string | null): Promise<ProviderReceipt>;
  refreshControls?(): Promise<ProviderReceipt>;
  waitForTurn(turnId: string, deadline: number): Promise<void>;
  /** Resolve the unchanged source, honor cancellation and join owned work; never submit input or start a native session. */
  retryImageCapture?(request: ImageCaptureRequest, signal: AbortSignal): Promise<Omit<CaptureStageInput, "captureId" | "attemptId" | "imageId">>;
  close(): Promise<void>;
}
