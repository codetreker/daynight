import { record, string } from "./native-rpc.js";
import type { ImageGeometry } from "../../../session/image-values.js";

export type CodexImageProfile = Readonly<{ modelProvider: string | null; modelId: string | null; geometry: ImageGeometry }>;
export const unknownCodexGeometry: ImageGeometry = Object.freeze({ version: 1, known: false, maxWidth: 0, maxHeight: 0, maxPixels: 0, maxFrames: 0 });

/** Protocol compatibility is necessary but does not establish image admission. */
export const supportsCodexImageProfile = (response: unknown, platform: NodeJS.Platform = process.platform): boolean => {
  const initialized = record(response);
  return /^daynight\/0\.167\.0 \(/.test(string(initialized.userAgent)) && initialized.platformOs === "macos" && platform === "darwin";
};

export const codexImageProfile = (response: unknown, native: unknown, platform: NodeJS.Platform = process.platform): CodexImageProfile | null => {
  if (!supportsCodexImageProfile(response, platform)) return null;
  const selection = record(native);
  // This native version exposes input modalities, but no input geometry bounds.
  // OpenAI API limits do not establish limits for a custom model provider.
  return { modelProvider: string(selection.modelProvider) || null, modelId: string(selection.model) || null, geometry: unknownCodexGeometry };
};
