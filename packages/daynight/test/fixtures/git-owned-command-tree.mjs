import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const [directory, role, disposition, status] = process.argv.slice(2);
const koffi = await import("koffi");
const kernel = koffi.load("kernel32.dll");
const current = kernel.func("void * __stdcall GetCurrentProcess()");
const times = kernel.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
const lastError = kernel.func("uint32_t __stdcall GetLastError()");
const birth = Buffer.alloc(8);
if (!times(current(), birth, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) throw new Error(`Fixture process birth query failed (${lastError()}).`);
const declaration = path.join(directory, role + ".json");
writeFileSync(declaration + ".tmp", JSON.stringify({ pid: process.pid, parentPid: process.ppid, birth: birth.readBigUInt64LE().toString() }));
renameSync(declaration + ".tmp", declaration);

if (role === "middle") {
  const child = (childRole, stdio) => {
    const descendant = spawn(process.execPath, [import.meta.filename, directory, childRole], {
      cwd: path.dirname(directory), detached: true, windowsHide: true, stdio,
    });
    descendant.on("error", error => { throw error; });
    descendant.unref();
  };
  child("leaf", "ignore");
  if (disposition === "pipe" || disposition === "fetch-pipe") child("pipe", ["ignore", disposition === "pipe" ? "inherit" : "ignore", "inherit"]);
  setInterval(() => { if (existsSync(path.join(directory, "leave-middle"))) process.exit(Number(status)); }, 5);
} else {
  let ticks = 0;
  const heartbeat = path.join(directory, role + ".heartbeat");
  setInterval(() => {
    writeFileSync(heartbeat + ".tmp", String(++ticks));
    renameSync(heartbeat + ".tmp", heartbeat);
  }, 10);
}
