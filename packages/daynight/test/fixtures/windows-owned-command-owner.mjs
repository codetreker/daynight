import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnWindowsOwnedCommand } from "../../dist/platform/windows-owned-command.js";
import { loadWindowsNativeProcessKernel } from "../../dist/platform/windows-native-process.js";
import { loadWindowsJobKernel } from "../../dist/platform/windows-job.js";

const [directory] = process.argv.slice(2);
const api = await loadWindowsJobKernel();
const publish = (name, value) => {
  const file = path.join(directory, name);
  writeFileSync(file + ".tmp", JSON.stringify(value));
  renameSync(file + ".tmp", file);
};
const identity = pid => {
  const handle = api.open(pid);
  if (handle === null) throw new Error("Unadmitted command fixture identity disappeared.");
  try {
    const value = api.identity(handle);
    if (value.pid !== pid || api.signaled(handle)) throw new Error("Unadmitted command fixture identity is not live.");
    return { pid: value.pid, parentPid: value.parentPid, birth: value.birth.toString() };
  } finally { api.closeProcess(handle); }
};
const wait = async name => {
  const deadline = performance.now() + 15_000;
  while (!existsSync(path.join(directory, name))) {
    if (performance.now() >= deadline) throw new Error("Unadmitted command fixture gate did not open.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

publish("cli.json", identity(process.pid));
await wait("create-target");
const marker = path.join(directory, "unadmitted-target-marker");
const command = spawnWindowsOwnedCommand({
  file: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
  cwd: directory, environment: process.env, stdin: "ignore", resolver: "node",
  deadline: performance.now() + 15_000, graceMs: 1000, pipeCloseMs: 1000,
  normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close",
  onReleased: () => { throw new Error("An unadmitted fixture cannot release ownership."); },
}, { loadNative: async () => {
  const native = await loadWindowsNativeProcessKernel();
  return { ...native,
    createSuspended: options => {
      const result = native.createSuspended(options);
      if (result.created !== null) {
        const observation = native.duplicateProcess(result.created.process);
        try {
          const held = api.identity(observation);
          publish("root.json", { pid: held.pid, parentPid: held.parentPid, birth: held.birth.toString() });
        } finally { api.closeProcess(observation); }
      }
      return result;
    },
    resume: () => {
      const deadline = performance.now() + 15_000;
      while (!existsSync(path.join(directory, "exit-cli"))) {
        if (performance.now() >= deadline) throw new Error("Suspended native owner exit gate did not open.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      process.exit(0);
    },
  };
} });
command.stdout.resume(); command.stderr.resume();
await command.start();
throw new Error("The owner-loss control resumed unexpected target code.");
