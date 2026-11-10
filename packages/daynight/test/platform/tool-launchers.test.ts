import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createOperation } from "../../src/api/operation.js";
import { identifyToolLauncher } from "../../src/platform/tool-launchers.js";
import { resolveToolLaunch, toolCommand } from "../../src/platform/tool-executables.js";

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
const codex = async (directory: string, version = "0.142.5") => {
  const packageRoot = path.join(directory, "node_modules/@openai/codex");
  const entry = await put(path.join(packageRoot, "bin/codex.js"), await readFile(new URL(`codex-${version}.js`, fixtures)));
  await manifest(path.join(packageRoot, "package.json"), { name: "@openai/codex", version, bin: { codex: "bin/codex.js" } });
  return { packageRoot, entry };
};
const codexHost = () => ({ platform: process.platform, arch: process.arch, nonGlibcLinux: false });
const codexTriple = () => `${process.arch === "x64" ? "x86_64" : "aarch64"}-${process.platform === "win32" ? "pc-windows-msvc" : process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
const codexRuntime = (packageRoot: string) => path.join(packageRoot, "vendor", codexTriple(), "bin", process.platform === "win32" ? "codex.exe" : "codex");
const copyNode = async (file: string) => { await mkdir(path.dirname(file), { recursive: true }); await copyFile(process.execPath, file); await chmod(file, 0o755); return file; };
const runCodex = async (script: string, args: string[] = [], env = process.env) => {
  const { stdout } = await promisify(execFile)(process.execPath, [...args, script, "--eval", "process.stdout.write(process.execPath)"], { timeout: 5000, maxBuffer: 4096, env });
  return stdout;
};

afterEach(async () => { operations.splice(0).forEach(item => item.dispose()); await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

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
    if (tool === "codex") template = template.replace("node_modules\\@github\\copilot\\npm-loader.js", "node_modules\\@openai\\codex\\bin\\codex.js");
    await put(path.join(directory, `${tool}.cmd`), template);
    const environment = { ...process.env, PATH: directory, PATHEXT: ".CMD" };
    const launch = await resolveToolLaunch({ tool, context: "herdr", choice: { kind: "auto" }, cwd: directory, environment, workerNode: process.execPath }, operation());
    expect(launch.entryPath.endsWith(".CMD")).toBe(true);
    expect(launch.artifacts.some(item => item.role === "runtime" && item.realPath === runtime)).toBe(true);
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

  it.each(["copilot", "copilot.cmd", "copilot.ps1"])("rejects an added command in %s even when read-cmd-shim recognizes its target", async name => {
    const directory = await root(); await copilot(directory); await copilotNative(directory);
    const shim = await put(path.join(directory, name), `${await readFile(new URL(name, fixtures), "utf8")}\necho injected\n`);
    await expect(identifyToolLauncher(shim, "copilot", operation(), host)).rejects.toMatchObject({ code: "unsupported_launcher" });
  });

  it("rejects divergent branches and added Node flags in otherwise standard shims", async () => {
    const directory = await root(); await copilot(directory); await copilotNative(directory);
    const template = await readFile(new URL("copilot", fixtures), "utf8");
    for (const text of [template.replace('exec node ', 'exec node --trace-warnings '), template.replace('exec node  "$basedir/node_modules/@github/copilot/npm-loader.js"', 'exec node  "$basedir/other.js"')]) {
      const shim = await put(path.join(directory, "copilot"), text);
      await expect(identifyToolLauncher(shim, "copilot", operation(), host)).rejects.toMatchObject({ code: "unsupported_launcher" });
    }
  });

  it("requires a shim target to match its official manifest bin", async () => {
    const directory = await root(), cli = await copilot(directory); await copilotNative(directory);
    await manifest(path.join(cli.packageRoot, "package.json"), { name: "@github/copilot", bin: { copilot: "other.js" } });
    const shim = await put(path.join(directory, "copilot.cmd"), await readFile(new URL("copilot.cmd", fixtures)));
    await expect(identifyToolLauncher(shim, "copilot", operation(), host)).rejects.toMatchObject({ code: "unsupported_launcher" });
  });

  it.each(["0.142.5", "0.145.0", "0.156.1"])("retains the official Codex %s loader and fingerprints its selected alias package native", async version => {
    const directory = await root(), cli = await codex(directory, version);
    const packageRoot = path.join(cli.packageRoot, "node_modules/@openai/codex-darwin-arm64");
    await manifest(path.join(packageRoot, "package.json"), { name: "@openai/codex", version: `${version}-darwin-arm64` });
    const runtime = await native(path.join(packageRoot, "vendor/aarch64-apple-darwin/bin/codex"));
    const result = await identifyToolLauncher(cli.entry, "codex", operation(), host);
    expect(result.executablePath).toBe(cli.entry); expect(result.interpreterRequired).toBe(true);
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "runtime", path: runtime }), expect.objectContaining({ role: "manifest", path: path.join(packageRoot, "package.json") }),
    ]));
    const parsed = result.artifacts.find(item => item.path === cli.entry)!;
    expect(parsed.parsedSha256).toBe(createHash("sha256").update(await readFile(cli.entry)).digest("hex"));
  });

  it.each([
    { platform: "linux", arch: "x64", triple: "x86_64-unknown-linux-musl", file: "codex" },
    { platform: "linux", arch: "arm64", triple: "aarch64-unknown-linux-musl", file: "codex" },
    { platform: "darwin", arch: "x64", triple: "x86_64-apple-darwin", file: "codex" },
    { platform: "darwin", arch: "arm64", triple: "aarch64-apple-darwin", file: "codex" },
    { platform: "win32", arch: "x64", triple: "x86_64-pc-windows-msvc", file: "codex.exe" },
    { platform: "win32", arch: "arm64", triple: "aarch64-pc-windows-msvc", file: "codex.exe" },
  ] as const)("records the $platform/$arch Codex native from its documented vendor layout", async target => {
    const directory = await root(), cli = await codex(directory);
    const runtime = await native(path.join(cli.packageRoot, "vendor", target.triple, "bin", target.file));
    const result = await identifyToolLauncher(cli.entry, "codex", operation(), { ...target, nonGlibcLinux: false });
    expect(result.artifacts.find(item => item.role === "runtime")?.path).toBe(runtime);
  });

  it("uses the Codex root vendor only when no platform package resolves", async () => {
    const directory = await root(), cli = await codex(directory);
    const runtime = await native(path.join(cli.packageRoot, "vendor/aarch64-apple-darwin/bin/codex"));
    expect((await identifyToolLauncher(cli.entry, "codex", operation(), host)).artifacts).toContainEqual(expect.objectContaining({ role: "runtime", path: runtime }));
    const packageRoot = path.join(cli.packageRoot, "node_modules/@openai/codex-darwin-arm64");
    await manifest(path.join(packageRoot, "package.json"), { name: "@openai/codex" });
    await expect(identifyToolLauncher(cli.entry, "codex", operation(), host)).rejects.toMatchObject({ code: "incompatible_runtime" });
  });

  it("refuses an outer Codex package instead of pretending the root vendor will run", async () => {
    const directory = await root(), cli = await codex(path.join(directory, "other"));
    await native(path.join(cli.packageRoot, "vendor/aarch64-apple-darwin/bin/codex"));
    await manifest(path.join(directory, "node_modules/@openai/codex-darwin-arm64/package.json"), { name: "@openai/codex" });
    await expect(identifyToolLauncher(cli.entry, "codex", operation(), host)).rejects.toMatchObject({ code: "unsupported_launcher" });
  });

  it("refuses an unregistered Codex loader even when it contains a known layout", async () => {
    const directory = await root(), cli = await codex(directory);
    await put(cli.entry, `${await readFile(cli.entry, "utf8")}\n// unregistered loader\n`);
    await native(path.join(cli.packageRoot, "vendor/aarch64-apple-darwin/bin/codex"));
    await expect(identifyToolLauncher(cli.entry, "codex", operation(), host)).rejects.toMatchObject({ code: "unsupported_launcher" });
  });

  it("refuses an official Codex loader relocated outside its package bin directory", async () => {
    const directory = await root(), cli = await codex(directory);
    const relocated = await put(path.join(cli.packageRoot, "loader.js"), await readFile(cli.entry));
    await manifest(path.join(cli.packageRoot, "package.json"), { name: "@openai/codex", bin: { codex: "loader.js" } });
    await native(path.join(cli.packageRoot, "vendor/aarch64-apple-darwin/bin/codex"));
    await expect(identifyToolLauncher(relocated, "codex", operation(), host)).rejects.toMatchObject({ code: "unsupported_launcher" });
  });

  it("freezes the native selected from the actual Codex loader's nearest node_modules", async () => {
    const directory = await root(), cli = await codex(directory);
    const name = `@openai/codex-${process.platform}-${process.arch}`;
    const outer = path.join(cli.packageRoot, "node_modules", name), nearest = path.join(cli.packageRoot, "bin/node_modules", name);
    await manifest(path.join(outer, "package.json"), { name: "@openai/codex" }); await native(codexRuntime(outer));
    await manifest(path.join(nearest, "package.json"), { name: "@openai/codex" }); const actual = await copyNode(codexRuntime(nearest));
    const result = await identifyToolLauncher(cli.entry, "codex", operation(), codexHost());
    expect(await runCodex(result.executablePath)).toBe(actual);
    expect(result.artifacts.find(item => item.role === "runtime")?.path).toBe(actual);
  });

  it("refuses a platform manifest leaf symlink whose directory changes the official vendor lookup", async () => {
    const directory = await root(), cli = await codex(directory);
    const name = `@openai/codex-${process.platform}-${process.arch}`, selected = path.join(cli.packageRoot, "node_modules", name);
    const elsewhere = path.join(directory, "elsewhere"); await manifest(path.join(elsewhere, "package.json"), { name: "@openai/codex" });
    await native(codexRuntime(selected)); await native(codexRuntime(elsewhere));
    await symlink(path.join(elsewhere, "package.json"), path.join(selected, "package.json"));
    await expect(identifyToolLauncher(cli.entry, "codex", operation(), codexHost())).rejects.toMatchObject({ code: "unsupported_launcher" });
  });

  it("keeps the root vendor native when NODE_PATH and preserve-symlinks options offer another package", async () => {
    const directory = await root(), cli = await codex(directory), expected = await copyNode(codexRuntime(cli.packageRoot));
    const global = path.join(directory, "global"), other = path.join(global, `@openai/codex-${process.platform}-${process.arch}`);
    await manifest(path.join(other, "package.json"), { name: "@openai/codex" });
    const borrowed = codexRuntime(other); await mkdir(path.dirname(borrowed), { recursive: true }); await link(expected, borrowed);
    const env = { ...process.env, NODE_PATH: global, NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main" };
    const result = await identifyToolLauncher(cli.entry, "codex", operation(), codexHost());
    expect(await runCodex(cli.entry, [], env)).toBe(borrowed);
    expect(await runCodex(result.executablePath, "nodeArgs" in result ? result.nodeArgs as string[] : [], env)).toBe(expected);
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
