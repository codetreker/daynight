import type { DirectCaptureSubmission, ImageCaptureRequest, ImagePart, ImageUnavailablePart, InputObservation, NativeImageSource } from "../../../session/image-values.js";
import type { TimelineEntry } from "../../../session/protocol.js";

export type NativePublicationEntry = Extract<TimelineEntry, { kind: "user_message" | "assistant_message" }> & { kind: "user_message" };
export type NativeInputPublicationIdentity = InputObservation & { readonly entryId: string };
export type NativeInputPublicationRequest = {
  readonly identity: NativeInputPublicationIdentity;
  readonly seed: {
    /** Existing committed content takes precedence over this initial native view. */
    readonly entry: Omit<NativePublicationEntry, "revision" | "entrySeq">;
    readonly nativeSlots: readonly { readonly index: number; readonly nativeSource: NativeImageSource; readonly label: string }[];
  };
  /** Original image order from the accepted SessionInput. */
  readonly originals: readonly {
    readonly imageId: string;
    readonly resourceId: string;
    readonly nativeSlotIndex: number;
    readonly appendNativeSource: NativeImageSource;
  }[];
};

/** Durable capture progress is shared by publication and the image projector. */
export type NativeImageProjectionState = {
  request: ImageCaptureRequest;
  attemptId: string;
  index: number;
  waitingForSource: boolean;
  phase: "new" | "preparing" | "submit" | "query" | "settled";
  part: ImagePart | ImageUnavailablePart;
  submission: DirectCaptureSubmission | null;
};
export type CommittedOriginalImageSlot = {
  readonly imageId: string;
  readonly resourceId: string;
  readonly index: number;
};
export type CommittedImageProjectionSlot = {
  readonly key: string;
  readonly label: string;
  readonly original?: { readonly imageId: string; readonly resourceId: string };
  readonly state: NativeImageProjectionState;
};
export type NativeInputPublicationReceipt = {
  readonly identity: NativeInputPublicationIdentity;
  readonly requestSha256: string;
  /** The immutable revision at the first shared commit, not the current view revision. */
  readonly publicationRevision: string;
  readonly sourceSequence: string;
  readonly originalSlots: readonly CommittedOriginalImageSlot[];
};
export type NativeInputPublicationView = {
  /** Current committed content and durable capture progress can differ after a capture-only commit. */
  readonly entry: NativePublicationEntry;
  readonly slots: readonly CommittedImageProjectionSlot[];
};
export type NativeInputPublicationError = {
  readonly code: "publication_conflict" | "publication_unavailable" | "publication_unknown";
  readonly message: string;
};
export type NativeInputPublicationResult =
  | { readonly state: "committed"; readonly receipt: NativeInputPublicationReceipt; readonly view: NativeInputPublicationView }
  | { readonly state: "not_committed"; readonly error: NativeInputPublicationError }
  | { readonly state: "unknown"; readonly error: NativeInputPublicationError };
export type NativeInputPublicationQuery =
  | Extract<NativeInputPublicationResult, { state: "committed" }>
  | { readonly state: "absent" }
  | { readonly state: "unknown"; readonly error: NativeInputPublicationError };
