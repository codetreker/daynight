import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnNodeGuardianCommand } from "../../dist/platform/windows-node-guardian.js";
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
await wait("create-helper");
const marker = path.join(directory, "unadmitted-target-marker");
const backend = spawnNodeGuardianCommand({
  file: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
  cwd: directory, environment: process.env, stdin: "ignore", resolver: "node",
  deadline: performance.now() + 15_000, graceMs: 1000, pipeCloseMs: 1000,
  normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close",
  onReleased: () => { throw new Error("An unadmitted fixture cannot release ownership."); },
}, { loadKernel: async () => { throw new Error("This fixture must never create or assign a product Job."); } });
backend.command.stdout.resume(); backend.command.stderr.resume();
if (backend.guardianChild.pid === undefined) throw new Error("Unadmitted command fixture helper did not spawn.");
publish("guardian.json", identity(backend.guardianChild.pid));
await wait("exit-cli");
process.exit(0);
