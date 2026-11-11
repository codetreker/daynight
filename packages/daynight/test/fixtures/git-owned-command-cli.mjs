import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const [directory, profile] = process.argv.slice(2);
const publish = (name, value) => {
  const file = path.join(directory, name);
  writeFileSync(file + ".tmp", JSON.stringify(value));
  renameSync(file + ".tmp", file);
};
const wait = async name => {
  const deadline = performance.now() + 15_000;
  while (!existsSync(path.join(directory, name))) {
    if (performance.now() >= deadline) throw new Error("Git CLI owner fixture gate did not open.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const koffi = await import("koffi"), kernel = koffi.load("kernel32.dll");
const current = kernel.func("void * __stdcall GetCurrentProcess()");
const times = kernel.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
const lastError = kernel.func("uint32_t __stdcall GetLastError()");
const birth = Buffer.alloc(8);
if (!times(current(), birth, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) throw new Error(`CLI owner birth query failed (${lastError()}).`);
publish("cli.json", { pid: process.pid, parentPid: process.ppid, birth: birth.readBigUInt64LE().toString() });

try {
  await wait("run-cli");
  let result;
  if (profile === "direct") {
    result = await new Promise((resolve, reject) => {
      const child = spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", "daynight-background"], {
        cwd: directory, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Direct Git fixture command deadline exceeded.")); }, 30_000);
      child.stdout.resume(); child.stderr.resume();
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ exitCode: code, signal }); });
    });
  } else if (profile === "owned") {
    const { runRepositoryGit } = await import("../../dist/repository/git.js");
    const { createOperation } = await import("../../dist/api/operation.js");
    const operation = createOperation();
    try {
      const completed = await runRepositoryGit(directory, ["daynight-background"], operation);
      result = { exitCode: completed.exitCode, signal: null };
    } finally { operation.dispose(); }
  } else throw new Error("Unknown Git CLI owner fixture profile.");
  publish("cli-result.json", { profile, kind: "completed", ...result });
  await wait("exit-cli");
} catch (error) {
  publish("cli-result.json", { profile, kind: "failed", error: { name: error.name, message: error.message } });
  process.exitCode = 1;
}
