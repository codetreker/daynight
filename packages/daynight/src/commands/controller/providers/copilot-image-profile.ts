import type { ImageGeometry } from "../../../session/image-values.js";
import { selectImageQualification, type QualifiedImages } from "./image-qualification.js";
import type { CopilotRouteObservation } from "./copilot-route-observation.js";

export type CopilotImageProfile = Readonly<{ modelId: string | null; geometry: ImageGeometry; qualification: QualifiedImages | null }>;
export const unknownCopilotGeometry: ImageGeometry = Object.freeze({ version: 1, known: false, maxWidth: 0, maxHeight: 0, maxPixels: 0, maxFrames: 0 });

/** Native transformations are allowed; a catalog alone cannot prove no omission. */
export const copilotImageProfile = (sdkVersion: unknown, cliVersion: unknown, modelId: string | null = null, nativeExecutableSha256: string | null = null, observation: CopilotRouteObservation | null = null): CopilotImageProfile | null => {
  if (sdkVersion !== "1.0.11" || cliVersion !== "1.0.105") return null;
  // Declared routing is not outbound evidence. The production registry has no
  // Copilot row until separate qualification covers this observation's limited scope.
  const qualification = selectImageQualification({ provider: "copilot", nativeVersion: cliVersion, nativeExecutableSha256, sdkVersion, platform: process.platform, arch: process.arch, backendIdentity: observation?.modelId === modelId ? observation.backendIdentity : null, modelId });
  return { modelId, geometry: qualification?.geometry ?? unknownCopilotGeometry, qualification };
};
