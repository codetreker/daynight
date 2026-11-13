import path from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { readHerdrSharedInstance, writeHerdrSharedInstance } from "../../../src/commands/worker/herdr/shared-instance-store.js";
import { recordedHerdrTools } from "./herdr-tool-snapshot.fixtures.js";

test("shared instance intent retains original launch across restart and rejects a symlink journal", async () => {
  const scratch = path.resolve("../../.tmp/shared-herdr-tests"); await mkdir(scratch, { recursive: true });
  const herdrDirectory = await mkdtemp(path.join(scratch, "run-")), paths = { herdrDirectory }, tools = recordedHerdrTools();
  try {
    expect(readHerdrSharedInstance(paths)).toBeNull();
    const record = { schemaVersion: 1 as const, current: { launch: tools.herdr, observation: tools.herdrObservation, daemon: null, phase: "ready" as const }, pending: null };
    await writeHerdrSharedInstance(paths, record);
    expect(readHerdrSharedInstance(paths)).toEqual(record);
    const pending = { ...record, pending: { launch: tools.herdr, phase: "intent" as const } };
    await writeHerdrSharedInstance(paths, pending);
    expect(readHerdrSharedInstance(paths)).toEqual(pending);
    const file = path.join(herdrDirectory, "tool-instance.json"), target = path.join(herdrDirectory, "redirect.json");
    await writeFile(target, JSON.stringify(record), { mode: 0o600 }); await rm(file); await symlink(target, file);
    expect(() => readHerdrSharedInstance(paths)).toThrow();
    await expect(writeHerdrSharedInstance(paths, record)).rejects.toThrow();
  } finally { await rm(herdrDirectory, { recursive: true, force: true }); }
});
