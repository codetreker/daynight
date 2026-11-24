import { imageQualificationFingerprint } from "./image-qualification.js";
import { IMAGE_LIMITS, parseImageCapabilities, parseValidatedImage, type ImageCapabilities, type ProviderImageCapabilities } from "../../../session/image-values.js";
import { NativeRpcError } from "./native-rpc.js";
import { validateNativeInput } from "./native-input.js";
import type { NativeInput } from "./types.js";

type Capabilities = Omit<ProviderImageCapabilities, "revision">;

export const applicationImageLimits = {
  inputMediaTypes: ["image/png", "image/jpeg", "image/webp"],
  maxImageBytes: String(IMAGE_LIMITS.imageBytes),
  maxMessageImageBytes: String(IMAGE_LIMITS.messageBytes),
  maxImagesPerMessage: IMAGE_LIMITS.images,
  geometry: { version: 1, known: true, maxWidth: IMAGE_LIMITS.maxWidth, maxHeight: IMAGE_LIMITS.maxHeight, maxPixels: IMAGE_LIMITS.maxPixels, maxFrames: IMAGE_LIMITS.maxFrames },
} as const satisfies Pick<Capabilities, "inputMediaTypes" | "maxImageBytes" | "maxMessageImageBytes" | "maxImagesPerMessage" | "geometry">;

const authorizations = new WeakMap<NativeInput, { capabilities: ImageCapabilities; qualificationFingerprint: string | null; verify(): void }>();
const denied = (): never => { throw new NativeRpcError(-32602, "Image authorization, qualification or effective input limits changed before dispatch."); };

/** Geometry comes from the original full decode, never from another decoder run. */
export const assertNativeImageLimits = (input: NativeInput, caps: Capabilities, expectedTurnId: string | null): void => {
  const { images } = validateNativeInput(input);
  if (!images.length) return;
  if ((expectedTurnId === null ? caps.send : caps.steer) !== "supported" || !caps.geometry.known || images.length > caps.maxImagesPerMessage) denied();
  let total = 0n;
  for (const image of images) {
    const validated = (() => { try { return parseValidatedImage(image.validated); } catch { return denied(); } })();
    if (!validated || validated.sha256 !== image.sha256 || validated.byteLength !== image.byteLength || validated.mediaType !== image.mediaType || !caps.inputMediaTypes.some(mime => mime === validated.mediaType)) denied();
    total += BigInt(validated.byteLength);
    if (BigInt(validated.byteLength) > BigInt(caps.maxImageBytes) || validated.width > caps.geometry.maxWidth || validated.height > caps.geometry.maxHeight || validated.width * validated.height > caps.geometry.maxPixels || validated.frameCount > caps.geometry.maxFrames) denied();
  }
  if (total > BigInt(caps.maxMessageImageBytes)) denied();
};

/** This process-local grant cannot be serialized into a durable input or replayed. */
export const authorizeNativeImageInput = (input: NativeInput, authorization: ImageCapabilities, verify: () => void, qualificationFingerprint: string | null = null): NativeInput => {
  const capabilities = parseImageCapabilities(authorization);
  Object.freeze(capabilities.geometry); Object.freeze(capabilities.inputMediaTypes); Object.freeze(capabilities);
  const authorized = { content: input.content };
  authorizations.set(authorized, { capabilities, verify, qualificationFingerprint });
  return authorized;
};

/** Call after the final asynchronous preparation and immediately before native send. */
export const assertNativeImageAdmission = (input: NativeInput, current: Capabilities, expectedTurnId: string | null): void => {
  if (!input.content.some(part => part.type === "image")) return;
  const grant = authorizations.get(input);
  if (!grant) return denied();
  grant.verify();
  if (grant.qualificationFingerprint !== imageQualificationFingerprint(current)) denied();
  const effective = grant.capabilities;
  if (effective.expectedNativeSessionId !== current.expectedNativeSessionId || effective.modelId !== current.modelId || effective.controlsRevision !== current.controlsRevision) denied();
  assertNativeImageLimits(input, effective, expectedTurnId);
  assertNativeImageLimits(input, current, expectedTurnId);
};
