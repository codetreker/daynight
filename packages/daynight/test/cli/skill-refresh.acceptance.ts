import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { inspectInstalledSkill } from "../fixtures/skill-contract.js";
import { createSkillFixture } from "../fixtures/skill-terminal.js";

const execute = promisify(execFile);

it("refreshes installed User and Project guidance through the packed update helper", async () => {
  const installed = await createAcceptanceCli();
  try {
    const fixture = await createSkillFixture(path.join(installed.receipt.root, "Skill refresh 中文"), []);
    const project = path.join(fixture.root, "project");
    await mkdir(project);
    await execute("git", ["init", "--quiet", project], { timeout: 10_000, windowsHide: true });
    const targets = [path.join(fixture.home, ".agents/skills/using-daynight"), path.join(project, ".claude/skills/using-daynight")];
    for (const target of targets) {
      await mkdir(path.join(target, "references"), { recursive: true });
      await writeFile(path.join(target, "SKILL.md"), "Old installed guidance\n");
      await writeFile(path.join(target, "references/steps.md"), "daynight task step list <task-id>\n");
    }
    const helper = path.join(path.dirname(installed.receipt.entryPath), "commands/skill/refresh-installed.js");
    const result = await execute(installed.receipt.nodePath, [helper], { cwd: project, env: fixture.environment, timeout: 30_000, windowsHide: true });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Updated Codex: User");
    expect(result.stdout).toContain("Updated Claude Code: Project");
    for (const target of targets) {
      const skill = await inspectInstalledSkill(target);
      expect(skill.documents.has("references/steps.md")).toBe(false);
      expect([...skill.documents.values()].join("\n")).not.toContain("daynight task step");
    }
  } finally { await installed.cleanup(); }
});
