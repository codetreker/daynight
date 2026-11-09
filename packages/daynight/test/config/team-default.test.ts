import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfigurationDocument } from "../../src/config/document.js";
import { resolveConfigurationPaths } from "../../src/config/paths.js";
import { readTeamDefaultSnapshot, writeTeamDefault } from "../../src/config/team-default.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

const origin = "https://example.test";
const user = "80be22c3-96d8-4ed1-bcd3-b820f2508c62";
const otherUser = "a0be22c3-96d8-4ed1-bcd3-b820f2508c62";
const target = "b95baeff-1522-4d99-a9b4-dfcb58392eca";
const otherTarget = "c95baeff-1522-4d99-a9b4-dfcb58392eca";
const observed = { serverUrl: origin, serverToken: "credential" };
const signal = new AbortController().signal;
const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(filesystem.rename).mockReset();
  vi.mocked(filesystem.unlink).mockReset();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const fixture = async (tail = "") => {
  const parent = path.resolve(import.meta.dirname, "../../../../.tmp/team-default-tests");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, "config-"));
  dirs.push(dir);
  const paths = resolveConfigurationPaths(dir, path, {});
  await mkdir(paths.stateDirectory);
  const source = `# connection\nserverUrl: ${origin}\nserverToken: credential\n${tail}`;
  await writeFile(paths.configFile, source);
  return { paths, source };
};

describe("Team default configuration", () => {
  it("preserves comments, unknown values and other origin/account pairs while securing the credential", async () => {
    const { paths } = await fixture(`future: &future { flag: true }\nmore: *future\nteamDefaults:\n  ${origin}:\n    ${otherUser}: ${otherTarget} # retain\n  https://else.test:\n    ${user}: ${otherTarget}\n`);
    await chmod(paths.configFile, 0o644);
    const snapshot = await readTeamDefaultSnapshot(paths, observed, user, signal);
    await writeTeamDefault(paths, observed, user, snapshot, target, signal);
    const source = await readFile(paths.configFile, "utf8");
    const root = parseConfigurationDocument(source, paths).mapping;
    expect(source).toContain("# connection");
    expect(source).toContain("# retain");
    expect(source).toContain("more: *future");
    expect(root.teamDefaults).toEqual({ [origin]: { [user]: target, [otherUser]: otherTarget }, "https://else.test": { [user]: otherTarget } });
    if (process.platform !== "win32") expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
  });

  it("repairs an invalid pair without requiring the old value to parse as a Team", async () => {
    const { paths } = await fixture(`teamDefaults:\n  ${origin}:\n    ${user}: invalid\n`);
    const snapshot = await readTeamDefaultSnapshot(paths, observed, user, signal);
    expect(snapshot).toEqual({ present: true, value: "invalid" });
    await writeTeamDefault(paths, observed, user, snapshot, target, signal);
    expect(await readTeamDefaultSnapshot(paths, observed, user, signal)).toEqual({ present: true, value: target });
  });

  it("secures a token file even when the pair is unchanged and preserves its YAML aliases", async () => {
    const { paths, source } = await fixture(`teamDefaults:\n  ${origin}:\n    ${user}: &value ${target} # retained\n    ${otherUser}: *value\n`);
    await chmod(paths.configFile, 0o644);
    const snapshot = await readTeamDefaultSnapshot(paths, observed, user, signal);
    await writeTeamDefault(paths, observed, user, snapshot, target, signal);
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    if (process.platform !== "win32") expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
  });

  it.each(["token", "origin", "pair"])("refuses a concurrent %s change without overwriting it", async (change) => {
    const { paths, source } = await fixture();
    const snapshot = await readTeamDefaultSnapshot(paths, observed, user, signal);
    const replacement = change === "token" ? source.replace("credential", "new-token") : change === "origin" ? source.replace(origin, "https://new.test") : `${source}teamDefaults:\n  ${origin}:\n    ${user}: ${otherTarget}\n`;
    await writeFile(paths.configFile, replacement);
    await expect(writeTeamDefault(paths, observed, user, snapshot, target, signal)).rejects.toThrow("changed during the Team operation");
    expect(await readFile(paths.configFile, "utf8")).toBe(replacement);
  });

  it("retains the pair after credential rotation when the new credential is observed", async () => {
    const { paths, source } = await fixture(`teamDefaults:\n  ${origin}:\n    ${user}: ${otherTarget}\n`);
    await writeFile(paths.configFile, source.replace("credential", "new-token"));
    const rotated = { ...observed, serverToken: "new-token" };
    const snapshot = await readTeamDefaultSnapshot(paths, rotated, user, signal);
    expect(snapshot).toEqual({ present: true, value: otherTarget });
    await writeTeamDefault(paths, rotated, user, snapshot, target, signal);
    expect(await readTeamDefaultSnapshot(paths, rotated, user, signal)).toEqual({ present: true, value: target });
  });

  it.each(["origin", "root", "scalar"])("rejects an alias at %s that would change another value", async (kind) => {
    const tail = kind === "origin"
      ? `teamDefaults:\n  ${origin}: &accounts\n    ${user}: ${otherTarget}\n  https://else.test: *accounts\n`
      : kind === "root"
        ? `teamDefaults: &defaults\n  ${origin}:\n    ${user}: ${otherTarget}\nfuture: *defaults\n`
        : `teamDefaults:\n  ${origin}:\n    ${user}: &value ${otherTarget}\n    ${otherUser}: *value\n`;
    const { paths, source } = await fixture(tail);
    const snapshot = await readTeamDefaultSnapshot(paths, observed, user, signal);
    await expect(writeTeamDefault(paths, observed, user, snapshot, target, signal)).rejects.toThrow("shared YAML aliases that would change unrelated settings");
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
  });

  it.skipIf(process.platform === "win32")("rejects symlinked configuration writes", async () => {
    const { paths, source } = await fixture();
    const snapshot = await readTeamDefaultSnapshot(paths, observed, user, signal);
    const actual = `${paths.configFile}.actual`;
    await writeFile(actual, source);
    await rm(paths.configFile);
    await symlink(actual, paths.configFile);
    await expect(writeTeamDefault(paths, observed, user, snapshot, target, signal)).rejects.toThrow("must be a regular file");
    expect(await readFile(actual, "utf8")).toBe(source);
  });

  it("observes the current pair after replacement succeeds but lock cleanup fails", async () => {
    const { paths } = await fixture();
    const snapshot = await readTeamDefaultSnapshot(paths, observed, user, signal);
    vi.mocked(filesystem.unlink).mockRejectedValueOnce(new Error("lock cleanup denied"));
    await expect(writeTeamDefault(paths, observed, user, snapshot, target, signal)).rejects.toThrow("current saved pair matches");
    expect(await readTeamDefaultSnapshot(paths, observed, user, signal)).toEqual({ present: true, value: target });
  });
});
