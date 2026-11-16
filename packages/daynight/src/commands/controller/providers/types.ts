import type { NativeInputPublicationIdentity, NativeInputPublicationRequest, NativeInputPublicationResult, NativeInputPublicationQuery } from "../media/native-publication-types.js";
import type { CaptureStageInput } from "../media/preparations.js";
import type { LocalImageCheckpoint } from "../markdown/local-source-proof.js";
import type { DirectCaptureSubmission, ImagePart, ImageUnavailablePart, ImageCaptureRequest, ImageCaptureReceipt, ImageError, ImageOccurrence, NativeImageSource, InputObservation, ValidatedImage, ProviderImageCapabilities } from "../../../session/image-values.js";
import type { NativeMediaSpool } from "../media/native-spool.js";
import type { SessionCommand, OperationState } from "../../../session/protocol.js";
import type { SessionControls } from "../../../session/controls.js";
import type { ChildProcess } from "node:child_process";
import type { ProcessProof } from "../process-proof.js";
import type { InteractionResponse, SessionCapabilities, SessionSnapshot, TimelineEntry, TextPart } from "../../../session/protocol.js";
/** Private immutable files are supplied only by the Controller's input lease. */
export type NativeImagePart = { readonly type: "image"; readonly imageId: string; readonly resourceId: string; readonly mediaType: string; readonly byteLength: string; readonly sha256: string; readonly localPath: string; readonly validated?: ValidatedImage };
export type NativeInput = { readonly content: readonly (TextPart | NativeImagePart)[] };
export type NativeImageFile = { kind: "file"; path: string; byteLength: string; sha256: string; release(): void };
export type ProviderEntry = TimelineEntry extends infer T ? T extends TimelineEntry ? Omit<T, "entrySeq"> : never : never;
/** Native body lifecycle, supplied by the adapter rather than source text. */
export type MarkdownTimelineMetadata = {
  complete: boolean;
  format: "markdown" | "plain";
  truncated: boolean;
};
/** A native decision admits only the supplied checkpoint, never a later read. */
export type NativeReadPolicy = {
  readonly nativeSessionId: string;
  readonly cwd: string;
  readonly revision: string;
  /** Synchronous connection and authority-generation check; grants no source IO. */
  verify(): void;
  authorizeCheckpoint(checkpoint: LocalImageCheckpoint): Promise<void>;
};
export type ProviderState = { nativeSessionId: string | null; activity: SessionSnapshot["activity"]; currentTurnId: string | null; capabilities: SessionCapabilities; controls?: SessionControls; turnStartedAt?: string | null; images?: Omit<ProviderImageCapabilities, "revision"> };
export type NativeImageRuntime = {
  /** Patch one original image on the current committed entry, preserving late associations. */
  patchNativeImagePart?(occurrence: ImageOccurrence, part: ImagePart | ImageUnavailablePart): TimelineEntry;
  /** Commit and query by the original accepted identity; unknown never authorizes another native send. */
  publishNativeInputAssociation?(request: NativeInputPublicationRequest): NativeInputPublicationResult;
  queryNativeInputAssociation?(identity: NativeInputPublicationIdentity): NativeInputPublicationQuery;
  getIntent(operationId: string): { sha256: string; command: SessionCommand; state: OperationState } | null;
  readState(key: string): unknown;
  writeState(key: string, value: unknown): void;
  createSpool(maximumBytes: number): NativeMediaSpool;
  indexDirectory(): string;
  reserveIndex(additionalBytes: number): void;
  acquireIndexReservation(additionalBytes: number, owner?: ProcessProof): { release(): void };
};
export type ProviderOptions = {
  toolLaunch?: import("../../../platform/tool-executables.js").ResolvedToolLaunch;
  toolRuntimeRoot?: string;
  cwd: string; model: string | null; args: readonly string[]; resumeNativeSessionId: string | null;
  /** Frozen role text for native prompt append on start and resume, separate from user input. */
  instructions?: string;
  unattended?: boolean;
  validateNativeSelection?: true;
  agentCliEnvironment?: Readonly<{ PATH: string; DN_CONFIG_DIR: string }>;
  env?: NodeJS.ProcessEnv; executable?: string; controlsRevisionFloor?: string;
  imageRuntime?: NativeImageRuntime;
  /** Recheck the owning Controller before a new native side effect. */
  assertNativeDispatch?(): void;
  onTimeline(entry: ProviderEntry, metadata?: MarkdownTimelineMetadata): void;
  /** Whether this Session already durably owns a projected timeline identity. */
  hasTimelineEntry?(entryId: string): boolean;
  onState(state: ProviderState): void;
  onSpawn(child: ChildProcess): void;
  /** Helpers report native descendants before dispatch so crash recovery retains their identity. */
  onNativeProcessProof?(proof: ProcessProof): void;
  onDiagnostic?(line: string): void;
  onFatalError?(error: Error): void;
  /** Publish or synchronously invalidate this native instance's source authority. */
  onNativeReadPolicy?(policy: NativeReadPolicy | null): void;
  /** Join source writers after invalidation, before changing native permissions. */
  drainNativeReadPolicy?(): Promise<void>;
  onControlConfirmed?(operationId: string): void;
  /** Associate provenance and return the original durable entry identity for native history replay. */
  onInputMessage?(operationId: string, nativeSessionId: string, entryId: string): string | void;
  /** Only true confirms durable image evidence; legacy text callbacks ignore the result. */
  onInputObserved?(observation: string | InputObservation): unknown;
  /** Registration is durable; capture must wait until the original position is acknowledged. */
  onImageOccurrence?(occurrence: ImageOccurrence, source: NativeImageSource | null): boolean;
  imageOccurrenceAcknowledged?(imageId: string): boolean;
  prepareImageCapture?(request: ImageCaptureRequest): Promise<void>;
  submitImageCapture?(submission: DirectCaptureSubmission): Promise<ImageCaptureReceipt>;
  registerImageCapture?(request: ImageCaptureRequest): Promise<ImageCaptureReceipt>;
  queryImageCapture?(captureId: string): Promise<ImageCaptureReceipt>;
  commitImageCapture?(captureId: string, attemptId: string, validated: ValidatedImage): Promise<ImageCaptureReceipt>;
  failImageCapture?(captureId: string, attemptId: string, error: ImageError): Promise<ImageCaptureReceipt>;
  stageImageCapture?(input: CaptureStageInput): Promise<ValidatedImage>;
  /** The source owner opens only an acknowledged, registered capture and joins cancellation. */
  resolveImageCaptureSource?(request: ImageCaptureRequest, signal: AbortSignal): Promise<NativeImageFile>;
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
  acknowledgeImageOccurrences?(): void;
  waitForTurn(turnId: string, deadline: number): Promise<void>;
  /** Resolve the unchanged source, honor cancellation and join owned work; never submit input or start a native session. */
  retryImageCapture?(request: ImageCaptureRequest, signal: AbortSignal): Promise<Omit<CaptureStageInput, "captureId" | "attemptId" | "imageId"> & { release?(): void }>;
  close(): Promise<void>;
}
