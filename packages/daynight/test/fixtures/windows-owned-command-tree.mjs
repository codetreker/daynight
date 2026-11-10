import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import koffi from "koffi";

const [directory, role = "root"] = process.argv.slice(2);
const script = fileURLToPath(import.meta.url);
const kernel = koffi.load("kernel32.dll");
const current = kernel.func("void * __stdcall GetCurrentProcess()");
const times = kernel.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
const creation = Buffer.alloc(8);
if (!times(current(), creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) throw new Error("Fixture self identity is unavailable.");
const publish = (filename, value) => {
  writeFileSync(filename + ".tmp", JSON.stringify(value));
  renameSync(filename + ".tmp", filename);
};
publish(path.join(directory, role + ".json"), { pid: process.pid, parentPid: process.ppid, birth: creation.readBigUInt64LE().toString() });
let spawned = false, attempted = false, tick = 0;
setInterval(() => {
  if (existsSync(path.join(directory, `leave-${role}`))) process.exit(0);
  if (role === "root" && !spawned && existsSync(path.join(directory, "spawn"))) {
    spawned = true;
    spawn(process.execPath, [script, directory, "middle"], { stdio: "ignore", windowsHide: true });
  }
  if (role === "middle" && !spawned) {
    spawned = true;
    spawn(process.execPath, [script, directory, "leaf"], { stdio: "ignore", detached: true, windowsHide: true });
  }
  if (role === "leaf" || role === "bystander") publish(path.join(directory, role + ".heartbeat"), ++tick);
  if (role === "root" && !attempted && existsSync(path.join(directory, "attempt-fork"))) {
    attempted = true;
    const marker = path.join(directory, "forbidden-child");
    let failure = null;
    try {
      const child = spawn(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], { stdio: "ignore", windowsHide: true });
      child.once("error", error => { failure = { code: error.code, message: error.message }; });
      child.once("close", (code, signal) => publish(path.join(directory, "fork-result.json"), { code, signal, failure, marker: existsSync(marker) }));
    } catch (error) {
      publish(path.join(directory, "fork-result.json"), { failure: { code: error.code, message: error.message }, marker: existsSync(marker) });
    }
  }
}, 5);
