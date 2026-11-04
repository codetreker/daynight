import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBudgetToken, runProjectTaskAcceptance } from "../../scripts/project-task-acceptance.js";
import { runBudgetProbes } from "../../scripts/project-task-budgets.js";
import type { InstalledCliReceipt } from "../fixtures/installed-cli.js";

const directories: string[] = [];
const fixture = async (source: string) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/budget-credential-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "private-"));
  directories.push(directory);
  const file = path.join(directory, "credential.json");
  await writeFile(file, source, { mode: 0o600 });
  return { directory, file };
};
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("local CLI stress entrypoints", () => {
  it("refuses local stress work in CI before starting any installed or service fixtures", async () => {
    vi.stubEnv("CI", "true");
    try {
      await expect(runProjectTaskAcceptance("stress-budgets")).rejects.toThrow("run only on local machines");
      await expect(runBudgetProbes("stress-budgets", {} as InstalledCliReceipt, ".", "fixture-pat")).rejects.toThrow("run only on local machines");
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("normally issued budget credential handoff", () => {
  it("reads the opaque credential from the private parent-owned file", async () => {
    const token = "opaque-fixture-token_!~+/=:AZaz09";
    const { file } = await fixture(JSON.stringify({ serverToken: token }));
    expect(await readBudgetToken(file)).toBe(token);
  });

  it.each([
    '{"serverToken":"synthetic-sensitive-token',
    JSON.stringify({ serverToken: "synthetic-sensitive-token\n" }),
    JSON.stringify({ serverToken: "synthetic-sensitive-token value" }),
    JSON.stringify({ serverToken: "" }),
    JSON.stringify({ serverToken: null }),
    JSON.stringify({ serverToken: false }),
    JSON.stringify({ serverToken: [] }),
    JSON.stringify({ serverToken: {} }),
    JSON.stringify({ token: "synthetic-sensitive-token" }),
    "null", "[]",
  ])("rejects malformed credential metadata without retaining its secret %#", async (source) => {
    const { file } = await fixture(source);
    const error = await readBudgetToken(file).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("credential metadata is invalid");
    expect(String(error)).not.toContain("synthetic-sensitive-token");
    expect(error).not.toHaveProperty("cause");
  });

  it.skipIf(process.platform === "win32")("rejects public files and symlinks before reading credential data", async () => {
    const { directory, file } = await fixture('{"serverToken":"synthetic-sensitive-token"}');
    await chmod(file, 0o644);
    await expect(readBudgetToken(file)).rejects.toThrow("private regular file");
    await chmod(file, 0o600);
    const link = path.join(directory, "linked.json");
    await symlink(file, link);
    await expect(readBudgetToken(link)).rejects.toThrow("private regular file");
    await expect(readBudgetToken(directory)).rejects.toThrow("private regular file");
  });

  it("preserves missing-file errors rather than inventing a credential", async () => {
    const { directory } = await fixture("{}");
    await expect(readBudgetToken(path.join(directory, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([undefined, "", "invalid secret", "invalid\nsecret"])("rejects absent or unsafe credentials before starting any budget fixtures %#", async (token) => {
    await expect(runBudgetProbes("deadlines", {} as InstalledCliReceipt, ".", token as string)).rejects.toThrow("header-safe PAT");
  });
});
