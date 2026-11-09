import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { createSkillFixture, skillTerminal, skillTerminalSessionsClosed } from "../../fixtures/skill-terminal.js";
import type { InstalledCliReceipt } from "../../fixtures/installed-cli.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); expect(skillTerminalSessionsClosed()).toBe(true); });
const fixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/review-terminal-module"); await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "terminal-")); roots.push(root);
  const f = await createSkillFixture(root, []), state = path.join(f.home, ".daynight"); await mkdir(state);
  return { ...f, state, config: path.join(state, "config.yml") };
};
const receipt = { launcherPath: process.execPath } as InstalledCliReceipt;
const command = { launcherPath: process.execPath, args: [path.resolve(import.meta.dirname, "../../../dist/main.js"), "review", "list"] };
const remote = "https://github.com/configuration-acceptance/repository.git";
const repositoryPrompt = "Review repository (HTTPS or SSH GitHub address):";
const pathPrompt = "Review clone path (blank for configured default):";

it("configures first review use through a terminal while preserving and hiding a saved credential", async () => {
  const f = await fixture(), secret = "existing-secret";
  await writeFile(f.config, `# existing credential\nserverToken: ${secret}\n`, { mode: 0o640 });
  const result = await skillTerminal(receipt, f, [
    { waitFor: repositoryPrompt, keys: [`${remote}\r`] }, { waitFor: pathPrompt, keys: ["\r"] },
  ], f.home, command);
  expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("github.com/configuration-acceptance/repository");
  expect(result.stderr).not.toContain("Server URL"); expect(result.stderr).not.toContain("Server token"); expect(result.stdout + result.stderr).not.toContain(secret);
  const saved = parse(await readFile(f.config, "utf8")); expect(saved).toMatchObject({ serverToken: secret, review: { repositories: [{ remote }] } }); expect(saved).not.toHaveProperty("serverUrl");
  if (process.platform !== "win32") expect((await lstat(f.config)).mode & 0o777).toBe(0o600);
}, 30_000);

it.skipIf(process.platform === "win32")("cancels the second terminal question on SIGTERM without changing the existing configuration", async () => {
  const f = await fixture(), original = "# unchanged\nserverToken: existing-credential\n";
  await writeFile(f.config, original);
  const hook = path.join(f.root, "signal-on-prompt.mjs");
  await writeFile(hook, `const write = process.stderr.write.bind(process.stderr);\nlet signalled = false;\nprocess.stderr.write = (chunk, ...args) => {\n  const result = write(chunk, ...args);\n  if (!signalled && String(chunk).includes(${JSON.stringify(pathPrompt)})) { signalled = true; setImmediate(() => process.kill(process.pid, 'SIGTERM')); }\n  return result;\n};\n`);
  const result = await skillTerminal(receipt, f, [
    { waitFor: repositoryPrompt, keys: [`${remote}\r`] },
  ], f.home, { launcherPath: process.execPath, args: ["--import", pathToFileURL(hook).href, ...command.args] });
  expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("Review configuration cancelled");
  expect(await readFile(f.config, "utf8")).toBe(original); expect(await readdir(f.state)).toEqual(["config.yml"]);
}, 30_000);
