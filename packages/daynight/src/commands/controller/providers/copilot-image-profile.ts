import type { ImageGeometry } from "../../../session/image-values.js";
import { selectImageQualification, type QualifiedImages } from "./image-qualification.js";

export type CopilotImageProfile = Readonly<{ modelId: string | null; geometry: ImageGeometry; qualification: QualifiedImages | null }>;
export const unknownCopilotGeometry: ImageGeometry = Object.freeze({ version: 1, known: false, maxWidth: 0, maxHeight: 0, maxPixels: 0, maxFrames: 0 });

/** Native transformations are allowed; a catalog alone cannot prove no omission. */
export const copilotImageProfile = (sdkVersion: unknown, cliVersion: unknown, modelId: string | null = null): CopilotImageProfile | null => {
  if (sdkVersion !== "1.0.11" || cliVersion !== "1.0.105") return null;
  // The current native API does not establish a trustworthy backend identity.
  const qualification = selectImageQualification({ provider: "copilot", nativeVersion: cliVersion, nativeExecutableSha256: null, sdkVersion, platform: process.platform, arch: process.arch, backendIdentity: null, modelId });
  return { modelId, geometry: qualification?.geometry ?? unknownCopilotGeometry, qualification };
};
