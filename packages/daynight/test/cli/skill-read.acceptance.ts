import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createInstalledCli } from "../fixtures/installed-cli.js";
import { createSkillFixture, skillPipe } from "../fixtures/skill-terminal.js";

let installed: Awaited<ReturnType<typeof createInstalledCli>>;
beforeAll(async () => { installed = await createInstalledCli(); });
afterAll(async () => { await installed?.cleanup(); });
const manual = (): string => path.join(path.dirname(installed.receipt.entryPath), "commands/skill/usage.md");

it("reads the packed standalone manual through both aliases without configuration, Git, installed skills or agent execution", async () => {
  const fixture = await createSkillFixture(path.join(installed.receipt.root, "CLI usage reading 中文"), []);
  const source = path.resolve(import.meta.dirname, "../../src/commands/skill/usage.md");
  const contents = await readFile(source);
  expect(await readFile(manual())).toEqual(contents);
  expect(contents.toString("utf8")).toContain("--assigned-to");
  expect(contents.toString("utf8")).toContain("--clear-assigned-to");
  const alias = path.join(path.dirname(installed.receipt.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn");
  for (const launcherPath of [installed.receipt.launcherPath, alias]) {
    const result = await skillPipe({ ...installed.receipt, launcherPath }, fixture, ["--skill"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(Buffer.from(result.stdout)).toEqual(contents);
  }
  expect(await readdir(fixture.home)).toEqual([]);
  await expect(lstat(fixture.agentLog)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves invalid user configuration and rejects extra arguments without stdout or installation", async () => {
  const fixture = await createSkillFixture(path.join(installed.receipt.root, "CLI usage reading errors"), ["codex", "copilot", "claude"]);
  await mkdir(path.join(fixture.home, ".daynight"));
  const configuration = path.join(fixture.home, ".daynight/config.yml");
  await writeFile(configuration, "serverUrl: [\n");
  const success = await skillPipe(installed.receipt, fixture, ["--skill"]);
  expect(success.code, success.stderr).toBe(0);
  expect(Buffer.from(success.stdout)).toEqual(await readFile(manual()));
  for (const args of [["--skill", "SKILL.md"], ["--skill", "references/handbook.md"], ["--skill", "--help"], ["--skill", "extra"], ["skill", "--skill"]]) {
    const result = await skillPipe(installed.receipt, fixture, args);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("for usage.");
  }
  expect(await readFile(configuration, "utf8")).toBe("serverUrl: [\n");
  expect(await readdir(fixture.home)).toEqual([".daynight"]);
  expect(await readdir(path.join(fixture.home, ".daynight"))).toEqual(["config.yml"]);
  await expect(lstat(fixture.agentLog)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports a missing installed manual as an execution error and preserves its cause", async () => {
  const fixture = await createSkillFixture(path.join(installed.receipt.root, "CLI usage missing manual"), []);
  const contents = await readFile(manual());
  try {
    await rm(manual());
    const result = await skillPipe(installed.receipt, fixture, ["--skill"]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot read the installed Daynight CLI usage manual");
    expect(result.stderr).toContain("Caused by:");
    expect(await readdir(fixture.home)).toEqual([]);
  } finally { await writeFile(manual(), contents); }
});
