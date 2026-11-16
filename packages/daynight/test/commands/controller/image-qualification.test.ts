import { expect, test } from "vitest";
import { controlledImageQualification } from "../../helpers/image-qualification.js";
import { selectImageQualification, qualifiedImageLimits, bindImageQualification, imageQualificationFingerprint, type ImageQualification } from "../../../src/commands/controller/providers/image-qualification.js";
import { authorizeNativeImageInput, assertNativeImageAdmission } from "../../../src/commands/controller/providers/image-admission.js";
import type { ImageCapabilities } from "../../../src/session/image-values.js";

test.each(["provider", "nativeVersion", "nativeExecutableSha256", "sdkVersion", "platform", "arch", "backendIdentity", "modelId"] as const)("qualification requires the exact %s and never falls back to a default", field => {
  const row = controlledImageQualification("copilot", "model"), changed = { ...row.identity, [field]: "different" };
  expect(selectImageQualification(changed, [row])).toBeNull();
  expect(selectImageQualification(row.identity)).toBeNull();
  expect(selectImageQualification(row.identity, [row, row])).toBeNull();
});
test.each([null, undefined, {}])("a missing qualification row stays closed", invalid => {
  const row = controlledImageQualification("copilot", "model");
  expect(selectImageQualification(row.identity, [invalid as unknown as ImageQualification])).toBeNull();
});
test.each([
  ["geometry", { geometry: null }],
  ["evidence hash", { evidenceSha256: "bad" }],
  ["image bytes", { maxImageBytes: "-1" }],
  ["message bytes", { maxMessageImageBytes: "0" }],
  ["count", { maxImagesPerMessage: 1.5 }],
  ["MIME", { inputMediaTypes: ["text/plain"] }],
  ["empty MIME", { inputMediaTypes: [] }],
] as const)("invalid %s independently prevents qualification", (_field, patch) => {
  const row = controlledImageQualification("copilot", "model");
  expect(selectImageQualification(row.identity, [{ ...row, ...patch } as unknown as ImageQualification])).toBeNull();
});
test.each(["true", false, 1])("geometry known=%s cannot establish qualification", known => {
  const row = controlledImageQualification("codex", "model");
  expect(selectImageQualification(row.identity, [{ ...row, geometry: { ...row.geometry, known } } as unknown as ImageQualification])).toBeNull();
});
test("invalid geometry version cannot be normalized into qualification", () => {
  const row = controlledImageQualification("codex", "model");
  expect(selectImageQualification(row.identity, [{ ...row, geometry: { ...row.geometry, version: 2 } } as unknown as ImageQualification])).toBeNull();
});
test("a missing executable/backend or SDK cannot acquire qualification", () => {
  const row = controlledImageQualification("copilot", "model");
  for (const field of ["nativeExecutableSha256", "backendIdentity", "sdkVersion"] as const) expect(selectImageQualification({ ...row.identity, [field]: null }, [{ ...row, identity: { ...row.identity, [field]: null } }])).toBeNull();
});
test("qualified evidence is copied, frozen and intersected with Daynight limits", () => {
  const fixture = controlledImageQualification("codex", "model");
  const source = { ...fixture, maxImageBytes: "20971520", maxMessageImageBytes: "41943040", maxImagesPerMessage: 20 };
  const selected = selectImageQualification(source.identity, [source])!;
  expect(qualifiedImageLimits(selected)).toMatchObject({ maxImageBytes: "10485760", maxMessageImageBytes: "20971520", maxImagesPerMessage: 8 });
  expect(Object.isFrozen(selected.identity)).toBe(true); expect(Object.isFrozen(selected.geometry)).toBe(true);
  expect(selectImageQualification(source.identity, [{ ...source, evidenceId: "replacement" }])!.fingerprint).not.toBe(selected.fingerprint);
});
test("same numeric limits from replacement evidence revoke the original final-send grant", () => {
  const first = controlledImageQualification("codex", "model"), second = controlledImageQualification("codex", "model", { evidenceId: "replacement" });
  const caps = (): ImageCapabilities => ({ revision: "1", providerRevision: "1", expectedNativeSessionId: "native", controlsRevision: "1", modelId: "model", reasonCode: null, send: "supported", steer: "supported", ...qualifiedImageLimits(first) });
  const current = bindImageQualification(caps(), first);
  const input = authorizeNativeImageInput({ content: [{ type: "image", imageId: "i", resourceId: "r", localPath: process.cwd(), mediaType: "image/png", byteLength: "1", sha256: "a".repeat(64), validated: { mediaType: "image/png", byteLength: "1", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 } }] }, caps(), () => {}, first.fingerprint);
  assertNativeImageAdmission(input, current, null);
  expect(imageQualificationFingerprint(structuredClone(current))).toBeNull();
  expect(() => assertNativeImageAdmission(input, bindImageQualification(caps(), second), null)).toThrow(/qualification/);
  expect(() => assertNativeImageAdmission(input, structuredClone(current), null)).toThrow(/qualification/);
});
