import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createOperation } from "../../src/api/operation.js";
import { identifyToolLauncher } from "../../src/platform/tool-launchers.js";
import { resolveToolLaunch, toolCommand } from "../../src/platform/tool-executables.js";
import { removeFixtureRoot } from "../helpers/tool-fixture-cleanup.js";

const fixtures = new URL("./fixtures/tool-launchers/", import.meta.url);
const roots: string[] = [];
const operations: ReturnType<typeof createOperation>[] = [];
const operation = () => { const result = createOperation(); operations.push(result); return result; };
const root = async () => {
  await mkdir(".tmp", { recursive: true });
  const result = await realpath(await mkdtemp(path.resolve(".tmp/tool-launcher-")));
  roots.push(result); return result;
};
const put = async (file: string, value: string | Buffer) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); return file; };
const manifest = (file: string, value: unknown) => put(file, JSON.stringify(value));
const native = (file: string) => put(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
const host = { platform: "darwin" as const, arch: "arm64", nonGlibcLinux: false };
const copilot = async (directory: string) => {
  const packageRoot = path.join(directory, "node_modules/@github/copilot");
  const entry = await put(path.join(packageRoot, "npm-loader.js"), "#!/usr/bin/env node\nthrow new Error('must not execute the loader');\n");
  await manifest(path.join(packageRoot, "package.json"), { name: "@github/copilot", bin: { copilot: "npm-loader.js" } });
  return { packageRoot, entry };
};
const copilotNative = async (directory: string, platform = "darwin", arch = "arm64") => {
  const packageRoot = path.join(directory, `node_modules/@github/copilot-${platform}-${arch}`);
  const entry = await native(path.join(packageRoot, platform === "win32" ? "copilot.exe" : "copilot"));
  await manifest(path.join(packageRoot, "package.json"), { name: `@github/copilot-${platform}-${arch}`, exports: { ".": `./${path.basename(entry)}` } });
  return entry;
};
const codex = async (directory: string) => {
  const packageRoot = path.join(directory, "node_modules/@openai/codex");
  const entry = await put(path.join(packageRoot, "custom/loader.js"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const result = spawnSync(path.join(__dirname, "../different-layout/native", process.platform === "win32" ? "codex.exe" : "codex"), process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
  await manifest(path.join(packageRoot, "package.json"), { name: "@openai/codex", bin: { codex: "custom/loader.js" } });
  return { packageRoot, entry };
};
const codexRuntime = (packageRoot: string) => path.join(packageRoot, "different-layout/native", process.platform === "win32" ? "codex.exe" : "codex");
const copyNode = async (file: string) => { await mkdir(path.dirname(file), { recursive: true }); await copyFile(process.execPath, file); await chmod(file, 0o755); return file; };

afterEach(async () => { operations.splice(0).forEach(item => item.dispose()); await Promise.all(roots.splice(0).map(directory => removeFixtureRoot(directory))); });

describe("static tool launchers", () => {
  it("keeps native symlink entry identity without requiring Node", async () => {
    const directory = await root(), target = await native(path.join(directory, "native"));
    const entry = path.join(directory, "entry"); await symlink(target, entry);
    const result = await identifyToolLauncher(entry, "herdr", operation(), host);
    expect(result.executablePath).toBe(target);
    expect(result.interpreterRequired).toBe(false);
    expect(result.artifacts).toContainEqual(expect.objectContaining({ role: "entry", path: entry }));
    expect(result.artifacts[0]?.parsedPrefix).toEqual({ bytes: 8, sha256: createHash("sha256").update(await readFile(target)).digest("hex") });
  });

  it.each(["script.js", "script.cjs", "script.mjs", "script"])("recognizes a single Node entry %s without running it", async name => {
    const entry = await put(path.join(await root(), name), "#!/usr/bin/env node\nthrow new Error('never execute');\n");
    const result = await identifyToolLauncher(entry, "herdr", operation(), host);
    expect(result.executablePath).toBe(entry); expect(result.interpreterRequired).toBe(true);
  });

  it.each(["#!/usr/bin/env node --experimental-transform-types", "#!/usr/bin/env -S node", "#!/usr/bin/env FLAG=1 node", "#!/bin/sh"])("refuses unsupported shebang %s", async shebang => {
    const entry = await put(path.join(await root(), "script.js"), `${shebang}\n`);
    await expect(identifyToolLauncher(entry, "herdr", operation(), host)).rejects.toMatchObject({ code: "unsupported_launcher" });
  });

  it("selects Copilot's native in the entry installation and records both manifests", async () => {
    const directory = await root(), cli = await copilot(directory), runtime = await copilotNative(directory);
    const result = await identifyToolLauncher(cli.entry, "copilot", operation(), host);
    expect(result.executablePath).toBe(runtime); expect(result.interpreterRequired).toBe(false);
    expect(result.artifacts.filter(item => item.role === "manifest").map(item => item.path)).toEqual([
      path.join(cli.packageRoot, "package.json"), path.join(path.dirname(runtime), "package.json"),
    ]);
  });

  it("does not borrow a Copilot package from an outer installation", async () => {
    const directory = await root(), cli = await copilot(path.join(directory, "other"));
    await copilotNative(directory);
    await expect(identifyToolLauncher(cli.entry, "copilot", operation(), host)).rejects.toMatchObject({ code: "unsupported_launcher" });
  });

  it("allows a pnpm dependency symlink owned by the selected package installation", async () => {
    const directory = await root(), cli = await copilot(path.join(directory, "node_modules/.pnpm/cli"));
    const runtime = await copilotNative(path.join(directory, "node_modules/.pnpm/native"));
    await symlink(path.dirname(runtime), path.join(path.dirname(cli.packageRoot), "copilot-darwin-arm64"), "junction");
    const result = await identifyToolLauncher(cli.entry, "copilot", operation(), host);
    expect(result.executablePath).toBe(runtime);
    expect(result.artifacts.find(item => item.role === "runtime")?.path).toBe(path.join(path.dirname(cli.packageRoot), "copilot-darwin-arm64/copilot"));
  });

  it("uses musl before Linux and only the documented Linux fallback", async () => {
    const directory = await root(), cli = await copilot(directory);
    const linux = await copilotNative(directory, "linux", "x64");
    expect((await identifyToolLauncher(cli.entry, "copilot", operation(), { platform: "linux", arch: "x64", nonGlibcLinux: true })).executablePath).toBe(linux);
    const musl = await copilotNative(directory, "linuxmusl", "x64");
    expect((await identifyToolLauncher(cli.entry, "copilot", operation(), { platform: "linux", arch: "x64", nonGlibcLinux: true })).executablePath).toBe(musl);
    expect((await identifyToolLauncher(cli.entry, "copilot", operation(), { platform: "linux", arch: "x64", nonGlibcLinux: false })).executablePath).toBe(linux);
  });

  it.each(["copilot", "copilot.cmd", "copilot.ps1"])("unwraps the complete standard npm template %s", async name => {
    const directory = await root(), cli = await copilot(directory), runtime = await copilotNative(directory);
    const shim = await put(path.join(directory, name), await readFile(new URL(name, fixtures)));
    const result = await identifyToolLauncher(shim, "copilot", operation(), host);
    expect(result.executablePath).toBe(runtime);
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "shim", path: shim }), expect.objectContaining({ role: "entry", path: cli.entry }),
    ]));
  });

  it.each([
    { entry: "copilot.CMD", fixture: "copilot.cmd" },
    { entry: "copilot.PS1", fixture: "copilot.ps1" },
  ])("unwraps a real uppercase $entry without dispatching it as a POSIX shim", async ({ entry, fixture }) => {
    const directory = await root(); await copilot(directory); const runtime = await copilotNative(directory);
    const shim = await put(path.join(directory, entry), await readFile(new URL(fixture, fixtures)));
    const result = await identifyToolLauncher(shim, "copilot", operation(), host);
    expect(result.executablePath).toBe(runtime);
    expect(result.interpreterRequired).toBe(false);
    expect(result.artifacts.find(item => item.role === "shim")?.path).toBe(shim);
  });

  it("parses the captured shim bytes when its pathname is replaced after the bounded read", async () => {
    const directory = await root(); await copilot(directory); const runtime = await copilotNative(directory);
    const bytes = await readFile(new URL("copilot.cmd", fixtures));
    const shim = await put(path.join(directory, "copilot.cmd"), bytes), budget = operation();
    let reads = 0;
    const changing = { ...budget, consume: (count: number) => {
      budget.consume(count);
      if (count === bytes.length && ++reads === 2) {
        renameSync(shim, `${shim}.original`);
        writeFileSync(shim, "replaced after metadata read\n");
      }
    } };
    const result = await identifyToolLauncher(shim, "copilot", changing, host);
    expect(result.executablePath).toBe(runtime);
    expect(result.artifacts.find(item => item.role === "shim")?.parsedSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readFile(shim, "utf8")).toBe("replaced after metadata read\n");
  });

  it.skipIf(process.platform !== "win32").each(["codex", "copilot"] as const)("launches %s through Windows PATH with uppercase PATHEXT", async tool => {
    const directory = await root();
    let runtime: string;
    if (tool === "codex") {
      const cli = await codex(directory);
      runtime = await copyNode(codexRuntime(cli.packageRoot));
    } else {
      await copilot(directory);
      runtime = await copilotNative(directory, process.platform, process.arch);
      await copyNode(runtime);
    }
    let template = await readFile(new URL("copilot.cmd", fixtures), "utf8");
    if (tool === "codex") template = template.replace("node_modules\\@github\\copilot\\npm-loader.js", "node_modules\\@openai\\codex\\custom\\loader.js");
    await put(path.join(directory, `${tool}.cmd`), template);
    const environment = { ...process.env, PATH: directory, PATHEXT: ".CMD" };
    const launch = await resolveToolLaunch({ tool, context: "herdr", choice: { kind: "auto" }, cwd: directory, environment, workerNode: process.execPath }, operation());
    expect(launch.entryPath.endsWith(".CMD")).toBe(true);
    const expectedArtifact = tool === "codex" ? await realpath(path.join(directory, "node_modules/@openai/codex/custom/loader.js")) : runtime;
    expect(launch.artifacts.some(item => item.role === (tool === "codex" ? "entry" : "runtime") && item.realPath === expectedArtifact)).toBe(true);
    const args = ["space and 中文", "%PATH%", "&", "$(echo unexpected)"];
    const command = toolCommand(launch, ["--eval", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args]);
    const { stdout } = await promisify(execFile)(command.file, command.args, { cwd: directory, env: environment, timeout: 5000, maxBuffer: 4096 });
    expect(JSON.parse(stdout)).toEqual(args);
  }, 20_000);

  // Budget all three bounded child launches plus fixture I/O, including a cold native start.
  it("runs the native selected through each standard npm shim with literal argv", async () => {
    const directory = path.join(await root(), "space 空间 & % $() 'quote");
    await copilot(directory);
    const runtime = await copilotNative(directory, process.platform, process.arch);
    await copyFile(process.execPath, runtime); await chmod(runtime, 0o755);
    const args = ["space and 中文", "&", "%PATH%", "$(echo unexpected)", "'quoted'", '"double"'];
    for (const name of ["copilot", "copilot.cmd", "copilot.ps1"]) {
      const shim = await put(path.join(directory, name), await readFile(new URL(name, fixtures)));
      const result = await identifyToolLauncher(shim, "copilot", operation(), { platform: process.platform, arch: process.arch, nonGlibcLinux: false });
      const { stdout } = await promisify(execFile)(result.executablePath, ["--eval", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args], { timeout: 5000, maxBuffer: 4096 });
      expect(JSON.parse(stdout)).toEqual(args);
    }
  }, 20_000);

  it.each(["copilot", "copilot.cmd", "copilot.ps1"])("accepts comments and CRLF in %s", async name => {
    const directory = await root(); await copilot(directory); const runtime = await copilotNative(directory);
    const original = await readFile(new URL(name, fixtures), "utf8");
    const comment = name.endsWith(".cmd") ? "REM harmless comment" : "# harmless comment";
    const shim = await put(path.join(directory, name), `${original.replace(/\r?\n/g, "\r\n")}\r\n${comment}\r\n`);
    const result = await identifyToolLauncher(shim, "copilot", operation(), host);
    expect(result.executablePath).toBe(runtime);
  });

  it("resolves a shim to a Node entry without requiring an official package or bin", async () => {
    const directory = await root(), entry = await put(path.join(directory, "custom entry.js"), "#!/usr/bin/env node\nconsole.log('ok')\n");
    const shim = await put(path.join(directory, "copilot.cmd"), '@echo off\r\n"%dp0%\\custom entry.js" %*\r\n');
    const result = await identifyToolLauncher(shim, "copilot", operation(), host);
    expect(result).toMatchObject({ executablePath: entry, interpreterRequired: true });
  });

  it("uses an unregistered Codex loader in its own layout without interpreting its contents", async () => {
    const directory = await root(), cli = await codex(directory), runtime = await copyNode(codexRuntime(cli.packageRoot));
    await put(cli.entry, `${await readFile(cli.entry, "utf8")}\n// harmless comment\n`);
    const result = await identifyToolLauncher(cli.entry, "codex", operation(), host);
    expect(result).toMatchObject({ executablePath: cli.entry, interpreterRequired: true });
    expect(result.artifacts.map(item => item.role)).toEqual(["entry"]);
    const launch = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: cli.entry }, cwd: directory, environment: process.env }, operation());
    const command = toolCommand(launch, ["--eval", "process.stdout.write(process.execPath)"]);
    expect((await promisify(execFile)(command.file, command.args, { timeout: 5000 })).stdout).toBe(await realpath(runtime));
    expect(command.args[0]).toBe(cli.entry);
  });

  it("refuses a truncated Node shebang instead of ignoring flags beyond the prefix limit", async () => {
    const entry = await put(path.join(await root(), "script.js"), `#!/usr/bin/env node${" ".repeat(4096)}--trace-warnings\n`);
    await expect(identifyToolLauncher(entry, "herdr", operation(), host)).rejects.toMatchObject({ code: "unsupported_launcher" });
  });

  it("honors cancellation before reading an entry", async () => {
    const entry = await native(path.join(await root(), "native"));
    const controller = new AbortController(); controller.abort();
    const budget = createOperation({ signal: controller.signal }); operations.push(budget);
    await expect(identifyToolLauncher(entry, "herdr", budget, host)).rejects.toMatchObject({ kind: "cancelled" });
  });
});
