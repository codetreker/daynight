import assert from "node:assert/strict";
import { readdir, readFile, lstat, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";

const directory = path.resolve(import.meta.dirname, "../../../.tmp/herdr-tools/research-platform");
const files = (await readdir(directory)).filter(file => /^acceptance-(?:argv-)?(codex|copilot)-.*\.json$/.test(file));
const evidence = { checkedAt: new Date().toISOString(), runs: [], failures: [] };
const closed = endpoint => new Promise(resolve => {
  const socket = new Socket(), timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
  socket.once("error", error => { clearTimeout(timer); socket.destroy(); resolve(["ENOENT", "ECONNREFUSED"].includes(error.code)); });
  socket.connect(process.platform === "win32" ? `\\\\.\\pipe\\${endpoint}` : endpoint);
});
for (const file of files) {
  const run = JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const pids = [...new Set([run.daemonPid, run.shellPid, run.receipt?.helperPid, run.receipt?.childPid, ...(run.cleanup.originalProcesses ?? []).map(process => process.pid)].filter(Boolean))];
  const livePids = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } });
  const endpointsClosed = run.endpoints ? await Promise.all(Object.values(run.endpoints).map(closed)) : [];
  const shortLinkRemoved = !run.shortLink || await lstat(run.shortLink).then(() => false, error => error.code === "ENOENT");
  const preparationProbesClosed = !run.cleanup.preparationProbeSetupError && (run.cleanup.preparationProbes ?? []).every(probe => probe.closed === true);
  const result = { file, livePids, endpointsClosed, shortLinkRemoved, preparationProbesClosed, runtimeDirectoryRemoved: run.cleanup.runtimeDirectoryRemoved === true };
  evidence.runs.push(result);
  if (livePids.length || endpointsClosed.some(value => !value) || !shortLinkRemoved || !preparationProbesClosed || !result.runtimeDirectoryRemoved) evidence.failures.push(file);
}
for (const agent of ["codex", "copilot"]) if (!files.some(file => file.startsWith(`acceptance-${agent}-`))) evidence.failures.push(`Missing ${agent} completion evidence.`);
if (process.platform === "win32" && !files.some(file => file.startsWith("acceptance-argv-codex-"))) evidence.failures.push("Missing Windows ExternalScript argument evidence.");
await writeFile(path.join(directory, "cleanup.json"), `${JSON.stringify(evidence, null, 2)}\n`);
assert.equal(evidence.failures.length, 0, `Real Herdr cleanup is unconfirmed: ${evidence.failures.join(", ")}`);
