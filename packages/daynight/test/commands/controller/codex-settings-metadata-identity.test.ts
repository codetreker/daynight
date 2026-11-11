import { afterEach, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { observeCodexMetadata } from "../../../src/commands/controller/providers/codex-settings-metadata.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(lstat).mockImplementation(actual.lstat);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test.each([
  { field: "dev", duringRead: false },
  { field: "ino", duringRead: false },
  { field: "dev", duringRead: true },
  { field: "ino", duringRead: true },
] as const)("distinct 64-bit $field rejects a replacement when duringRead=$duringRead", async ({ field, duringRead }) => {
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".tmp", "codex-metadata-identity-")); roots.push(root);
  const home = await realpath(root), database = join(home, "state_5.sqlite"), rollout = join(home, "rollout.jsonl");
  await writeFile(rollout, "");
  const create = () => {
    const db = new Database(database);
    try {
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, model TEXT, reasoning_effort TEXT)");
      db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("own", rollout, home, "chosen", "high");
    } finally { db.close(); }
  };
  create();
  const original = 2n ** 53n, replacement = original + 1n;
  expect(original).not.toBe(replacement);
  expect(Number(original)).toBe(Number(replacement));
  let observations = 0, replaced = false;
  // Only stat IDs are controlled: the file type, replacement, paths and SQLite reads remain real.
  vi.mocked(lstat).mockImplementation((async (target, options) => {
    expect(target).toBe(database);
    if (++observations === (duringRead ? 4 : 3)) {
      await rename(database, database + ".old"); create(); replaced = true;
    }
    const entry = await actual.lstat(target, options), id = replaced ? replacement : original;
    const dev = field === "dev" ? id : 1n, ino = field === "ino" ? id : 1n;
    return Object.assign(entry, { dev: options?.bigint ? dev : Number(dev), ino: options?.bigint ? ino : Number(ino) });
  }) as typeof lstat);
  const poll = observeCodexMetadata(database, { threadId: "own", path: rollout, cwd: home }, { model: "chosen", effort: "high" });
  expect(await poll()).toBe(true);
  await expect(poll()).rejects.toThrow("unconfirmed");
  expect(replaced).toBe(true);
  expect((await actual.lstat(database + ".old")).isFile()).toBe(true);
});
