import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createNativeSelectionFs } from "../../../src/commands/worker/native-selection-fs.js";

let root: string;
beforeEach(async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp");
  await mkdir(scratch, { recursive: true }); root = await mkdtemp(path.join(scratch, "selection-fs-"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("reads native configuration without persisting probe writes, renames or removals", async () => {
  await writeFile(path.join(root, "config.json"), '{"model":"native"}');
  const fs = createNativeSelectionFs(root);
  expect(await fs.readFile("config.json")).toBe('{"model":"native"}');
  await fs.writeFile("config.json", "overlay");
  await fs.appendFile("state/events.jsonl", "first");
  await fs.appendFile("state/events.jsonl", "second");
  expect(await fs.readFile("state/events.jsonl")).toBe("firstsecond");
  await fs.rename("state", "moved");
  expect(await fs.exists("state")).toBe(false);
  expect(await fs.readdirWithTypes("moved")).toEqual([{ name: "events.jsonl", type: "file" }]);
  await fs.rm("config.json", false, false);
  expect(await fs.exists("config.json")).toBe(false);
  await expect(fs.readFile("config.json")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(root, "config.json"), "utf8")).toBe('{"model":"native"}');
  expect(await readdir(root)).toEqual(["config.json"]);
  expect(await createNativeSelectionFs(root).exists("moved")).toBe(false);
});
