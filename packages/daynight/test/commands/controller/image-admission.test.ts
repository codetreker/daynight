import { expect, test, vi } from "vitest";
import { assertNativeImageAdmission, authorizeNativeImageInput } from "../../../src/commands/controller/providers/image-admission.js";
import type { ImageCapabilities } from "../../../src/session/image-values.js";
import type { NativeInput, NativeImagePart } from "../../../src/commands/controller/providers/types.js";

const caps = (): ImageCapabilities => ({ revision: "7", providerRevision: "2", expectedNativeSessionId: "native", modelId: "model", controlsRevision: "3", send: "supported", steer: "unsupported", reasonCode: null, inputMediaTypes: ["image/png"], maxImageBytes: "100", maxMessageImageBytes: "200", maxImagesPerMessage: 2, geometry: { version: 1, known: true, maxWidth: 32, maxHeight: 32, maxPixels: 512, maxFrames: 1 } });
const image = (): NativeImagePart => ({ type: "image", imageId: "image", resourceId: "resource", mediaType: "image/png", byteLength: "100", sha256: "a".repeat(64), localPath: process.cwd(), validated: { mediaType: "image/png", byteLength: "100", sha256: "a".repeat(64), width: 32, height: 16, frameCount: 1 } });

test("authorization is process-local and cannot be recovered from a copied durable input", () => {
  const original: NativeInput = { content: [image()] }, verify = vi.fn();
  const input = authorizeNativeImageInput(original, caps(), verify);
  expect(JSON.stringify(input)).toBe(JSON.stringify(original));
  assertNativeImageAdmission(input, caps(), null); expect(verify).toHaveBeenCalledOnce();
  expect(() => assertNativeImageAdmission(original, caps(), null)).toThrow(/authorization/);
  expect(() => assertNativeImageAdmission(structuredClone(input), caps(), null)).toThrow(/authorization/);
});

test.each(["width", "height", "pixels", "frames", "mime", "bytes", "total", "count", "metadata", "identity", "steer", "revoked"])("final native admission rejects a second image or changed qualification: %s", change => {
  const effective = caps(), current = caps(), first = image(), second = image();
  const input = authorizeNativeImageInput({ content: [first, second] }, effective, () => { if (change === "revoked") throw new Error("revoked"); });
  if (change === "width") Object.assign(second, { validated: { ...second.validated!, width: 33 } });
  if (change === "height") Object.assign(second, { validated: { ...second.validated!, height: 33 } });
  if (change === "pixels") Object.assign(second, { validated: { ...second.validated!, height: 17 } });
  if (change === "frames") Object.assign(second, { validated: { ...second.validated!, frameCount: 2 } });
  if (change === "mime") Object.assign(current, { inputMediaTypes: ["image/jpeg"] });
  if (change === "bytes") Object.assign(current, { maxImageBytes: "99" });
  if (change === "total") Object.assign(current, { maxMessageImageBytes: "199" });
  if (change === "count") Object.assign(current, { maxImagesPerMessage: 1 });
  if (change === "metadata") Object.assign(second, { validated: { ...second.validated!, sha256: "b".repeat(64) } });
  if (change === "identity") Object.assign(current, { controlsRevision: "4" });
  expect(() => assertNativeImageAdmission(input, current, change === "steer" ? "turn" : null)).toThrow();
});
