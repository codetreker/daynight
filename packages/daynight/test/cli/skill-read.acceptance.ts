import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createInstalledCli } from "../fixtures/installed-cli.js";
import { createSkillFixture, skillPipe } from "../fixtures/skill-terminal.js";
import { captureSkillBundle } from "../../src/platform/skill-bundle.js";

let installed: Awaited<ReturnType<typeof createInstalledCli>>;
beforeAll(async () => { installed = await createInstalledCli(); });
afterAll(async () => { await installed?.cleanup(); });
const bundle = (): string => path.join(path.dirname(installed.receipt.entryPath), "commands/skill/skills/using-daynight");

it("reads the packed entrypoint and every Markdown resource through both aliases without configuration, Git or agent execution", async () => {
  const fixture = await createSkillFixture(path.join(installed.receipt.root, "skill reading 中文"), []);
  const resources = (await captureSkillBundle(bundle(), "Installed skill")).filter((entry) => entry.type === "file" && entry.relativePath.endsWith(".md"));
  const alias = path.join(path.dirname(installed.receipt.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn");
  for (const launcherPath of [installed.receipt.launcherPath, alias]) {
    const receipt = { ...installed.receipt, launcherPath };
    const entrypoint = await skillPipe(receipt, fixture, ["--skill"]);
    expect(entrypoint.code, entrypoint.stderr).toBe(0);
    expect(entrypoint.stderr).toBe("");
    expect(Buffer.from(entrypoint.stdout)).toEqual(await readFile(path.join(bundle(), "SKILL.md")));
    for (const entry of resources) {
      if (entry.type !== "file") throw new Error("Expected a file resource.");
      const result = await skillPipe(receipt, fixture, ["--skill", entry.relativePath]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(Buffer.from(result.stdout)).toEqual(entry.contents);
    }
  }
  expect(await readdir(fixture.home)).toEqual([]);
  await expect(lstat(fixture.agentLog)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves invalid user configuration and rejects invalid resources without stdout or installation", async () => {
  const fixture = await createSkillFixture(path.join(installed.receipt.root, "skill reading errors"), ["codex", "copilot", "claude"]);
  await mkdir(path.join(fixture.home, ".daynight"));
  const configuration = path.join(fixture.home, ".daynight/config.yml");
  await writeFile(configuration, "serverUrl: [\n");
  const success = await skillPipe(installed.receipt, fixture, ["--skill", "references/handbook.md"]);
  expect(success.code, success.stderr).toBe(0);
  expect(Buffer.from(success.stdout)).toEqual(await readFile(path.join(bundle(), "references/handbook.md")));
  for (const args of [["--skill", "../SKILL.md"], ["--skill", "references/unknown.md"], ["--skill", "--help"], ["--skill", "references/handbook.md", "extra"], ["skill", "--skill"]]) {
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

it("reports an incomplete installed bundle as an execution error and preserves its cause", async () => {
  const fixture = await createSkillFixture(path.join(installed.receipt.root, "skill reading missing bundle"), []);
  const entrypointPath = path.join(bundle(), "SKILL.md");
  const entrypoint = await readFile(entrypointPath);
  try {
    await rm(entrypointPath);
    const result = await skillPipe(installed.receipt, fixture, ["--skill"]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot capture installed using-daynight skill bundle");
    expect(result.stderr).toContain("Caused by:");
    expect(await readdir(fixture.home)).toEqual([]);
  } finally { await writeFile(entrypointPath, entrypoint); }
});
