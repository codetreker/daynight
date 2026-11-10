import type { ImageGeometry } from "../../../session/image-values.js";

export type CopilotImageProfile = Readonly<{ geometry: ImageGeometry }>;
export const unknownCopilotGeometry: ImageGeometry = Object.freeze({ version: 1, known: false, maxWidth: 0, maxHeight: 0, maxPixels: 0, maxFrames: 0 });

/** Version compatibility does not prove a model/backend geometry envelope. */
export const copilotImageProfile = (sdkVersion: unknown, cliVersion: unknown): CopilotImageProfile | null => {
  if (sdkVersion !== "1.0.11" || cliVersion !== "1.0.105") return null;
  // The documented catalog exposes MIME, bytes and count only. Native resizing
  // can omit images, so decoder limits cannot establish native input geometry.
  return { geometry: unknownCopilotGeometry };
};
