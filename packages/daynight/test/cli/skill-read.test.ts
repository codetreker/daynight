import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/application.js";
import type { CliContext } from "../../src/cli/context.js";
import { runSkillRead } from "../../src/commands/skill/read.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const fixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/skill-read");
  await mkdir(temporary, { recursive: true });
  const packageDirectory = await mkdtemp(path.join(temporary, "package 中文-"));
  directories.push(packageDirectory);
  const manual = path.join(packageDirectory, "dist/commands/skill/usage.md");
  await mkdir(path.dirname(manual), { recursive: true });
  await writeFile(manual, "---\r\nname: daynight\r\ndescription: Use the Daynight CLI\r\n---\r\n# Manual 中文");
  return { packageDirectory, manual };
};
const context = (packageDirectory: string) => {
  const denied = (): never => { throw new Error("User state must remain untouched."); };
  const chunks: Buffer[] = [], errors: string[] = [];
  const close = vi.fn(async () => {});
  const client: CliContext = {
    version: "1.2.3", packageDirectory,
    homeDirectory: denied, workingDirectory: denied, stdout: denied,
    stdoutBytes: async (chunk) => { chunks.push(Buffer.from(chunk)); }, closeStdoutBytes: close,
    stderr: (message) => { errors.push(message); },
    get prompt() { return denied(); },
  };
  return { client, chunks, errors, close };
};

describe("root CLI usage reading", () => {
  it("writes the exact installed manual bytes without loading commands, skill bundles or user state", async () => {
    const { packageDirectory, manual } = await fixture();
    const { client, chunks, errors, close } = context(packageDirectory);
    const load = vi.fn(async () => { throw new Error("Command implementation must remain unloaded."); });
    expect(await runCli(["--skill"], client, [{ name: "future", description: "Future command", load }])).toBe(0);
    expect(Buffer.concat(chunks)).toEqual(await readFile(manual));
    expect(errors).toEqual([]);
    expect(close).toHaveBeenCalledExactlyOnceWith();
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ["--skill", "--help"], ["--skill", "--version"], ["--help", "--skill"], ["--skill", "--skill"],
    ["--skill", "SKILL.md"], ["--skill", "references/handbook.md"], ["--skill", "extra"], ["--skill", ""],
    ["--skill=references/handbook.md"], ["skill", "--skill"],
  ])("rejects extra arguments before reading an unavailable package: %j", async (...args) => {
    const { client, chunks, errors, close } = context(path.resolve("unavailable usage package"));
    expect(await runCli(args, client)).toBe(2);
    expect(errors.join("")).toContain("for usage.");
    expect(errors.join("")).not.toContain("Cannot read");
    expect(chunks).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["missing", "utf8"])("preserves %s manual failures before output", async (failure) => {
    const { packageDirectory, manual } = await fixture();
    if (failure === "missing") await rm(manual);
    else await writeFile(manual, Buffer.from([0xff]));
    const { client, chunks, errors } = context(packageDirectory);
    expect(await runCli(["--skill"], client)).toBe(1);
    expect(errors.join("")).toContain("Caused by:");
    expect(errors.join("")).toContain("Cannot read the installed Daynight CLI usage manual");
    expect(chunks).toEqual([]);
  });

  it("preserves output failure and cleanup failure together", async () => {
    const { packageDirectory } = await fixture();
    const { client } = context(packageDirectory);
    const output = new Error("Output failed"), cleanup = new Error("Cleanup failed");
    client.stdoutBytes = async () => { throw output; };
    client.closeStdoutBytes = async () => { throw cleanup; };
    await expect(runSkillRead(client)).rejects.toMatchObject({ cause: output, errors: [output, cleanup] });
  });
});
