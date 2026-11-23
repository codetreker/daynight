import { createHash } from "node:crypto";
import { canonicalImageJson, IMAGE_LIMITS, parseProviderImageCapabilities, type ImageGeometry, type InputMime } from "../../../session/image-values.js";

export type ImageRuntimeIdentity = Readonly<{
  provider: "codex" | "copilot";
  nativeVersion: string | null;
  nativeExecutableSha256: string | null;
  /** Null means no SDK for Codex's app-server transport; it is unknown for Copilot. */
  sdkVersion: string | null;
  platform: string;
  arch: string;
  /** Digest of the evidence-scoped visible route; never proof of hidden deployment or algorithms. */
  backendIdentity: string | null;
  modelId: string | null;
}>;
export type ImageQualification = Readonly<{
  identity: ImageRuntimeIdentity;
  evidenceId: string;
  evidenceSha256: string;
  send: boolean;
  steer: boolean;
  inputMediaTypes: readonly InputMime[];
  maxImageBytes: string;
  maxMessageImageBytes: string;
  maxImagesPerMessage: number;
  geometry: ImageGeometry;
}>;
export type QualifiedImages = ImageQualification & Readonly<{ fingerprint: string }>;
// Only independently qualified exact combinations belong here. Catalog claims
// and a single visual success do not qualify a runtime combination.
//
// Each row is one exact evidenced combination: the native binary digest,
// declared route digest, model and platform observed in the referenced
// evidence package. Limits are the largest values that package actually
// delivered and the model answered correctly, not native or catalog maxima;
// steer stays false because no same-turn steer receipt was collected.
// evidenceId pins native evidence only; product-chain acceptance for the same
// combination is required separately before a row ships.
const codex0170DarwinArm64 = (modelId: string, maxImageBytes: string, maxMessageImageBytes: string): ImageQualification => ({
  identity: { provider: "codex", nativeVersion: "0.170.0", nativeExecutableSha256: "9248cfeebec9b4cc3034d5114caab10fbf426cbfa79dba410c5fa1b72762abd6", sdkVersion: null, platform: "darwin", arch: "arm64", backendIdentity: "63f0adb320dcbb521cec93c8831f86816f0d19954083a222070a6cad69b8bc14", modelId },
  evidenceId: "daynight-task:5f7c3a89-22c8-43a9-9cc7-6631287e1de2/evidence/codex-macos-0.170.0/evidence.zip",
  evidenceSha256: "4ef100d8c1e64127a6bd4dc3eeccdbdb293be0ea9e3f515deb551fc8eb7dc049",
  send: true,
  steer: false,
  inputMediaTypes: ["image/png", "image/jpeg", "image/webp"],
  maxImageBytes,
  maxMessageImageBytes,
  maxImagesPerMessage: 8,
  geometry: { version: 1, known: true, maxWidth: 16384, maxHeight: 16384, maxPixels: 33554432, maxFrames: 1 },
});
const qualifications: readonly ImageQualification[] = Object.freeze([
  codex0170DarwinArm64("gpt-6-astra", "10461350", "20904114"),
  codex0170DarwinArm64("gpt-6.2-astra", "10442582", "20883253"),
]);
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
const complete = (identity: ImageRuntimeIdentity): boolean => (identity.provider === "codex" || identity.provider === "copilot") && sha256(identity.nativeExecutableSha256) && text(identity.nativeVersion) && text(identity.modelId) && text(identity.platform) && text(identity.arch) && sha256(identity.backendIdentity) && (identity.provider === "codex" ? identity.sdkVersion === null : text(identity.sdkVersion));

/** Ambiguous, incomplete or invalid evidence never admits a runtime combination. */
export const selectImageQualification = (identity: ImageRuntimeIdentity, registry: readonly ImageQualification[] = qualifications): QualifiedImages | null => {
  try {
    if (!complete(identity)) return null;
    const matches = registry.filter(row => canonicalImageJson(row.identity) === canonicalImageJson(identity));
    if (matches.length !== 1) return null;
    const row = matches[0]!;
    if (typeof row.evidenceId !== "string" || !row.evidenceId.trim() || row.evidenceId.length > 256 || !sha256(row.evidenceSha256) || typeof row.send !== "boolean" || typeof row.steer !== "boolean" || row.geometry.version !== 1 || row.geometry.known !== true) return null;
    if (![row.maxImageBytes, row.maxMessageImageBytes].every(value => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)))) return null;
    if (![row.maxImagesPerMessage, row.geometry.maxWidth, row.geometry.maxHeight, row.geometry.maxPixels, row.geometry.maxFrames].every(value => Number.isSafeInteger(value) && value > 0)) return null;
    parseProviderImageCapabilities({ revision: "1", expectedNativeSessionId: null, modelId: identity.modelId, controlsRevision: null, send: row.send ? "supported" : "unsupported", steer: row.steer ? "supported" : "unsupported", reasonCode: row.send || row.steer ? null : "profile_disabled", ...qualifiedImageLimits(row) });
    const copy: ImageQualification = structuredClone({ identity: row.identity, evidenceId: row.evidenceId, evidenceSha256: row.evidenceSha256, send: row.send, steer: row.steer, inputMediaTypes: row.inputMediaTypes, maxImageBytes: row.maxImageBytes, maxMessageImageBytes: row.maxMessageImageBytes, maxImagesPerMessage: row.maxImagesPerMessage, geometry: row.geometry });
    Object.freeze(copy.identity); Object.freeze(copy.geometry); Object.freeze(copy.inputMediaTypes);
    return Object.freeze({ ...copy, fingerprint: createHash("sha256").update(canonicalImageJson(copy)).digest("hex") });
  } catch { return null; }
};

/** The private binding is consumed before public DTO parsing or serialization. */
const bindings = new WeakMap<object, string>();
export const bindImageQualification = <T extends object>(capabilities: T, qualification: QualifiedImages | null): T => {
  if (qualification) bindings.set(capabilities, qualification.fingerprint);
  return capabilities;
};
export const imageQualificationFingerprint = (capabilities: object | undefined): string | null => capabilities ? bindings.get(capabilities) ?? null : null;
export const qualifiedImageLimits = (qualification: ImageQualification) => ({
  inputMediaTypes: qualification.inputMediaTypes,
  maxImageBytes: String(Math.min(Number(qualification.maxImageBytes), IMAGE_LIMITS.imageBytes)),
  maxMessageImageBytes: String(Math.min(Number(qualification.maxMessageImageBytes), IMAGE_LIMITS.messageBytes)),
  maxImagesPerMessage: Math.min(qualification.maxImagesPerMessage, IMAGE_LIMITS.images),
  geometry: { version: 1 as const, known: true, maxWidth: Math.min(qualification.geometry.maxWidth, IMAGE_LIMITS.maxWidth), maxHeight: Math.min(qualification.geometry.maxHeight, IMAGE_LIMITS.maxHeight), maxPixels: Math.min(qualification.geometry.maxPixels, IMAGE_LIMITS.maxPixels), maxFrames: Math.min(qualification.geometry.maxFrames, IMAGE_LIMITS.maxFrames) },
});
