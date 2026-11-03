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
  const source = path.join(packageDirectory, "dist/commands/skill/skills/using-daynight");
  await mkdir(path.join(source, "references"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\r\nname: using-daynight\r\ndescription: Read task work\r\n---\r\n# Skill 中文");
  await writeFile(path.join(source, "references/handbook.md"), "# Handbook\r\nCommands 中文\r\n");
  return { packageDirectory, source };
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

describe("root skill reading", () => {
  it.each([undefined, "SKILL.md", "references/handbook.md"])("writes exact installed resource bytes for %j without loading commands or user state", async (resource) => {
    const { packageDirectory, source } = await fixture();
    const { client, chunks, errors, close } = context(packageDirectory);
    const load = vi.fn(async () => { throw new Error("Command implementation must remain unloaded."); });
    expect(await runCli(["--skill", ...(resource === undefined ? [] : [resource])], client, [{ name: "future", description: "Future command", load }])).toBe(0);
    expect(Buffer.concat(chunks)).toEqual(await readFile(path.join(source, resource === undefined ? "SKILL.md" : resource)));
    expect(errors).toEqual([]);
    expect(close).toHaveBeenCalledExactlyOnceWith();
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ["--skill", "--help"], ["--skill", "--version"], ["--help", "--skill"],
    ["--skill", "references/handbook.md", "extra"], ["--skill", ""], ["--skill=references/handbook.md"],
    ["--skill", "../SKILL.md"], ["--skill", "/SKILL.md"], ["--skill", "references\\handbook.md"],
    ["--skill", "references//handbook.md"], ["--skill", "./SKILL.md"], ["--skill", "references/../SKILL.md"],
    ["--skill", "C:/SKILL.md"], ["--skill", "references/handbook.md\0"], ["--skill", "resource.bin"],
  ])("rejects invalid syntax and resource paths before reading a missing package: %j", async (...args) => {
    const { client, chunks, errors, close } = context(path.resolve("unavailable skill package"));
    expect(await runCli(args, client)).toBe(2);
    expect(errors.join("")).toContain("Run daynight --help for usage.");
    expect(errors.join("")).not.toContain("Cannot capture");
    expect(chunks).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it("rejects unknown resources from a valid bundle with a usage error and no output", async () => {
    const { packageDirectory } = await fixture();
    const { client, chunks, errors, close } = context(packageDirectory);
    expect(await runCli(["--skill", "references/unknown.md"], client)).toBe(2);
    expect(errors.join("")).toContain('Unknown using-daynight skill resource "references/unknown.md".');
    expect(chunks).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["missing", "frontmatter", "utf8"])("preserves %s resource errors before output", async (failure) => {
    const { packageDirectory, source } = await fixture();
    if (failure === "missing") await rm(path.join(source, "SKILL.md"));
    if (failure === "frontmatter") await writeFile(path.join(source, "SKILL.md"), "# Missing frontmatter\n");
    if (failure === "utf8") await writeFile(path.join(source, "references/handbook.md"), Buffer.from([0xff]));
    const { client, chunks, errors } = context(packageDirectory);
    expect(await runCli(["--skill", ...(failure === "utf8" ? ["references/handbook.md"] : [])], client)).toBe(1);
    expect(errors.join("")).toContain("Caused by:");
    expect(errors.join("")).toContain(failure === "utf8" ? "must be valid UTF-8" : "Cannot capture installed using-daynight skill bundle");
    expect(chunks).toEqual([]);
  });

  it("preserves output failure and cleanup failure together", async () => {
    const { packageDirectory } = await fixture();
    const { client } = context(packageDirectory);
    const output = new Error("Output failed"), cleanup = new Error("Cleanup failed");
    client.stdoutBytes = async () => { throw output; };
    client.closeStdoutBytes = async () => { throw cleanup; };
    await expect(runSkillRead(undefined, client)).rejects.toMatchObject({ cause: output, errors: [output, cleanup] });
  });
});
