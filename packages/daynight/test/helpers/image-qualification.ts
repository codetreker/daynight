import { selectImageQualification, type ImageQualification, type QualifiedImages } from "../../src/commands/controller/providers/image-qualification.js";

/** Controlled envelope for mechanism tests; never production qualification evidence. */
export const controlledImageQualification = (provider: "codex" | "copilot", modelId: string, patch: Partial<ImageQualification> = {}): QualifiedImages => {
  const row: ImageQualification = { identity: { provider, nativeVersion: "fixture", nativeExecutableSha256: "c".repeat(64), sdkVersion: provider === "codex" ? null : "fixture", platform: process.platform, arch: process.arch, backendIdentity: "a".repeat(64), modelId }, evidenceId: "controlled-fixture-only", evidenceSha256: "b".repeat(64), send: true, steer: provider === "codex", inputMediaTypes: ["image/png", "image/jpeg", "image/webp"], maxImageBytes: "10485760", maxMessageImageBytes: "20971520", maxImagesPerMessage: 8, geometry: { version: 1, known: true, maxWidth: 1024, maxHeight: 1024, maxPixels: 1048576, maxFrames: 1 }, ...patch };
  const qualification = selectImageQualification(row.identity, [row]);
  if (!qualification) throw new Error("Controlled qualification is invalid");
  return qualification;
};
