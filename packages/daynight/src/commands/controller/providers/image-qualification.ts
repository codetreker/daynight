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
  /** Digest of a trustworthy backend identity, never an address or provider alias. */
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
const qualifications: readonly ImageQualification[] = Object.freeze([]);
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
