import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../../../src/cli/context.js";
import { findSkillProjectRoot, refreshInstalledSkills } from "../../../src/commands/skill/refresh.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const signal = (): AbortSignal => new AbortController().signal;
const link = (target: string, filename: string): Promise<void> => fs.symlink(target, filename, process.platform === "win32" ? "junction" : "dir");
const fixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/skill-refresh");
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, "refresh 中文-"));
  directories.push(directory);
  const home = path.join(directory, "home");
  const project = path.join(directory, "project");
  const cwd = path.join(project, "subdirectory");
  const packageDirectory = path.join(directory, "package");
  const source = path.join(packageDirectory, "dist/commands/skill/skills/using-daynight");
  await fs.mkdir(home);
  await fs.mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", project], { stdio: "pipe" });
  await fs.mkdir(path.join(source, "references"), { recursive: true });
  const entrypoint = "---\nname: using-daynight\ndescription: Current guidance\n---\nNew bundle\n";
  await fs.writeFile(path.join(source, "SKILL.md"), entrypoint);
  await fs.writeFile(path.join(source, "references/manual.md"), "New manual\n");
  const output: string[] = [];
  const errors: string[] = [];
  const context: CliContext = {
    version: "2.0.0", packageDirectory, homeDirectory: () => home, workingDirectory: () => cwd,
    stdout: (text) => { output.push(text); }, stderr: (text) => { errors.push(text); }, stdoutBytes: async () => {},
  };
  const seed = async (base: string, agentDirectory: string): Promise<string> => {
    const target = path.join(base, agentDirectory, "skills/using-daynight");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), "Local edits\n");
    await fs.writeFile(path.join(target, "obsolete"), "old resource");
    return target;
  };
  return { directory, home, project, source, context, output, errors, entrypoint, seed };
};

describe("refresh existing agent skills", () => {
  it("refreshes existing User and Project copies without launchers, removes stale resources and leaves absent copies absent", async () => {
    const f = await fixture();
    const user = await f.seed(f.home, ".agents");
    const project = await f.seed(f.project, ".claude");
    await fs.mkdir(path.join(f.home, ".agents/skills/unrelated"));
    await fs.writeFile(path.join(f.home, ".agents/skills/unrelated/keep"), "sibling");
    await refreshInstalledSkills(f.context, signal());
    for (const target of [user, project]) {
      expect((await fs.readdir(target)).sort()).toEqual(["SKILL.md", "references"]);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(f.entrypoint);
      expect(await fs.readFile(path.join(target, "references/manual.md"), "utf8")).toBe("New manual\n");
    }
    await expect(fs.lstat(path.join(f.home, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(f.project, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.home, ".agents/skills/unrelated/keep"), "utf8")).toBe("sibling");
    expect(f.output.join("")).toContain("Updated Codex: User");
    expect(f.output.join("")).toContain("Updated Copilot CLI: User");
    expect(f.output.join("")).toContain("Updated Claude Code: Project");
    expect(f.errors).toEqual([]);
  });

  it("does not capture a bundle or create directories when no installed skill exists", async () => {
    const f = await fixture();
    await fs.rm(f.source, { recursive: true });
    f.context.workingDirectory = () => path.parse(f.home).root;
    await refreshInstalledSkills(f.context, signal());
    expect(await fs.readdir(f.home)).toEqual([]);
    expect(f.output).toEqual([]);
    expect(await findSkillProjectRoot(path.parse(f.home).root, signal())).toBeUndefined();
  });

  it("deduplicates physical copies across agents and scopes while retaining each scope result", async () => {
    const f = await fixture();
    const user = await f.seed(f.home, ".agents");
    await fs.mkdir(path.join(f.home, ".claude"));
    await fs.mkdir(path.join(f.project, ".agents"));
    await fs.mkdir(path.join(f.project, ".claude"));
    for (const base of [f.home, f.project]) for (const agent of [".agents", ".claude"]) {
      const filename = path.join(base, agent, "skills");
      if (filename !== path.dirname(user)) await link(path.dirname(user), filename);
    }
    await refreshInstalledSkills(f.context, signal());
    expect(f.output).toHaveLength(6);
    expect(await fs.readdir(path.dirname(user))).toEqual(["using-daynight"]);
    expect((await fs.lstat(path.join(f.project, ".claude/skills"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(user, "SKILL.md"), "utf8")).toBe(f.entrypoint);
  });

  it.each([false, true])("repairs an existing leaf symlink without modifying its referent, dangling=%s", async (dangling) => {
    const f = await fixture();
    const parent = path.join(f.home, ".agents/skills");
    const outside = path.join(f.directory, "linked contents");
    await fs.mkdir(parent, { recursive: true });
    if (!dangling) { await fs.mkdir(outside); await fs.writeFile(path.join(outside, "keep"), "external"); }
    const leaf = path.join(parent, "using-daynight");
    await link(outside, leaf);
    await refreshInstalledSkills(f.context, signal());
    expect((await fs.lstat(leaf)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(leaf, "SKILL.md"), "utf8")).toBe(f.entrypoint);
    if (!dangling) expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("external");
    else await expect(fs.lstat(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores a nested candidate that has no installed skill", async () => {
    const f = await fixture();
    const user = await f.seed(f.home, ".agents");
    await fs.mkdir(path.join(user, "references"));
    await fs.mkdir(path.join(f.home, ".claude"));
    await link(path.join(user, "references"), path.join(f.home, ".claude/skills"));
    await refreshInstalledSkills(f.context, signal());
    expect(await fs.readFile(path.join(user, "SKILL.md"), "utf8")).toBe(f.entrypoint);
    await expect(fs.lstat(path.join(user, "references/using-daynight"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.output).toHaveLength(2);
  });

  it("rejects destructive overlap across User and Project before changing either copy", async () => {
    const f = await fixture();
    const project = await f.seed(f.project, ".claude");
    await fs.mkdir(path.join(f.home, ".agents"));
    await link(project, path.join(f.home, ".agents/skills"));
    await fs.mkdir(path.join(project, "using-daynight"));
    await fs.writeFile(path.join(project, "using-daynight/SKILL.md"), "nested");
    await expect(refreshInstalledSkills(f.context, signal())).rejects.toThrow("overlapping skill targets");
    expect(await fs.readFile(path.join(project, "SKILL.md"), "utf8")).toBe("Local edits\n");
    expect(await fs.readFile(path.join(project, "using-daynight/SKILL.md"), "utf8")).toBe("nested");
    expect(f.output).toEqual([]);
  });

  it("fails before writes when an installed target is not a directory or link", async () => {
    const f = await fixture();
    const existing = await f.seed(f.home, ".agents");
    const invalidParent = path.join(f.project, ".claude/skills");
    await fs.mkdir(invalidParent, { recursive: true });
    await fs.writeFile(path.join(invalidParent, "using-daynight"), "invalid leaf");
    await expect(refreshInstalledSkills(f.context, signal())).rejects.toThrow("must be a directory or symbolic link");
    expect(await fs.readFile(path.join(existing, "SKILL.md"), "utf8")).toBe("Local edits\n");
  });

  it("preserves the installed copy when the package bundle is invalid", async () => {
    const f = await fixture();
    const target = await f.seed(f.home, ".agents");
    await fs.writeFile(path.join(f.source, "SKILL.md"), "invalid bundle");
    await expect(refreshInstalledSkills(f.context, signal())).rejects.toThrow("Cannot capture installed");
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("Local edits\n");
  });

  it.each(["missing", "directory", "whitespace", "unicode whitespace", "invalid UTF-8"])("keeps every existing copy when the source manual is %s", async (damage) => {
    const f = await fixture();
    const user = await f.seed(f.home, ".agents");
    const project = await f.seed(f.project, ".claude");
    for (const target of [user, project]) {
      await fs.mkdir(path.join(target, "references"));
      await fs.writeFile(path.join(target, "references/autopilot-managed-task.md"), "old workflow\n");
    }
    const manual = path.join(f.source, "references/manual.md");
    if (damage === "missing" || damage === "directory") {
      await fs.rm(manual);
      if (damage === "directory") await fs.mkdir(manual);
    } else await fs.writeFile(manual, damage === "whitespace" ? " \n\t" : damage === "unicode whitespace" ? "\u0085" : Buffer.from([0xff]));
    await expect(refreshInstalledSkills(f.context, signal())).rejects.toThrow("Cannot capture installed");
    for (const target of [user, project]) {
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("Local edits\n");
      expect(await fs.readFile(path.join(target, "obsolete"), "utf8")).toBe("old resource");
      expect(await fs.readFile(path.join(target, "references/autopilot-managed-task.md"), "utf8")).toBe("old workflow\n");
    }
    expect(f.output).toEqual([]);
  });

  it("reports Git discovery failures rather than treating a damaged repository as absent", async () => {
    const f = await fixture();
    const target = await f.seed(f.home, ".agents");
    await fs.rm(path.join(f.project, ".git"), { recursive: true });
    await fs.writeFile(path.join(f.project, ".git"), "invalid Git marker");
    await expect(refreshInstalledSkills(f.context, signal())).rejects.toThrow("Cannot locate a Git repository");
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("Local edits\n");
  });

  it("honors cancellation before discovery and replacement", async () => {
    const f = await fixture();
    const target = await f.seed(f.home, ".agents");
    const controller = new AbortController();
    const failure = new Error("cancelled refresh");
    controller.abort(failure);
    await expect(refreshInstalledSkills(f.context, controller.signal)).rejects.toBe(failure);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("Local edits\n");
  });
});
