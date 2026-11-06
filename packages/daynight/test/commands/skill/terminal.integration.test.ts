import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSkillFixture, skillTerminal, skillTerminalSessionsClosed } from "../../fixtures/skill-terminal.js";
import type { InstalledCliReceipt } from "../../fixtures/installed-cli.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); expect(skillTerminalSessionsClosed()).toBe(true); });
const fixture = async (agents: readonly string[]) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/skill-terminal-module");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "terminal-")); roots.push(root);
  return createSkillFixture(root, agents);
};
const main = path.resolve(import.meta.dirname, "../../../dist/main.js");
const receipt = { launcherPath: process.execPath } as InstalledCliReceipt;
const command = { launcherPath: process.execPath, args: [main, "skill", "install"] };
const agentsPrompt = "Install the using-daynight skill for which agents?";
const scopePrompt = "Where should the skill be installed?";
const down = "\u001b[B";

it("uses a real terminal to require a selection and install at default User scope", async () => {
  const f = await fixture(["claude"]);
  const result = await skillTerminal(receipt, f, [
    { waitFor: agentsPrompt, keys: ["\r"] },
    { waitFor: "Select at least one agent.", keys: [" ", "\r"] },
    { waitFor: scopePrompt, keys: ["\r"] },
  ], f.home, command);
  expect(result.code, result.stderr).toBe(0);
  const target = path.join(f.home, ".claude/skills/using-daynight");
  expect(result.stdout).toContain(`Installed Claude Code: User using-daynight skill at ${target}`);
  expect(await readFile(path.join(target, "SKILL.md"))).toEqual(await readFile(path.resolve(import.meta.dirname, "../../../dist/commands/skill/skills/using-daynight/SKILL.md")));
  await expect(lstat(path.join(f.home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(f.agentLog)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("selects shared agents and Project scope from a real Git subdirectory", async () => {
  const f = await fixture(["codex", "copilot", "claude"]);
  const project = path.join(f.root, "project 中文"), child = path.join(project, "src"); await mkdir(child, { recursive: true });
  execFileSync("git", ["init", "-q", project], { env: f.environment });
  const result = await skillTerminal(receipt, f, [
    { waitFor: agentsPrompt, keys: [" ", down, " ", "\r"] },
    { waitFor: scopePrompt, keys: [down, "\r"] },
  ], child, command);
  expect(result.code, result.stderr).toBe(0);
  const target = path.join(project, ".agents/skills/using-daynight");
  expect(result.stdout).toContain(`Installed Codex: Project using-daynight skill at ${target}`);
  expect(result.stdout).toContain(`Installed Copilot CLI: Project using-daynight skill at ${target}`);
  expect(result.stdout).toContain("shared installation"); expect(result.stdout).not.toContain("Installed Claude Code");
  expect(await readFile(path.join(target, "SKILL.md"))).toEqual(await readFile(path.resolve(import.meta.dirname, "../../../dist/commands/skill/skills/using-daynight/SKILL.md")));
  expect(await readdir(f.home)).toEqual([]); await expect(lstat(f.agentLog)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it.each(["agents", "scope"] as const)("cancels the %s terminal selector without installation", async (stage) => {
  const f = await fixture(["codex", "copilot", "claude"]);
  const actions = stage === "agents" ? [{ waitFor: agentsPrompt, keys: ["\u0003"] }]
    : [{ waitFor: agentsPrompt, keys: [" ", "\r"] }, { waitFor: scopePrompt, keys: ["\u0003"] }];
  const result = await skillTerminal(receipt, f, actions, f.home, command);
  expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("Operation cancelled.");
  expect(await readdir(f.home)).toEqual([]); await expect(lstat(f.agentLog)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("hands terminal input from text to a selection and back without consuming answers", async () => {
  const f = await fixture([]);
  const result = await skillTerminal(receipt, f, [
    { waitFor: "First input:", keys: ["first-value\r"] },
    { waitFor: "Choose a value?", keys: [down, "\r"] },
    { waitFor: "Last input:", keys: ["last-value\r"] },
  ], f.home, { launcherPath: process.execPath, args: [path.resolve(import.meta.dirname, "terminal-handoff.mjs"), path.resolve(import.meta.dirname, "../../../dist/cli/prompts.js")] });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ first: "first-value", choice: "two", last: "last-value" });
  expect(await readdir(f.home)).toEqual([]);
}, 30_000);
