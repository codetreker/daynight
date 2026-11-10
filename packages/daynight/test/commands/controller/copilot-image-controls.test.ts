import { afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { CopilotSession } from "@github/copilot-sdk";
import { CopilotControls } from "../../../src/commands/controller/providers/controls-copilot.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { copilotImageProfile, type CopilotImageProfile } from "../../../src/commands/controller/providers/copilot-image-profile.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";

afterEach(() => vi.useRealTimers());
const controlledProfile: CopilotImageProfile = { geometry: { version: 1, known: true, maxWidth: 1024, maxHeight: 1024, maxPixels: 1_048_576, maxFrames: 1 } };
const fixture = () => {
  const first: any = { id: "first", name: "First", capabilities: { supports: { vision: true }, limits: { vision: { supported_media_types: ["image/png", "image/jpeg"], max_prompt_image_size: 1024, max_prompt_images: 2 } } } };
  const models = [first, { ...structuredClone(first), id: "second", name: "Second" }];
  const native = { rpc: { model: { getCurrent: vi.fn(async () => ({ modelId: "first" })), list: vi.fn(async () => ({ list: models })), switchTo: vi.fn(async () => ({ deferred: true })) }, permissions: {}, skills: { ensureLoaded: async () => {}, list: async () => ({ skills: [] }) } } };
  const controls = new CopilotControls(native as unknown as CopilotSession, () => {});
  return { first, models, native, controls };
};
test("Copilot image admission intersects the exact native model limits and requires a pinned runtime profile", async () => {
  const f = fixture(); await f.controls.refresh();
  try {
    expect(f.controls.imageCapabilities(controlledProfile, "native")).toMatchObject({ send: "supported", steer: "unknown", inputMediaTypes: ["image/png", "image/jpeg"], maxImageBytes: "1024", maxImagesPerMessage: 2 });
    expect(f.controls.imageCapabilities(null, "native").send).toBe("unknown");
    expect(f.controls.imageCapabilities(controlledProfile, null).send).toBe("unknown");
    f.first.capabilities.supports.vision = false; await f.controls.refresh(false);
    expect(f.controls.imageCapabilities(controlledProfile, "native").send).toBe("unsupported");
  } finally { f.controls.close(); }
});
test.each(["missing_mime", "bad_count", "duplicate", "non_boolean"])("Copilot model evidence %s fails closed", async mode => {
  const f = fixture();
  if (mode === "missing_mime") delete f.first.capabilities.limits.vision.supported_media_types;
  else if (mode === "bad_count") f.first.capabilities.limits.vision.max_prompt_images = 1.5;
  else if (mode === "duplicate") f.models.push(structuredClone(f.first));
  else f.first.capabilities.supports.vision = "true";
  await f.controls.refresh();
  try { expect(f.controls.imageCapabilities(controlledProfile, "native").send).toBe("unknown"); }
  finally { f.controls.close(); }
});
test("a timed-out model mutation cannot restore image admission from an old-model readback", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.controls.refresh();
  f.native.rpc.model.switchTo.mockImplementation(() => new Promise(() => {}));
  const changing = f.controls.set("model", "second", "operation", f.controls.store.value.revision), rejected = expect(changing).rejects.toThrow();
  try {
    expect(f.controls.imageCapabilities(controlledProfile, "native").send).toBe("unknown");
    await vi.advanceTimersByTimeAsync(30_001); await rejected;
    await f.controls.refresh(false); expect(f.controls.imageCapabilities(controlledProfile, "native").send).toBe("unknown");
    f.native.rpc.model.getCurrent.mockResolvedValue({ modelId: "second" }); await f.controls.refresh(false);
    expect(f.controls.imageCapabilities(controlledProfile, "native").send).toBe("supported");
  } finally { f.controls.close(); }
});

test("Copilot capability publication survives the real journal boundary and never advertises unknown geometry as supported", async () => {
  const f = fixture(); await f.controls.refresh();
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-image-controls"); await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "case-")), database = createMemoryDatabase();
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", testExecutionId: randomUUID(), ownerUserId: randomUUID(), provider: "copilot", cwd, nativeHome: path.join(cwd, ".copilot"), configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialInput: "none", initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(cwd, "grant.json"), ipcEndpoint: path.join(cwd, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const journal = openControllerLifecycleStore(path.join(cwd, "capabilities.sqlite"), ticket, { database });
  try {
    const first = journal.providerImageCapabilities(f.controls.imageCapabilities(copilotImageProfile("1.0.11", "1.0.105"), "native"));
    expect(first).toMatchObject({ send: "unknown", reasonCode: "capability_unknown", geometry: { known: false } });
    expect(journal.providerImageCapabilities(f.controls.imageCapabilities(copilotImageProfile("1.0.11", "1.0.105"), "native"))).toEqual(first);
    f.first.capabilities.supports.vision = false; await f.controls.refresh(false);
    const unsupported = journal.providerImageCapabilities(f.controls.imageCapabilities(copilotImageProfile("1.0.11", "1.0.105"), "native"));
    expect(unsupported).toMatchObject({ send: "unsupported", reasonCode: "model_unsupported", revision: "2" });
    f.first.capabilities.supports.vision = true; await f.controls.refresh(false);
    const supported = journal.providerImageCapabilities(f.controls.imageCapabilities(controlledProfile, "native"));
    expect(supported).toMatchObject({ send: "supported", steer: "unknown", reasonCode: "capability_unknown", revision: "3", geometry: { known: true } });
    const disabled = journal.providerImageCapabilities(f.controls.imageCapabilities(null, "native"));
    expect(disabled).toMatchObject({ send: "unknown", reasonCode: "profile_disabled", revision: "4" });
  } finally { journal.close(); if (database.open) database.close(); f.controls.close(); await rm(cwd, { recursive: true, force: true }); }
});
