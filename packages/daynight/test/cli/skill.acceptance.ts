import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { inspectInstalledSkill } from "../fixtures/skill-contract.js";
import { createSkillFixture, skillTerminal } from "../fixtures/skill-terminal.js";

const tree = async (directory: string): Promise<Record<string, Buffer | "directory">> => {
  const files: Record<string, Buffer | "directory"> = {};
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const relative = path.relative(directory, file).replaceAll("\\", "/");
      if (entry.isDirectory()) { files[`${relative}/`] = "directory"; await visit(file); }
      else files[relative] = await readFile(file);
    }
  };
  await visit(directory);
  return files;
};

it("ships and installs the complete using-daynight skill bundle", async () => {
  const installed = await createAcceptanceCli();
  try {
    const bundle = path.join(path.dirname(installed.receipt.entryPath), "commands/skill/skills/using-daynight");
    const source = path.resolve(import.meta.dirname, "../../src/commands/skill/skills/using-daynight");
    expect(await tree(bundle)).toEqual(await tree(source));
    const reviewRelative = "commands/review/skills/daynight-review";
    const reviewSource = await tree(path.resolve(import.meta.dirname, "../../src", reviewRelative));
    expect(reviewSource["SKILL.md"]).toBeDefined();
    expect(await tree(path.join(path.dirname(installed.receipt.entryPath), reviewRelative))).toEqual(reviewSource);
    await inspectInstalledSkill(bundle);
    const fixture = await createSkillFixture(path.join(installed.receipt.root, "skill installation"), ["claude"]);
    const result = await skillTerminal(installed.receipt, fixture, [
      { waitFor: "Install the using-daynight skill for which agents?", keys: [" ", "\r"] },
      { waitFor: "Where should the skill be installed?", keys: ["\r"] },
    ]);
    expect(result.code, result.stderr).toBe(0);
    const target = path.join(fixture.home, ".claude/skills/using-daynight");
    expect(await tree(target)).toEqual(await tree(bundle));
    await inspectInstalledSkill(target);
  } finally { await installed.cleanup(); }
});
