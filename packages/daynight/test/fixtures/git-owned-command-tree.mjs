import { spawn } from "node:child_process";
import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const [directory, role, disposition, status] = process.argv.slice(2);
const safeSyscalls = new Set(["open", "write", "close", "rename", "stat", "fstat"]);
let stage = "bootstrap";
const publish = (filename, value) => {
  writeFileSync(filename + ".tmp", JSON.stringify(value));
  renameSync(filename + ".tmp", filename);
};
const fail = (error, failureStage = stage) => {
  const receipt = { schemaVersion: 1, role, stage: failureStage, name: error instanceof Error ? error.name : "NonErrorThrown" };
  if (error !== null && typeof error === "object" && (typeof error.code === "string" || typeof error.code === "number")) receipt.code = error.code;
  if (error !== null && typeof error === "object" && typeof error.syscall === "string" && safeSyscalls.has(error.syscall)) receipt.syscall = error.syscall;
  try { publish(path.join(directory, role + ".error.json"), receipt); }
  finally { process.exit(1); }
};
process.once("uncaughtException", error => fail(error));
process.once("unhandledRejection", error => fail(error));

try {
  const koffi = await import("koffi");
  stage = "native-identity";
  const kernel = koffi.load("kernel32.dll");
  const current = kernel.func("void * __stdcall GetCurrentProcess()");
  const times = kernel.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const birth = Buffer.alloc(8);
  if (!times(current(), birth, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) throw Object.assign(new Error("Fixture process birth query failed."), { code: lastError() });
  stage = "publish-identity";
  publish(path.join(directory, role + ".json"), { pid: process.pid, parentPid: process.ppid, birth: birth.readBigUInt64LE().toString() });

  if (role === "middle") {
    const child = (childRole, stdio) => {
      stage = "spawn-" + childRole;
      const descendant = spawn(process.execPath, [import.meta.filename, directory, childRole], {
        cwd: path.dirname(directory), detached: true, windowsHide: true, stdio,
      });
      descendant.once("error", error => fail(error, "spawn-" + childRole));
      descendant.unref();
    };
    child("leaf", "ignore");
    if (disposition === "pipe" || disposition === "fetch-pipe") child("pipe", ["ignore", disposition === "pipe" ? "inherit" : "ignore", "inherit"]);
    stage = "wait-root-release";
    setInterval(() => { if (existsSync(path.join(directory, "leave-middle"))) process.exit(Number(status)); }, 5);
  } else {
    const tick = Buffer.from([1]);
    const heartbeat = path.join(directory, role + ".heartbeat");
    stage = "heartbeat-wait";
    setInterval(() => {
      stage = "heartbeat-append";
      appendFileSync(heartbeat, tick);
      stage = "heartbeat-wait";
    }, 10);
  }
} catch (error) { fail(error); }
