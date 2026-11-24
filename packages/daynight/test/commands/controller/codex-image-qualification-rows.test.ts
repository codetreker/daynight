import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectImageQualification, qualifiedImageLimits, type ImageRuntimeIdentity } from "../../../src/commands/controller/providers/image-qualification.js";
import { codexImageProfile } from "../../../src/commands/controller/providers/codex-image-profile.js";
import { CodexControls } from "../../../src/commands/controller/providers/controls-codex.js";
import type { CodexConfigObservation } from "../../../src/commands/controller/providers/codex-config-observation.js";
import { IMAGE_LIMITS, parseProviderImageCapabilities } from "../../../src/session/image-values.js";

// These values restate the evidenced production rows independently, so a test
// fails if a registry row drifts from the identity and limits it was qualified for.
const executable = "9248cfeebec9b4cc3034d5114caab10fbf426cbfa79dba410c5fa1b72762abd6";
const backend = "63f0adb320dcbb521cec93c8831f86816f0d19954083a222070a6cad69b8bc14";
const evidenceSha256 = "4ef100d8c1e64127a6bd4dc3eeccdbdb293be0ea9e3f515deb551fc8eb7dc049";
const rows = [
  { modelId: "gpt-6-astra", maxImageBytes: "10461350", maxMessageImageBytes: "20904114" },
  { modelId: "gpt-6.2-astra", maxImageBytes: "10442582", maxMessageImageBytes: "20883253" },
] as const;
const identity = (modelId: string): ImageRuntimeIdentity => ({ provider: "codex", nativeVersion: "0.170.0", nativeExecutableSha256: executable, sdkVersion: null, platform: "darwin", arch: "arm64", backendIdentity: backend, modelId });

test.each(rows)("the production registry admits exactly the evidenced $modelId combination", row => {
  const selected = selectImageQualification(identity(row.modelId));
  expect(selected).not.toBeNull();
  expect(selected).toMatchObject({ identity: identity(row.modelId), evidenceSha256, send: true, steer: false, inputMediaTypes: ["image/png", "image/jpeg", "image/webp"], maxImageBytes: row.maxImageBytes, maxMessageImageBytes: row.maxMessageImageBytes, maxImagesPerMessage: 8, geometry: { version: 1, known: true, maxWidth: 16384, maxHeight: 16384, maxPixels: 33554432, maxFrames: 1 } });
  expect(selected!.evidenceId).toMatch(/^daynight-task:5f7c3a89-22c8-43a9-9cc7-6631287e1de2\//);
  expect(selected!.evidenceId.length).toBeLessThanOrEqual(256);
});

test("the two production rows have distinct qualification fingerprints", () => {
  const [first, second] = rows.map(row => selectImageQualification(identity(row.modelId))!.fingerprint);
  expect(first).not.toBe(second);
});

test.each(rows.flatMap(row => ([
  ["nativeVersion", "0.170.1"],
  ["nativeVersion", "0.167.0"],
  ["nativeExecutableSha256", "0".repeat(64)],
  ["sdkVersion", "0.170.0"],
  ["platform", "win32"],
  ["platform", "linux"],
  ["arch", "x64"],
  ["backendIdentity", "f".repeat(64)],
  ["modelId", "gpt-6.1-astra"],
  ["modelId", "GPT-6-ASTRA"],
  ["provider", "copilot"],
] as const).map(([field, value]) => [row.modelId, field, value] as const)))("%s exact qualification disappears when %s becomes %s", (modelId, field, value) => {
  expect(selectImageQualification({ ...identity(modelId), [field]: value })).toBeNull();
});

test.each(rows)("missing identity fields never select the $modelId row", row => {
  for (const field of ["nativeVersion", "nativeExecutableSha256", "backendIdentity", "modelId"] as const) expect(selectImageQualification({ ...identity(row.modelId), [field]: null })).toBeNull();
});

test.each(rows)("published $modelId limits stay within the Daynight image limits", row => {
  const limits = qualifiedImageLimits(selectImageQualification(identity(row.modelId))!);
  expect(limits).toEqual({ inputMediaTypes: ["image/png", "image/jpeg", "image/webp"], maxImageBytes: row.maxImageBytes, maxMessageImageBytes: row.maxMessageImageBytes, maxImagesPerMessage: 8, geometry: { version: 1, known: true, maxWidth: 16384, maxHeight: 16384, maxPixels: 33554432, maxFrames: 1 } });
  expect(Number(limits.maxImageBytes)).toBeLessThanOrEqual(IMAGE_LIMITS.imageBytes);
  expect(Number(limits.maxMessageImageBytes)).toBeLessThanOrEqual(IMAGE_LIMITS.messageBytes);
  expect(limits.maxImagesPerMessage).toBeLessThanOrEqual(IMAGE_LIMITS.images);
  expect(limits.geometry.maxWidth).toBeLessThanOrEqual(IMAGE_LIMITS.maxWidth);
  expect(limits.geometry.maxHeight).toBeLessThanOrEqual(IMAGE_LIMITS.maxHeight);
  expect(limits.geometry.maxPixels).toBeLessThanOrEqual(IMAGE_LIMITS.maxPixels);
  expect(limits.geometry.maxFrames).toBeLessThanOrEqual(IMAGE_LIMITS.maxFrames);
});

describe("Codex capability publication for the production rows", () => {
  // codexImageProfile reads the Controller architecture from the process; CI
  // runners are not all arm64, so the test pins it and restores the descriptor.
  let arch: PropertyDescriptor;
  beforeEach(() => { arch = Object.getOwnPropertyDescriptor(process, "arch")!; Object.defineProperty(process, "arch", { ...arch, value: "arm64" }); });
  afterEach(() => { Object.defineProperty(process, "arch", arch); });

  const initialized = { userAgent: "daynight/0.170.0 (Mac OS 27.2.1; arm64) ghostty/1.3.2 (daynight; 0.22.0)", platformOs: "macos" };
  const observation = (model: string, patch: Partial<CodexConfigObservation> = {}): CodexConfigObservation => ({ kind: "native_declared_config_v1", nativeSessionId: "thread", model, modelProvider: "copilot_gateway", backendIdentity: backend, generation: 1, ...patch });
  const capabilities = async (model: string, profile: ReturnType<typeof codexImageProfile>) => {
    const root = await mkdtemp(join(tmpdir(), "codex-image-rows-"));
    const controls = new CodexControls({ request: async method => method === "model/list" ? { data: [...rows.map(row => row.modelId), "gpt-6.1-astra"].map(model => ({ model, inputModalities: ["text", "image"] })), nextCursor: null } : method === "skills/list" ? { data: [] } : { requirements: null } }, () => "thread", () => null, root, root, () => {});
    try {
      controls.seed({ model, modelProvider: "copilot_gateway" }); await controls.refresh();
      const capability = controls.imageCapabilities(profile);
      expect(() => parseProviderImageCapabilities({ ...capability, revision: "1" })).not.toThrow();
      return capability;
    } finally { controls.close(); await rm(root, { recursive: true, force: true }); }
  };

  test.each(rows)("the exact $modelId identity publishes send but not steer", async row => {
    const profile = codexImageProfile(initialized, { model: row.modelId, modelProvider: "copilot_gateway" }, "darwin", executable, observation(row.modelId));
    expect(profile?.qualification?.identity).toEqual(identity(row.modelId));
    expect(await capabilities(row.modelId, profile)).toMatchObject({ modelId: row.modelId, send: "supported", steer: "unsupported", reasonCode: null, inputMediaTypes: ["image/png", "image/jpeg", "image/webp"], maxImageBytes: row.maxImageBytes, maxMessageImageBytes: row.maxMessageImageBytes, maxImagesPerMessage: 8, geometry: { known: true, maxWidth: 16384, maxHeight: 16384, maxPixels: 33554432, maxFrames: 1 } });
  });

  test.each([
    ["another executable", { executable: "0".repeat(64) }],
    ["an unknown executable", { executable: null }],
    ["another declared route", { observation: { backendIdentity: "f".repeat(64) } }],
    ["an observation for another model provider", { observation: { modelProvider: "openai" } }],
    ["no declared observation", { observation: null }],
    ["another Codex version", { userAgent: "daynight/0.167.0 (Mac OS 27.2.1; arm64) ghostty/1.3.2 (daynight; 0.22.0)" }],
    ["another Controller architecture", { arch: "x64" }],
  ] as const)("%s uses default send limits without qualification", async (_case, change) => {
    const model = "gpt-6-astra";
    if ("arch" in change) Object.defineProperty(process, "arch", { ...arch, value: change.arch });
    const profile = codexImageProfile("userAgent" in change ? { ...initialized, userAgent: change.userAgent } : initialized, { model, modelProvider: "copilot_gateway" }, "darwin", "executable" in change ? change.executable : executable, "observation" in change ? change.observation && observation(model, change.observation) : observation(model));
    expect(profile?.qualification ?? null).toBeNull();
    const capability = await capabilities(model, profile);
    expect(capability).toMatchObject({ send: "supported", steer: "unknown", reasonCode: null,
      maxImageBytes: String(IMAGE_LIMITS.imageBytes), geometry: { known: true, maxFrames: IMAGE_LIMITS.maxFrames } });
  });

  test("an unevidenced model on the qualified runtime uses default send limits", async () => {
    const profile = codexImageProfile(initialized, { model: "gpt-6.1-astra", modelProvider: "copilot_gateway" }, "darwin", executable, observation("gpt-6.1-astra"));
    expect(profile?.qualification).toBeNull();
    expect(await capabilities("gpt-6.1-astra", profile)).toMatchObject({ send: "supported", steer: "unknown", reasonCode: null, geometry: { known: true } });
  });
});
