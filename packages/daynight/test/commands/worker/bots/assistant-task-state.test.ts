import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAssistantRuntimeState } from "../../../../src/commands/worker/bots/assistant-task-state.js";
import * as privateFiles from "../../../../src/commands/task/session/private-files.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = path.resolve(import.meta.dirname, "../../../../../../.tmp/assistant-runtime-state-tests"); await mkdir(root, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(root, "case-")); roots.push(stateDirectory);
  return { stateDirectory, key: "delivery", owner: { serverOrigin: "https://daynight.example", ownerUserId: "00000000-0000-4000-8000-000000000001", workerId: "00000000-0000-4000-8000-000000000002" } };
};
const files = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();

describe("assistant-task private runtime journals", () => {
  it("round-trips an input larger than a private-file record with private permissions and an exclusive writer", async () => {
    const options = await fixture(), value = { command: { text: "通知".repeat(40_000) }, events: ["original"] };
    await withAssistantRuntimeState(options, async (read, save) => {
      expect(await read()).toBeNull(); await save(value);
      await expect(withAssistantRuntimeState(options, async () => undefined)).rejects.toThrow();
    });
    expect(await withAssistantRuntimeState(options, read => read())).toEqual(value);
    const saved = await files(options.stateDirectory); expect(saved.filter(file => file.endsWith(".data")).length).toBeGreaterThan(1);
    if (process.platform !== "win32") for (const file of saved) expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it("keeps the previous complete intent when an oversized replacement is refused", async () => {
    const options = await fixture();
    await withAssistantRuntimeState(options, async (_read, save) => { await save({ original: true }); });
    await expect(withAssistantRuntimeState(options, async (_read, save) => { await save("x".repeat(4 * 1024 * 1024)); })).rejects.toThrow(/exceeds/);
    expect(await withAssistantRuntimeState(options, read => read())).toEqual({ original: true });
  });
  it("bounds chunk files to two banks as independently saved intents accumulate", async () => {
    const options = await fixture();
    const large = "x".repeat(70_000), chunks = Math.ceil(Buffer.byteLength(JSON.stringify({ value: large, revision: 0 })) / 32768);
    for (let revision = 0; revision < 8; revision++) {
      await withAssistantRuntimeState(options, async (_read, save) => { await save({ value: large, revision }); });
      const data = (await files(options.stateDirectory)).filter(file => file.endsWith(".data"));
      expect(data.length).toBeLessThanOrEqual(chunks * 2);
      expect(await withAssistantRuntimeState(options, read => read())).toEqual({ value: large, revision });
    }
  });
  it("preserves a complete previous bank when selecting the previous manifest after replacement", async () => {
    const options = await fixture(), first = { value: "first".repeat(15_000) }, second = { value: "second".repeat(15_000) };
    await withAssistantRuntimeState(options, async (_read, save) => { await save(first); });
    const manifest = (await files(options.stateDirectory)).find(file => file.endsWith("delivery.json"))!, previous = await readFile(manifest);
    await withAssistantRuntimeState(options, async (_read, save) => { await save(second); });
    const current = await readFile(manifest);
    expect(JSON.parse(previous.toString()).slot).not.toBe(JSON.parse(current.toString()).slot);
    await writeFile(manifest, previous, { mode: 0o600 });
    expect(await withAssistantRuntimeState(options, read => read())).toEqual(first);
    await writeFile(manifest, current, { mode: 0o600 });
    expect(await withAssistantRuntimeState(options, read => read())).toEqual(second);
  });
  it("ignores an old bank tail when a large journal is replaced by a small journal", async () => {
    const options = await fixture();
    for (const value of ["a".repeat(100_000), "b".repeat(100_000), "small"]) await withAssistantRuntimeState(options, async (_read, save) => { await save({ value }); });
    const manifest = (await files(options.stateDirectory)).find(file => file.endsWith("delivery.json"))!, selected = JSON.parse(await readFile(manifest, "utf8"));
    expect(selected.chunks).toBe(1);
    expect((await files(options.stateDirectory)).filter(file => file.endsWith(".data")).length).toBeGreaterThan(2);
    expect(await withAssistantRuntimeState(options, read => read())).toEqual({ value: "small" });
  });
  it("preserves the published bank after an inactive-bank chunk write fails", async () => {
    const options = await fixture(), first = { value: "first".repeat(15_000) };
    await withAssistantRuntimeState(options, async (_read, save) => { await save(first); });
    const actual = await privateFiles.loadOperationFiles();
    vi.spyOn(privateFiles, "loadOperationFiles").mockResolvedValue({ open: async (directory, create) => {
      const handle = await actual.open(directory, create);
      if (!handle) return handle;
      return { ...handle, replace: async (name, bytes) => { await handle.replace(name, bytes); if (name.endsWith(".data")) throw new Error("inactive bank write failed"); } };
    } });
    await expect(withAssistantRuntimeState(options, async (_read, save) => { await save({ value: "second".repeat(15_000) }); })).rejects.toThrow("inactive bank write failed");
    vi.restoreAllMocks();
    expect(await withAssistantRuntimeState(options, read => read())).toEqual(first);
  });
  it.each(["missing", "corrupt"])("does not treat a %s chunk as an absent operation", async mode => {
    const options = await fixture(); await withAssistantRuntimeState(options, async (_read, save) => { await save({ original: true }); });
    const chunk = (await files(options.stateDirectory)).find(file => file.endsWith(".data"))!;
    if (mode === "missing") await rm(chunk); else await writeFile(chunk, "{\"original\":false}", { mode: 0o600 });
    await expect(withAssistantRuntimeState(options, read => read())).rejects.toThrow(mode === "missing" ? /incomplete/ : /digest/);
  });
  it("isolates service and user scope, and publishes explicit null only after saving it", async () => {
    const options = await fixture(); await withAssistantRuntimeState(options, async (_read, save) => { await save({ operationId: "original" }); });
    const otherOwner = { ...options, owner: { ...options.owner, ownerUserId: "00000000-0000-4000-8000-000000000003" } };
    expect(await withAssistantRuntimeState(otherOwner, read => read())).toBeNull();
    expect(await withAssistantRuntimeState({ ...options, owner: { ...options.owner, serverOrigin: "https://other.example" } }, read => read())).toBeNull();
    await withAssistantRuntimeState(options, async (_read, save) => { await save(null); });
    expect(await withAssistantRuntimeState(options, read => read())).toBeNull();
    const manifest = (await files(options.stateDirectory)).find(file => file.endsWith("delivery.json"))!;
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({ chunks: 1 });
  });
});
