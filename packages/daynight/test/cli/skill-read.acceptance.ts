import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createSkillFixture, skillPipe } from "../fixtures/skill-terminal.js";

let installed: Awaited<ReturnType<typeof createAcceptanceCli>>;
beforeAll(async () => { installed = await createAcceptanceCli(); });
afterAll(async () => { await installed?.cleanup(); });
const manual = (): string => path.join(path.dirname(installed.receipt.entryPath), "commands/skill/usage.md");

it("reads the packed standalone manual through both aliases without configuration, Git, installed skills or agent execution", async () => {
  const fixture = await createSkillFixture(path.join(installed.receipt.root, "CLI usage reading 中文"), []);
  const source = path.resolve(import.meta.dirname, "../../src/commands/skill/skills/using-daynight/references/manual.md");
  const contents = await readFile(source);
  expect(await readFile(manual())).toEqual(contents);
  expect(await readFile(path.join(path.dirname(installed.receipt.entryPath), "commands/skill/skills/using-daynight/references/manual.md"))).toEqual(contents);
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
