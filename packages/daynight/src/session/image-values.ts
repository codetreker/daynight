import type {
  SessionCommand,
  SessionFence,
  SessionProvider,
  TextPart,
  SessionResource,
  TimelineEntry,
} from "./protocol.js";

export const SESSION_CONTENT_REVISION = 2 as const;
export const IMAGE_LIMITS = Object.freeze({
  imageBytes: 10_485_760,
  messageBytes: 20_971_520,
  images: 8,
  sessionBytes: 1_073_741_824,
  resources: 1000,
  chunkBytes: 524_288,
  entries: 100_000,
  manifestBytes: 4_194_304,
  uploadHours: 24,
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxPixels: 33_554_432,
  maxFrames: 256,
  totalPixels: 67_108_864,
  rgbaBytes: 268_435_456,
  decodeMilliseconds: 15_000,
});
export type InputMime = "image/png" | "image/jpeg" | "image/webp";
export type DisplayMime = InputMime | "image/gif" | "image/avif";
export type ImageError = { readonly code: string; readonly message: string };
export type ImageTarget = {
  readonly serverOrigin: string;
  readonly actorUserId: string;
  readonly fence: SessionFence;
  readonly expectedNativeSessionId: string | null;
};
export type ImageGeometry = {
  readonly version: 1;
  readonly known: boolean;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
  readonly maxFrames: number;
};
export type ProviderImageCapabilities = {
  readonly revision: string;
  readonly expectedNativeSessionId: string | null;
  readonly modelId: string | null;
  readonly controlsRevision: string | null;
  readonly send: "supported" | "unsupported" | "unknown";
  readonly steer: "supported" | "unsupported" | "unknown";
  readonly reasonCode: string | null;
  readonly inputMediaTypes: readonly InputMime[];
  readonly maxImageBytes: string;
  readonly maxMessageImageBytes: string;
  readonly maxImagesPerMessage: number;
  readonly geometry: ImageGeometry;
};
export type ImageCapabilities = ProviderImageCapabilities & {
  readonly providerRevision: string;
};
export type ImageBudget = {
  readonly revision: string;
  readonly maxBytes: string;
  readonly committedBytes: string;
  readonly reservedBytes: string;
  readonly maxResources: number;
  readonly committedResources: number;
  readonly reservedResources: number;
};
export type ValidatedImage = {
  readonly mediaType: DisplayMime;
  readonly byteLength: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
};
export type ImagePart = {
  readonly type: "image";
  readonly imageId: string;
  readonly resourceId: string;
  readonly label: string;
};
export type ImageUnavailablePart = {
  readonly type: "image_unavailable";
  readonly imageId: string;
  readonly label: string;
  readonly error: ImageError;
};
export type ImageInputPart = {
  readonly type: "image";
  readonly imageId: string;
  readonly uploadId: string;
  readonly resourceId: string;
  readonly sha256: string;
  readonly byteLength: string;
};
export type SessionInput = {
  readonly origin?: import("./protocol.js").MessageOrigin;
  readonly content: readonly (TextPart | ImageInputPart)[];
  readonly expectedTurnId: string | null;
  readonly target?: ImageTarget;
  readonly expectedImageCapabilityRevision?: string;
  readonly draftId?: string;
  readonly draftRevision?: string;
};
export type ImageUploadSpec = {
  readonly uploadId: string;
  readonly imageId: string;
  readonly target: ImageTarget;
  readonly name: string;
  readonly mediaType: InputMime;
  readonly byteLength: string;
  readonly sha256: string;
};
export type DirectImageContent = {
  readonly spec: ImageUploadSpec;
  readonly offset: "0";
  readonly sha256: string;
  readonly data: string;
};
export type ImageUploadReceipt = {
  readonly uploadId: string;
  readonly imageId: string;
  readonly target: ImageTarget;
  readonly state:
    "receiving" | "verifying" | "complete" | "failed" | "expired" | "released";
  readonly acceptedOffset: string;
  readonly spec: Pick<
    ImageUploadSpec,
    "name" | "mediaType" | "byteLength" | "sha256"
  >;
  readonly resource: SessionResource | null;
  readonly expiresAt: string;
  readonly error: ImageError | null;
};
export type LocalImagePreparation = {
  readonly uploadId: string;
  readonly imageId: string;
  readonly target: ImageTarget;
  readonly state: "receiving" | "validated" | "failed" | "expired" | "released";
  readonly acceptedOffset: string;
  readonly validated: ValidatedImage | null;
  readonly error: ImageError | null;
};
export type ImageReadRequest = {
  readonly resourceId: string;
  readonly offset: string;
  readonly limit: number;
};
export type ImageReadChunk = {
  readonly resourceId: string;
  readonly sha256: string;
  readonly byteLength: string;
  readonly offset: string;
  readonly data: string;
  readonly eof: boolean;
};
export type PreparedImageChunk = Omit<ImageReadChunk, "resourceId"> & {
  readonly preparationId: string;
};
export type ImageOccurrence = {
  readonly imageId: string;
  readonly entryId: string;
  readonly container: "content" | "tool_output" | "reasoning";
  readonly partId: string | null;
  readonly sourceRevision: string | null;
  readonly sourceTextSha256: string | null;
  readonly callId: string | null;
  readonly sourceKey: string;
};
export type NativeImageSource = {
  readonly provider: SessionProvider;
  readonly nativeSessionId: string;
  readonly nativeMessageId: string;
  readonly nativePartId: string;
};
export type ImageLocator =
  | { readonly kind: "resource"; readonly resourceId: string }
  | ({ readonly kind: "native" } & NativeImageSource)
  | {
      readonly kind: "local";
      readonly path: string;
      readonly contextId: string;
    }
  | { readonly kind: "external"; readonly url: string };
export type ImageCaptureRequest = {
  readonly captureId: string;
  readonly attemptId: string;
  readonly occurrence: ImageOccurrence;
  readonly locator: ImageLocator;
  readonly nativeSource: NativeImageSource | null;
};
export type DirectCaptureSubmission = {
  readonly request: ImageCaptureRequest;
  readonly attemptId: string;
  readonly outcome:
    | { readonly kind: "validated"; readonly validated: ValidatedImage }
    | { readonly kind: "resource" }
    | { readonly kind: "failed"; readonly error: ImageError };
};
export type ImageCaptureReceipt = {
  readonly captureId: string;
  readonly attemptId: string;
  readonly revision: string;
  readonly occurrence: ImageOccurrence;
  readonly state: "reserved" | "copying" | "committed" | "failed";
  readonly resourceId: string | null;
  readonly resource: SessionResource | null;
  readonly error: ImageError | null;
};
export type ImageOccurrenceStatus = {
  readonly imageId: string;
  readonly revision: string;
  readonly state: "unregistered" | "pending" | "unknown" | "failed" | "committed" | "unavailable";
  readonly resourceId: string | null;
  readonly action: "none" | "observe" | "retry_source" | "read_saved";
  readonly error: ImageError | null;
};
export type InputObservation = {
  readonly operationId: string;
  readonly nativeSessionId: string;
  readonly intentSha256: string;
  readonly nativeMessageId: string;
  readonly provider: SessionProvider;
};
export type NativeInputObservation = InputObservation;
export type MarkdownImageBinding = {
  readonly imageId: string;
  readonly start: number;
  readonly end: number;
  readonly part: ImagePart | ImageUnavailablePart;
};
export type RetainedMarkdownImage = MarkdownImageBinding & {
  readonly sourceRevision: string;
  readonly sourceTextSha256: string;
  readonly linkHref: string | null;
};
export type MarkdownImageMetadata = {
  readonly partId: string;
  readonly revision: string;
  readonly textSha256: string;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly bindings: readonly MarkdownImageBinding[] | null;
  readonly retainedImages: readonly RetainedMarkdownImage[];
};
export type MarkdownImagePart = MarkdownImageMetadata & {
  readonly type: "markdown";
  readonly text: string;
};

const fail = (): never => {
  throw new Error("Invalid Daynight image protocol value.");
};
export const imageObject = (
  v: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const o = v as Record<string, unknown>;
  return Object.keys(o).length === keys.length &&
    keys.every((k) => Object.hasOwn(o, k))
    ? o
    : fail();
};
export const imageId = (v: unknown): string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
    ? v
    : fail();
export const imageDecimal = (v: unknown, zero = false): string =>
  typeof v === "string" &&
  /^(0|[1-9][0-9]{0,18})$/.test(v) &&
  (zero || v !== "0") &&
  BigInt(v) <= 9223372036854775807n
    ? v
    : fail();
export const imageText = (v: unknown, limit = 1024, empty = false): string =>
  typeof v === "string" &&
  v.isWellFormed() &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(v) &&
  (empty || /[^\p{White_Space}]/u.test(v)) &&
  new TextEncoder().encode(v).length <= limit
    ? v
    : fail();
export const imageSha = (v: unknown): string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : fail();
export const imageInteger = (v: unknown, max: number, zero = false): number =>
  typeof v === "number" &&
  Number.isSafeInteger(v) &&
  v >= (zero ? 0 : 1) &&
  v <= max
    ? v
    : fail();
const choice = <T extends string>(v: unknown, a: readonly T[]): T =>
  typeof v === "string" && a.includes(v as T) ? (v as T) : fail();
const nullable = <T>(v: unknown, p: (v: unknown) => T): T | null =>
  v === null ? null : p(v);
export const parseImageError = (v: unknown): ImageError => {
  const o = imageObject(v, ["code", "message"]);
  return { code: choiceCode(o.code), message: imageText(o.message, 256) };
};
const choiceCode = (v: unknown): string =>
  typeof v === "string" && /^[a-z_]{1,64}$/.test(v) ? v : fail();
const parseFence = (v: unknown): SessionFence => {
  const b =
    v && typeof v === "object" && Object.hasOwn(v, "testExecutionId")
      ? "testExecutionId"
      : "claimId";
  const o = imageObject(v, ["sessionId", b, "executionGeneration"]);
  return {
    sessionId: imageId(o.sessionId),
    executionGeneration: imageDecimal(o.executionGeneration),
    ...(b === "claimId"
      ? { claimId: imageId(o.claimId) }
      : { testExecutionId: imageId(o.testExecutionId) }),
  };
};
export const parseImageTarget = (v: unknown): ImageTarget => {
  const o = imageObject(v, [
    "serverOrigin",
    "actorUserId",
    "fence",
    "expectedNativeSessionId",
  ]);
  const origin = imageText(o.serverOrigin, 2048);
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return fail();
  }
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.origin !== origin ||
    u.username ||
    u.password
  )
    return fail();
  return {
    serverOrigin: origin,
    actorUserId: imageId(o.actorUserId),
    fence: parseFence(o.fence),
    expectedNativeSessionId: nullable(o.expectedNativeSessionId, (v) =>
      imageText(v, 256),
    ),
  };
};
export const parseValidatedImage = (v: unknown): ValidatedImage => {
  const o = imageObject(v, [
    "mediaType",
    "byteLength",
    "sha256",
    "width",
    "height",
    "frameCount",
  ]);
  const byteLength = imageDecimal(o.byteLength);
  if (BigInt(byteLength) > BigInt(IMAGE_LIMITS.imageBytes)) return fail();
  const width = imageInteger(o.width, IMAGE_LIMITS.maxWidth),
    height = imageInteger(o.height, IMAGE_LIMITS.maxHeight),
    frameCount = imageInteger(o.frameCount, IMAGE_LIMITS.maxFrames);
  if (
    width * height > IMAGE_LIMITS.maxPixels ||
    width * height * frameCount > IMAGE_LIMITS.totalPixels
  )
    return fail();
  return {
    mediaType: choice(o.mediaType, [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/avif",
    ]),
    byteLength,
    sha256: imageSha(o.sha256),
    width,
    height,
    frameCount,
  };
};
export const parseImageUploadSpec = (v: unknown): ImageUploadSpec => {
  const o = imageObject(v, [
    "uploadId",
    "imageId",
    "target",
    "name",
    "mediaType",
    "byteLength",
    "sha256",
  ]);
  const byteLength = imageDecimal(o.byteLength);
  if (BigInt(byteLength) > BigInt(IMAGE_LIMITS.imageBytes)) return fail();
  return {
    uploadId: imageId(o.uploadId),
    imageId: imageId(o.imageId),
    target: parseImageTarget(o.target),
    name: imageText(o.name),
    mediaType: choice(o.mediaType, ["image/png", "image/jpeg", "image/webp"]),
    byteLength,
    sha256: imageSha(o.sha256),
  };
};
export const parseDirectImageContent = (v: unknown): DirectImageContent => {
  const o = imageObject(v, ["spec", "offset", "sha256", "data"]);
  const spec = parseImageUploadSpec(o.spec);
  if (
    o.offset !== "0" || typeof o.data !== "string" || o.data.length === 0 ||
    o.data.length > 699052 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(o.data)
  ) return fail();
  const raw = atob(o.data);
  if (raw.length === 0 || raw.length > IMAGE_LIMITS.chunkBytes ||
      BigInt(raw.length) > BigInt(spec.byteLength) || btoa(raw) !== o.data) return fail();
  return { spec, offset: "0", sha256: imageSha(o.sha256), data: o.data };
};
export const parseImageInputPart = (v: unknown): ImageInputPart => {
  const o = imageObject(v, [
    "type",
    "imageId",
    "uploadId",
    "resourceId",
    "sha256",
    "byteLength",
  ]);
  if (o.type !== "image") return fail();
  const byteLength = imageDecimal(o.byteLength);
  if (BigInt(byteLength) > BigInt(IMAGE_LIMITS.imageBytes)) return fail();
  return {
    type: "image",
    imageId: imageId(o.imageId),
    uploadId: imageId(o.uploadId),
    resourceId: imageId(o.resourceId),
    sha256: imageSha(o.sha256),
    byteLength,
  };
};
export const parseSessionInput = (
  v: unknown,
  parseText: (v: unknown) => TextPart,
): SessionInput => {
  if (!v || typeof v !== "object") return fail();
  const raw = v as Record<string, unknown>;
  if (
    !Array.isArray(raw.content) ||
    raw.content.length === 0 ||
    raw.content.length > 1000
  )
    return fail();
  const hasImages = raw.content.some(
    (p) => p && typeof p === "object" && p.type === "image",
  );
  const o = imageObject(
    v,
    [
      ...(Object.hasOwn(raw, "origin") ? ["origin"] : []),
      ...(hasImages
      ? [
          "content",
          "expectedTurnId",
          "target",
          "expectedImageCapabilityRevision",
          "draftId",
          "draftRevision",
        ]
      : ["content", "expectedTurnId"]),
    ],
  );
  const content = raw.content.map((p: unknown) =>
    p && typeof p === "object" && "type" in p && p.type === "image"
      ? parseImageInputPart(p)
      : parseText(p),
  );
  const expectedTurnId = nullable(o.expectedTurnId, (v) => imageText(v, 256));
  const origin = Object.hasOwn(o, "origin") ? { origin: choice(o.origin, ["user", "daynight"] as const) } : {};
  if (!hasImages) return { content, expectedTurnId, ...origin };
  let total = 0n;
  const images = content.filter((p): p is ImageInputPart => p.type === "image");
  if (
    images.length > IMAGE_LIMITS.images ||
    new Set(images.map((p) => p.imageId)).size !== images.length ||
    new Set(images.map((p) => p.uploadId)).size !== images.length
  )
    return fail();
  let seen = false;
  for (const p of content) {
    if (p.type === "image") {
      seen = true;
      total += BigInt(p.byteLength);
    } else if (seen || content.indexOf(p) !== 0) return fail();
  }
  if (total > BigInt(IMAGE_LIMITS.messageBytes)) return fail();
  return {
    content,
    expectedTurnId,
    ...origin,
    target: parseImageTarget(o.target),
    expectedImageCapabilityRevision: imageDecimal(
      o.expectedImageCapabilityRevision,
    ),
    draftId: imageId(o.draftId),
    draftRevision: imageDecimal(o.draftRevision),
  };
};
export const parseImageOccurrence = (v: unknown): ImageOccurrence => {
  const o = imageObject(v, [
    "imageId",
    "entryId",
    "container",
    "partId",
    "sourceRevision",
    "sourceTextSha256",
    "callId",
    "sourceKey",
  ]);
  const container = choice(o.container, [
    "content",
    "tool_output",
    "reasoning",
  ]);
  const partId = nullable(o.partId, imageId),
    sourceRevision = nullable(o.sourceRevision, (v) => imageDecimal(v)),
    sourceTextSha256 = nullable(o.sourceTextSha256, imageSha),
    callId = nullable(o.callId, (v) => imageText(v, 256));
  if (
    (container === "tool_output") !== (callId !== null) ||
    [partId, sourceRevision, sourceTextSha256].filter((x) => x !== null)
      .length %
      3 !==
      0 ||
    (container === "reasoning" && partId === null)
  )
    return fail();
  return {
    imageId: imageId(o.imageId),
    entryId: imageId(o.entryId),
    container,
    partId,
    sourceRevision,
    sourceTextSha256,
    callId,
    sourceKey: imageText(o.sourceKey),
  };
};
export const parseNativeImageSource = (v: unknown): NativeImageSource => {
  const o = imageObject(v, [
    "provider",
    "nativeSessionId",
    "nativeMessageId",
    "nativePartId",
  ]);
  return {
    provider: choice(o.provider, ["codex", "claude", "copilot"]),
    nativeSessionId: imageText(o.nativeSessionId, 256),
    nativeMessageId: imageText(o.nativeMessageId),
    nativePartId: imageText(o.nativePartId),
  };
};
export const parseImageLocator = (v: unknown): ImageLocator => {
  if (!v || typeof v !== "object" || !("kind" in v)) return fail();
  if (v.kind === "resource") {
    const o = imageObject(v, ["kind", "resourceId"]);
    return { kind: "resource", resourceId: imageId(o.resourceId) };
  }
  if (v.kind === "native") {
    const { kind, ...o } = imageObject(v, [
      "kind",
      "provider",
      "nativeSessionId",
      "nativeMessageId",
      "nativePartId",
    ]);
    return { kind: "native", ...parseNativeImageSource(o) };
  }
  if (v.kind === "local") {
    const o = imageObject(v, ["kind", "path", "contextId"]);
    if (
      typeof o.path !== "string" ||
      !o.path.isWellFormed() ||
      o.path.includes("\0") ||
      new TextEncoder().encode(o.path).length > 8192 ||
      !o.path
    )
      return fail();
    return { kind: "local", path: o.path, contextId: imageId(o.contextId) };
  }
  const o = imageObject(v, ["kind", "url"]);
  if (o.kind !== "external") return fail();
  const url = imageText(o.url, 8192);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fail();
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    return fail();
  return { kind: "external", url };
};
export const parseImageCaptureRequest = (v: unknown): ImageCaptureRequest => {
  const o = imageObject(v, [
    "captureId",
    "attemptId",
    "occurrence",
    "locator",
    "nativeSource",
  ]);
  return {
    captureId: imageId(o.captureId),
    attemptId: imageId(o.attemptId),
    occurrence: parseImageOccurrence(o.occurrence),
    locator: parseImageLocator(o.locator),
    nativeSource: nullable(o.nativeSource, parseNativeImageSource),
  };
};
export const parseDirectCaptureSubmission = (v: unknown): DirectCaptureSubmission => {
  const o = imageObject(v, ["request", "attemptId", "outcome"]);
  const request = parseImageCaptureRequest(o.request), attemptId = imageId(o.attemptId);
  if (!o.outcome || typeof o.outcome !== "object" || Array.isArray(o.outcome)) return fail();
  const kind = (o.outcome as Record<string, unknown>).kind;
  let outcome: DirectCaptureSubmission["outcome"];
  if (kind === "validated") {
    const value = imageObject(o.outcome, ["kind", "validated"]);
    outcome = { kind, validated: parseValidatedImage(value.validated) };
  } else if (kind === "resource") {
    imageObject(o.outcome, ["kind"]);
    outcome = { kind };
  } else if (kind === "failed") {
    const value = imageObject(o.outcome, ["kind", "error"]);
    outcome = { kind, error: parseImageError(value.error) };
  } else return fail();
  return { request, attemptId, outcome };
};
export const parseInputObservation = (v: unknown): InputObservation => {
  const o = imageObject(v, [
    "operationId",
    "nativeSessionId",
    "intentSha256",
    "nativeMessageId",
    "provider",
  ]);
  return {
    operationId: imageId(o.operationId),
    nativeSessionId: imageText(o.nativeSessionId, 256),
    intentSha256: imageSha(o.intentSha256),
    nativeMessageId: imageText(o.nativeMessageId),
    provider: choice(o.provider, ["codex", "claude", "copilot"]),
  };
};
export const parseImageReadRequest = (v: unknown): ImageReadRequest => {
  const o = imageObject(v, ["resourceId", "offset", "limit"]);
  return {
    resourceId: imageId(o.resourceId),
    offset: imageDecimal(o.offset, true),
    limit: imageInteger(o.limit, IMAGE_LIMITS.chunkBytes),
  };
};
export const parseImageReadChunk = (v: unknown): ImageReadChunk => {
  const o = imageObject(v, [
    "resourceId",
    "sha256",
    "byteLength",
    "offset",
    "data",
    "eof",
  ]);
  const byteLength = imageDecimal(o.byteLength, true),
    offset = imageDecimal(o.offset, true);
  if (
    typeof o.data !== "string" ||
    o.data.length > 699052 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      o.data,
    ) ||
    typeof o.eof !== "boolean"
  )
    return fail();
  const raw = atob(o.data);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (
    btoa(raw) !== o.data ||
    bytes.length > IMAGE_LIMITS.chunkBytes ||
    BigInt(offset) + BigInt(bytes.length) > BigInt(byteLength) ||
    o.eof !== (BigInt(offset) + BigInt(bytes.length) === BigInt(byteLength)) ||
    (bytes.length === 0 && (!o.eof || offset !== byteLength))
  )
    return fail();
  return {
    resourceId: imageId(o.resourceId),
    sha256: imageSha(o.sha256),
    byteLength,
    offset,
    data: o.data,
    eof: o.eof,
  };
};
export const parseProviderImageCapabilities = (
  v: unknown,
): ProviderImageCapabilities => {
  const o = imageObject(v, [
    "revision",
    "expectedNativeSessionId",
    "modelId",
    "controlsRevision",
    "send",
    "steer",
    "reasonCode",
    "inputMediaTypes",
    "maxImageBytes",
    "maxMessageImageBytes",
    "maxImagesPerMessage",
    "geometry",
  ]);
  const g = imageObject(o.geometry, [
    "version",
    "known",
    "maxWidth",
    "maxHeight",
    "maxPixels",
    "maxFrames",
  ]);
  if (g.version !== 1 || typeof g.known !== "boolean") return fail();
  const geometry: ImageGeometry = {
    version: 1,
    known: g.known,
    maxWidth: imageInteger(g.maxWidth, IMAGE_LIMITS.maxWidth, true),
    maxHeight: imageInteger(g.maxHeight, IMAGE_LIMITS.maxHeight, true),
    maxPixels: imageInteger(g.maxPixels, IMAGE_LIMITS.maxPixels, true),
    maxFrames: imageInteger(g.maxFrames, IMAGE_LIMITS.maxFrames, true),
  };
  if (
    geometry.known
      ? [
          geometry.maxWidth,
          geometry.maxHeight,
          geometry.maxPixels,
          geometry.maxFrames,
        ].some((n) => n === 0)
      : [
          geometry.maxWidth,
          geometry.maxHeight,
          geometry.maxPixels,
          geometry.maxFrames,
        ].some((n) => n !== 0)
  )
    return fail();
  const send = choice(o.send, ["supported", "unsupported", "unknown"]),
    steer = choice(o.steer, ["supported", "unsupported", "unknown"]);
  const maxImageBytes = imageDecimal(o.maxImageBytes, true),
    maxMessageImageBytes = imageDecimal(o.maxMessageImageBytes, true),
    maxImagesPerMessage = imageInteger(
      o.maxImagesPerMessage,
      IMAGE_LIMITS.images,
      true,
    );
  if (
    BigInt(maxImageBytes) > BigInt(IMAGE_LIMITS.imageBytes) ||
    BigInt(maxMessageImageBytes) > BigInt(IMAGE_LIMITS.messageBytes) ||
    !Array.isArray(o.inputMediaTypes)
  )
    return fail();
  const inputMediaTypes = o.inputMediaTypes.map((m) =>
    choice<InputMime>(m, ["image/png", "image/jpeg", "image/webp"]),
  );
  if (new Set(inputMediaTypes).size !== inputMediaTypes.length) return fail();
  const modelId = nullable(o.modelId, (v) => imageText(v, 256)),
    reasonCode = nullable(o.reasonCode, choiceCode);
  if (
    ((send === "supported" || steer === "supported") &&
      (!modelId ||
        !geometry.known ||
        !inputMediaTypes.length ||
        maxImageBytes === "0" ||
        maxMessageImageBytes === "0" ||
        !maxImagesPerMessage)) ||
    (send !== "supported" && steer !== "supported" && reasonCode === null)
  )
    return fail();
  return {
    revision: imageDecimal(o.revision),
    expectedNativeSessionId: nullable(o.expectedNativeSessionId, (v) =>
      imageText(v, 256),
    ),
    modelId,
    controlsRevision: nullable(o.controlsRevision, (v) => imageDecimal(v)),
    send,
    steer,
    reasonCode,
    inputMediaTypes,
    maxImageBytes,
    maxMessageImageBytes,
    maxImagesPerMessage,
    geometry,
  };
};
export const parseImageCapabilities = (v: unknown): ImageCapabilities => {
  if (!v || typeof v !== "object") return fail();
  const { providerRevision, ...rest } = v as Record<string, unknown>;
  return {
    ...parseProviderImageCapabilities(rest),
    providerRevision: imageDecimal(providerRevision),
  };
};
export const parseImageBudget = (v: unknown): ImageBudget => {
  const o = imageObject(v, [
    "revision",
    "maxBytes",
    "committedBytes",
    "reservedBytes",
    "maxResources",
    "committedResources",
    "reservedResources",
  ]);
  const maxBytes = imageDecimal(o.maxBytes, true),
    committedBytes = imageDecimal(o.committedBytes, true),
    reservedBytes = imageDecimal(o.reservedBytes, true),
    maxResources = imageInteger(o.maxResources, IMAGE_LIMITS.resources, true),
    committedResources = imageInteger(
      o.committedResources,
      IMAGE_LIMITS.resources,
      true,
    ),
    reservedResources = imageInteger(
      o.reservedResources,
      IMAGE_LIMITS.resources,
      true,
    );
  if (
    BigInt(maxBytes) > BigInt(IMAGE_LIMITS.sessionBytes) ||
    BigInt(committedBytes) + BigInt(reservedBytes) > BigInt(maxBytes) ||
    committedResources + reservedResources > maxResources
  )
    return fail();
  return {
    revision: imageDecimal(o.revision),
    maxBytes,
    committedBytes,
    reservedBytes,
    maxResources,
    committedResources,
    reservedResources,
  };
};
/** Canonical new operation bytes retain array order and explicit nulls. Old operation hashes are never recomputed. */
export const canonicalSessionIntent = (command: SessionCommand): string => {
  const { requestId, ...intent } = command;
  if (intent.kind === "send_message" && intent.payload.origin === "user") {
    const { origin: _origin, ...payload } = intent.payload;
    return canonicalImageJson({ ...intent, payload });
  }
  return canonicalImageJson(intent);
};
export const canonicalImageJson = (v: unknown): string => {
  if (v === null) return "null";
  if (typeof v === "string") {
    if (!v.isWellFormed()) return fail();
    let result = '"';
    for (const c of v) {
      if (c.charCodeAt(0) < 32)
        result += "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
      else if (c === '"' || c === "\\") result += "\\" + c;
      else result += c;
    }
    return result + '"';
  }
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number")
    return Number.isSafeInteger(v) ? String(v) : fail();
  if (Array.isArray(v)) return `[${v.map(canonicalImageJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${canonicalImageJson(k)}:${canonicalImageJson((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return fail();
};

export const parseImagePart = (
  v: unknown,
): ImagePart | ImageUnavailablePart => {
  if (!v || typeof v !== "object" || !("type" in v)) return fail();
  if (v.type === "image") {
    const o = imageObject(v, ["type", "imageId", "resourceId", "label"]);
    return {
      type: "image",
      imageId: imageId(o.imageId),
      resourceId: imageId(o.resourceId),
      label: imageText(o.label),
    };
  }
  const o = imageObject(v, ["type", "imageId", "label", "error"]);
  if (o.type !== "image_unavailable") return fail();
  return {
    type: "image_unavailable",
    imageId: imageId(o.imageId),
    label: imageText(o.label),
    error: parseImageError(o.error),
  };
};
export const parseMarkdownImageMetadata = (
  v: unknown,
  text: string,
  allowUnknown = false,
): MarkdownImageMetadata => {
  const o = imageObject(v, [
    "partId",
    "revision",
    "textSha256",
    "complete",
    "truncated",
    "bindings",
    "retainedImages",
  ]);
  if (
    typeof o.complete !== "boolean" ||
    typeof o.truncated !== "boolean" ||
    !Array.isArray(o.retainedImages) ||
    o.retainedImages.length > 1000
  )
    return fail();
  const binding = (v: unknown, max: number): MarkdownImageBinding => {
    const b = imageObject(v, ["imageId", "start", "end", "part"]);
    const start = imageInteger(b.start, max, true),
      end = imageInteger(b.end, max, true),
      id = imageId(b.imageId),
      part = parseImagePart(b.part);
    if (start >= end || part.imageId !== id) return fail();
    return { imageId: id, start, end, part };
  };
  let bindings: MarkdownImageBinding[] | null = null;
  if (o.bindings === null) {
    if (!allowUnknown) return fail();
  } else {
    if (!Array.isArray(o.bindings) || o.bindings.length > 1000) return fail();
    bindings = o.bindings.map((b) => binding(b, text.length));
    let end = 0;
    for (const b of bindings) {
      if (b.start < end) return fail();
      for (const offset of [b.start, b.end]) {
        if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)) return fail();
      }
      end = b.end;
    }
  }
  const retainedImages = o.retainedImages.map((v) => {
    const b = imageObject(v, [
      "imageId",
      "start",
      "end",
      "part",
      "sourceRevision",
      "sourceTextSha256",
      "linkHref",
    ]);
    const { sourceRevision, sourceTextSha256, linkHref, ...rest } = b;
    const retained = binding(rest, Number.MAX_SAFE_INTEGER);
    const href = nullable(linkHref, (v) => imageText(v, 8192));
    if (href !== null) {
      let u: URL;
      try {
        u = new URL(href, "https://daynight.invalid");
      } catch {
        return fail();
      }
      if (
        !["http:", "https:", "mailto:"].includes(u.protocol) ||
        u.username ||
        u.password
      )
        return fail();
    }
    return {
      ...retained,
      sourceRevision: imageDecimal(sourceRevision),
      sourceTextSha256: imageSha(sourceTextSha256),
      linkHref: href,
    };
  });
  const ids = [...(bindings ?? []), ...retainedImages].map((b) => b.imageId);
  if (new Set(ids).size !== ids.length) return fail();
  if (!o.complete && bindings?.length) return fail();
  if (text === "" && o.textSha256 !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") return fail();
  return {
    partId: imageId(o.partId),
    revision: imageDecimal(o.revision),
    textSha256: imageSha(o.textSha256),
    complete: o.complete,
    truncated: o.truncated,
    bindings,
    retainedImages,
  };
};
export const parseMarkdownImagePart = (v: unknown): MarkdownImagePart => {
  const o = imageObject(v, [
    "type",
    "text",
    "partId",
    "revision",
    "textSha256",
    "complete",
    "truncated",
    "bindings",
    "retainedImages",
  ]);
  if (
    o.type !== "markdown" ||
    typeof o.text !== "string" ||
    !o.text.isWellFormed() ||
    o.text.includes("\0") ||
    new TextEncoder().encode(o.text).length > 1_048_576
  )
    return fail();
  const { type, text, ...meta } = o;
  return {
    type: "markdown",
    text: o.text,
    ...parseMarkdownImageMetadata(meta, o.text),
  };
};

/** Verify the exact UTF-8 body before consuming persisted Markdown bindings. */
export const verifyTimelineImageMetadata = async (entry: TimelineEntry): Promise<void> => {
  const check = async (metadata: MarkdownImageMetadata, text: string): Promise<void> => {
    const bytes = new TextEncoder().encode(text);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    if (digest !== metadata.textSha256) return fail();
  };
  if (entry.kind === "reasoning" && entry.markdown) await check(entry.markdown, entry.text);
  if (entry.kind === "user_message" || entry.kind === "assistant_message" || entry.kind === "tool_call") {
    const parts = entry.kind === "tool_call" ? entry.output : entry.content;
    for (const part of parts) if (part.type === "markdown") await check(part, part.text);
  }
};

export const parseLocalImagePreparation = (
  v: unknown,
): LocalImagePreparation => {
  const o = imageObject(v, [
    "uploadId",
    "imageId",
    "target",
    "state",
    "acceptedOffset",
    "validated",
    "error",
  ]);
  const state = choice(o.state, [
      "receiving",
      "validated",
      "failed",
      "expired",
      "released",
    ]),
    acceptedOffset = imageDecimal(o.acceptedOffset, true),
    validated = nullable(o.validated, parseValidatedImage),
    error = nullable(o.error, parseImageError);
  if (
    BigInt(acceptedOffset) > BigInt(IMAGE_LIMITS.imageBytes) ||
    (state === "validated") !== (validated !== null) ||
    (state === "failed" || state === "expired") !== (error !== null) ||
    (validated !== null && acceptedOffset !== validated.byteLength)
  )
    return fail();
  return {
    uploadId: imageId(o.uploadId),
    imageId: imageId(o.imageId),
    target: parseImageTarget(o.target),
    state,
    acceptedOffset,
    validated,
    error,
  };
};
export const parsePreparedImageChunk = (v: unknown): PreparedImageChunk => {
  const o = imageObject(v, [
    "preparationId",
    "sha256",
    "byteLength",
    "offset",
    "data",
    "eof",
  ]);
  imageDecimal(o.byteLength);
  const { preparationId, ...rest } = o;
  const { resourceId, ...chunk } = parseImageReadChunk({
    ...rest,
    resourceId: imageId(preparationId),
  });
  return { preparationId: resourceId, ...chunk };
};

/** Resource parsing is injected to keep the value layer independent of timeline parsing. */
export const parseImageUploadReceipt = (
  v: unknown,
  resource: (v: unknown) => SessionResource,
): ImageUploadReceipt => {
  const o = imageObject(v, [
    "uploadId",
    "imageId",
    "target",
    "state",
    "acceptedOffset",
    "spec",
    "resource",
    "expiresAt",
    "error",
  ]);
  const metadata = imageObject(o.spec, [
    "name",
    "mediaType",
    "byteLength",
    "sha256",
  ]);
  const spec = {
    name: imageText(metadata.name),
    mediaType: choice<InputMime>(metadata.mediaType, [
      "image/png",
      "image/jpeg",
      "image/webp",
    ]),
    byteLength: imageDecimal(metadata.byteLength),
    sha256: imageSha(metadata.sha256),
  };
  if (BigInt(spec.byteLength) > BigInt(IMAGE_LIMITS.imageBytes)) return fail();
  const state = choice(o.state, [
      "receiving",
      "verifying",
      "complete",
      "failed",
      "expired",
      "released",
    ]),
    acceptedOffset = imageDecimal(o.acceptedOffset, true),
    saved = nullable(o.resource, resource),
    error = nullable(o.error, parseImageError);
  const expiresAt = imageText(o.expiresAt, 64);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    BigInt(acceptedOffset) > BigInt(spec.byteLength)
  )
    return fail();
  if (
    (state === "complete") !== (saved !== null) ||
    (state === "failed" || state === "expired") !== (error !== null) ||
    ((state === "verifying" || state === "complete") &&
      acceptedOffset !== spec.byteLength)
  )
    return fail();
  if (
    saved &&
    (saved.status !== "available" ||
      saved.byteLength !== spec.byteLength ||
      saved.sha256 !== spec.sha256 ||
      saved.mediaType !== spec.mediaType ||
      !saved.width ||
      !saved.height ||
      !saved.frameCount)
  )
    return fail();
  return {
    uploadId: imageId(o.uploadId),
    imageId: imageId(o.imageId),
    target: parseImageTarget(o.target),
    state,
    acceptedOffset,
    spec,
    resource: saved,
    expiresAt,
    error,
  };
};
export const parseImageCaptureReceipt = (
  v: unknown,
  resource: (v: unknown) => SessionResource,
): ImageCaptureReceipt => {
  const o = imageObject(v, [
    "captureId",
    "attemptId",
    "revision",
    "occurrence",
    "state",
    "resourceId",
    "resource",
    "error",
  ]);
  const state = choice(o.state, ["reserved", "copying", "committed", "failed"]),
    resourceId = nullable(o.resourceId, imageId),
    saved = nullable(o.resource, resource),
    error = nullable(o.error, parseImageError);
  if (
    (state === "committed") !== (saved !== null) ||
    (state === "failed") !== (error !== null) ||
    (state !== "failed" && resourceId === null) ||
    (saved && (saved.status !== "available" || saved.resourceId !== resourceId))
  )
    return fail();
  return {
    captureId: imageId(o.captureId),
    attemptId: imageId(o.attemptId),
    revision: imageDecimal(o.revision),
    occurrence: parseImageOccurrence(o.occurrence),
    state,
    resourceId,
    resource: saved,
    error,
  };
};

/** Retry eligibility is a server fact, independent of error wording. */
export const parseImageOccurrenceStatus = (v: unknown): ImageOccurrenceStatus => {
  const o = imageObject(v, ["imageId", "revision", "state", "resourceId", "action", "error"]);
  const state = choice(o.state, ["unregistered", "pending", "unknown", "failed", "committed", "unavailable"]);
  const action = choice(o.action, ["none", "observe", "retry_source", "read_saved"]);
  const resourceId = nullable(o.resourceId, imageId), error = nullable(o.error, parseImageError);
  const permitted = state === "committed" ? action === "read_saved" && resourceId !== null
    : state === "pending" || state === "unknown" ? action === "observe"
    : state === "failed" ? action === "none" || action === "retry_source"
    : action === "none";
  if (!permitted || ["unregistered", "failed", "unavailable"].includes(state) && resourceId !== null
    || ["unregistered", "pending", "committed"].includes(state) && error !== null
    || ["failed", "unavailable"].includes(state) && error === null) return fail();
  return { imageId: imageId(o.imageId), revision: imageDecimal(o.revision), state, resourceId, action, error };
};
