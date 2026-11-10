import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexControls } from "../../../src/commands/controller/providers/controls-codex.js";
import { codexImageProfile, supportsCodexImageProfile, type CodexImageProfile } from "../../../src/commands/controller/providers/codex-image-profile.js";
import { parseProviderImageCapabilities } from "../../../src/session/image-values.js";

const initialized = { userAgent: "daynight/0.167.0 (Mac OS 27.2.0; arm64) dumb (daynight; 0.50.0)", platformOs: "macos" };
const controlledProfile = (modelId: string): CodexImageProfile => ({ modelId, modelProvider: "controlled", geometry: { version: 1, known: true, maxWidth: 1024, maxHeight: 1024, maxPixels: 1_048_576, maxFrames: 1 } });

test("the native image profile rejects unverified executable versions and platforms", () => {
  const native = { userAgent: "daynight/0.167.0 (Mac OS 27.2.0; arm64) dumb (daynight; 0.50.0)", platformOs: "macos" };
  expect(supportsCodexImageProfile(native, "darwin")).toBe(true);
  expect(supportsCodexImageProfile({ ...native, userAgent: native.userAgent.replace("0.167.0", "0.168.0") }, "darwin")).toBe(false);
  expect(supportsCodexImageProfile({ ...native, platformOs: "linux" }, "linux")).toBe(false);
  expect(supportsCodexImageProfile({}, "darwin")).toBe(false);
});

test("an image modality without exact backend geometry stays unknown and satisfies the public capability protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-image-controls-"));
  const controls = new CodexControls({ request: async method => method === "model/list" ? { data: [{ model: "gpt-6-astra", inputModalities: ["text", "image"] }], nextCursor: null } : method === "skills/list" ? { data: [] } : { requirements: null } }, () => "thread", () => null, root, root, () => {});
  try {
    controls.seed({ model: "gpt-6-astra", modelProvider: "copilot_gateway" }); await controls.refresh();
    const capability = controls.imageCapabilities(codexImageProfile(initialized, { model: "gpt-6-astra", modelProvider: "copilot_gateway" }, "darwin"));
    expect(() => parseProviderImageCapabilities({ ...capability, revision: "1" })).not.toThrow();
    expect(capability).toMatchObject({ send: "unknown", steer: "unknown", reasonCode: "capability_unknown", geometry: { known: false } });
  } finally { controls.close(); await rm(root, { recursive: true, force: true }); }
});

test("image capability requires the exact model's complete catalog modality and a known native profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-image-controls-")), calls: unknown[] = [];
  const controls = new CodexControls({ request: async (method, params) => { calls.push({ method, params }); if (method === "model/list") return (params as any).cursor ? { data: [{ id: "vision", model: "vision", inputModalities: ["text", "image"], hidden: true }], nextCursor: null } : { data: [{ model: "text", inputModalities: ["text"] }], nextCursor: "second" }; return method === "skills/list" ? { data: [] } : { requirements: null }; } }, () => "thread", () => null, root, root, () => {});
  try {
    const profile = controlledProfile("vision");
    controls.seed({ model: "vision", modelProvider: "controlled" }); expect(controls.imageCapabilities(profile).send).toBe("unknown");
    await controls.refresh();
    expect(controls.imageCapabilities(profile)).toMatchObject({ modelId: "vision", send: "supported", steer: "supported" });
    expect(controls.imageCapabilities(null)).toMatchObject({ send: "unknown", reasonCode: "profile_disabled" });
    controls.observe({ modelProvider: "other" }); expect(controls.imageCapabilities(profile)).toMatchObject({ send: "unknown", geometry: { known: false } });
    controls.observe({ modelProvider: "controlled", model: "text" }); expect(controls.imageCapabilities(profile)).toMatchObject({ send: "unsupported", reasonCode: "model_unsupported" });
    controls.observe({ model: "absent" }); expect(controls.imageCapabilities(profile)).toMatchObject({ send: "unknown", reasonCode: "capability_unknown" });
    expect(calls.filter((call: any) => call.method === "model/list")).toHaveLength(2);
  } finally { controls.close(); await rm(root, { recursive: true, force: true }); }
});

test("an unconfirmed live model change withdraws image admission before native mutation settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-image-controls-")); let live: (() => void) | undefined, turn: string | null = null;
  const controls = new CodexControls({ request: async method => {
    if (method === "model/list") return { data: [{ model: "first", inputModalities: ["text", "image"] }, { model: "second", inputModalities: ["text", "image"] }], nextCursor: null };
    if (method === "turn/settings/update") { await new Promise<void>(resolve => { live = resolve; }); return { status: "applied" }; }
    if (method === "thread/settings/update") { controls.observe({ model: "second" }); return {}; }
    return method === "skills/list" ? { data: [] } : { requirements: null };
  } }, () => "thread", () => turn, root, root, () => {});
  try {
    controls.seed({ model: "first", modelProvider: "controlled" }); await controls.refresh(); turn = "active"; controls.beginTurn();
    const setting = controls.set("model", "second", "setting", controls.store.value.revision);
    try { expect(controls.imageCapabilities(controlledProfile("first"))).toMatchObject({ steer: "unknown", reasonCode: "capability_unknown" }); }
    finally { live!(); await setting; }
    expect(controls.imageCapabilities(controlledProfile("first"))).toMatchObject({ modelId: "second", send: "unknown", geometry: { known: false } });
    expect(controls.imageCapabilities(controlledProfile("second"))).toMatchObject({ modelId: "second", steer: "supported" });
    controls.observe({ model: "first" }); expect(controls.imageCapabilities(controlledProfile("first"))).toMatchObject({ steer: "unknown", reasonCode: "capability_unknown" });
  } finally { controls.close(); await rm(root, { recursive: true, force: true }); }
});
