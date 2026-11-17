import path from "node:path";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { runShellWorktreeRemoval } from "../../../src/commands/worker/shell-worktree-removal.js";

const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/shell-worktree-tests");
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform === "win32")("quotes special characters as one literal shell target", async () => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "fixture-")); roots.push(root);
  const target = path.join(root, "space ' newline\n$(touch injected)");
  await mkdir(target); await writeFile(path.join(target, "file"), "remove");
  await writeFile(path.join(root, "keep"), "keep");
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  const operation = createOperation();
  try { await runShellWorktreeRemoval(root, target, operation); } finally { operation.dispose(); }
  await expect(readFile(path.join(root, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(root, "keep"), "utf8")).toBe("keep");
  await expect(readFile(path.join(target, "file"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32").each(["missing", "refused"])("reports a noninteractive sudo %s failure", async mode => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "fixture-")); roots.push(root);
  const target = path.join(root, "target"); await mkdir(target);
  if (mode === "refused") await writeFile(path.join(root, "sudo"), "#!/bin/sh\n[ \"$1\" = -n ] && [ \"$2\" = -u ] && [ \"$3\" = root ] && [ \"$4\" = -- ] || { echo invalid-sudo-arguments >&2; exit 2; }\necho sudo-refused >&2\nexit 1\n", { mode: 0o755 });
  vi.spyOn(process, "geteuid").mockReturnValue(501);
  const previous = process.env.PATH; process.env.PATH = root;
  const operation = createOperation();
  try {
    const error = await runShellWorktreeRemoval(root, target, operation).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error.errors[0])).toContain(mode === "missing" ? "sudo" : "sudo-refused");
  } finally { process.env.PATH = previous; operation.dispose(); }
});

it.skipIf(process.platform === "win32")("retains the command until close after its deadline", async () => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "fixture-")); roots.push(root);
  const target = path.join(root, "target"); await mkdir(target);
  await writeFile(path.join(root, "sudo"), "#!/bin/sh\nshift 4\nsleep 1\nexec \"$@\"\n", { mode: 0o755 });
  vi.spyOn(process, "geteuid").mockReturnValue(501);
  const previous = process.env.PATH; process.env.PATH = `${root}:${previous ?? ""}`;
  const operation = createOperation({ limits: { totalMs: 120, requestMs: 80 } });
  const start = Date.now();
  try {
    const error = await runShellWorktreeRemoval(root, target, operation).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { process.env.PATH = previous; operation.dispose(); }
});

it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("fails promptly when a real unprivileged user cannot use sudo", async () => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "fixture-")); roots.push(root); await chmod(root, 0o755);
  const target = path.join(root, "target"); await mkdir(target, { mode: 0o700 }); await writeFile(path.join(target, "keep"), "keep");
  const shellModule = new URL("../../../dist/commands/worker/shell-worktree-removal.js", import.meta.url).href;
  const operationModule = new URL("../../../dist/api/operation.js", import.meta.url).href;
  const script = `
    import { runShellWorktreeRemoval } from ${JSON.stringify(shellModule)};
    import { createOperation } from ${JSON.stringify(operationModule)};
    process.setgroups([Number(process.argv[3])]); process.setgid(Number(process.argv[3])); process.setuid('nobody');
    const operation = createOperation({ limits: { totalMs: 5000 } });
    try { await runShellWorktreeRemoval(process.argv[1], process.argv[2], operation); process.exitCode = 2; }
    catch (error) { console.log(String(error.errors?.[0] ?? error)); }
    finally { operation.dispose(); }
  `;
  const started = Date.now();
  const output = execFileSync("sudo", ["-n", process.execPath, "--input-type=module", "-e", script, root, target, String(process.getgid!())], { cwd: "/", timeout: 8000, encoding: "utf8" });
  expect(output.toLowerCase()).toContain("sudo");
  expect(Date.now() - started).toBeLessThan(8000);
  expect(await readFile(path.join(target, "keep"), "utf8")).toBe("keep");
});
