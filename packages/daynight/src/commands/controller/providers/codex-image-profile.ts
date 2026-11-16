import { selectImageQualification, type QualifiedImages } from "./image-qualification.js";
import { record, string } from "./native-rpc.js";
import type { ImageGeometry } from "../../../session/image-values.js";
import type { CodexConfigObservation } from "./codex-config-observation.js";

export type CodexImageProfile = Readonly<{ modelProvider: string | null; modelId: string | null; geometry: ImageGeometry; qualification: QualifiedImages | null }>;
export const unknownCodexGeometry: ImageGeometry = Object.freeze({ version: 1, known: false, maxWidth: 0, maxHeight: 0, maxPixels: 0, maxFrames: 0 });

/** Protocol compatibility is necessary but does not establish image admission. */
export const supportsCodexImageProfile = (response: unknown, platform: NodeJS.Platform = process.platform): boolean => {
  const initialized = record(response);
  return /^daynight\/0\.167\.0 \(/.test(string(initialized.userAgent)) && initialized.platformOs === "macos" && platform === "darwin"
    || /^daynight\/0\.169\.0 \(/.test(string(initialized.userAgent)) && initialized.platformOs === "windows" && platform === "win32";
};

export const codexImageProfile = (response: unknown, native: unknown, platform: NodeJS.Platform = process.platform, nativeExecutableSha256: string | null = null, observation: CodexConfigObservation | null = null): CodexImageProfile | null => {
  if (!supportsCodexImageProfile(response, platform)) return null;
  const selection = record(native);
  // Declared configuration supplies identity, not receipt or geometry evidence.
  const modelId = string(selection.model) || null;
  const qualification = selectImageQualification({ provider: "codex", nativeVersion: /^daynight\/([^ ]+) /.exec(string(record(response).userAgent))?.[1] ?? null, nativeExecutableSha256, sdkVersion: null, platform, arch: process.arch, backendIdentity: observation?.model === modelId && observation.modelProvider === selection.modelProvider ? observation.backendIdentity : null, modelId });
  return { modelProvider: string(selection.modelProvider) || null, modelId, geometry: qualification?.geometry ?? unknownCodexGeometry, qualification };
};
