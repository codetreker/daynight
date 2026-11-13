import assert from "node:assert/strict";
import { readdir, readFile, lstat, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";

const directory = path.resolve(import.meta.dirname, "../../../.tmp/herdr-tools/research-platform");
const entries = await readdir(directory);
const files = entries.filter(file => /^acceptance-(?:argv-)?(codex|copilot)-.*\.json$/.test(file));
const metadataFiles = entries.filter(file => /^acceptance-windows-metadata-.*\.json$/.test(file));
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
  const windowsQueriesClosed = (run.cleanup.windowsQueries ?? []).every(query => query.closed === true && query.cleanupConfirmed === true);
  const result = { file, livePids, endpointsClosed, shortLinkRemoved, preparationProbesClosed, windowsQueriesClosed, runtimeDirectoryRemoved: run.cleanup.runtimeDirectoryRemoved === true };
  evidence.runs.push(result);
  if (livePids.length || endpointsClosed.some(value => !value) || !shortLinkRemoved || !preparationProbesClosed || !windowsQueriesClosed || !result.runtimeDirectoryRemoved) evidence.failures.push(file);
}
for (const agent of ["codex", "copilot"]) if (!files.some(file => file.startsWith(`acceptance-${agent}-`))) evidence.failures.push(`Missing ${agent} completion evidence.`);
if (process.platform === "win32" && !files.some(file => file.startsWith("acceptance-argv-codex-"))) evidence.failures.push("Missing Windows ExternalScript argument evidence.");
for (const file of metadataFiles) {
  const run = JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const validIdentity = run.schemaVersion === 1 && run.source === "isolated-ps5-dotnet-oracle" && run.platform === "win32" && Number.isSafeInteger(run.pid) && run.pid > 0 && run.pid <= 0xffff_ffff;
  let processStopped = false;
  if (validIdentity) { try { process.kill(run.pid, 0); } catch (error) { processStopped = error.code === "ESRCH"; } }
  const directoryRemoved = typeof run.directory === "string" && path.isAbsolute(run.directory) && await lstat(run.directory).then(() => false, error => error.code === "ENOENT");
  const result = { file, validIdentity, processStopped, closed: run.closed === true, runtimeDirectoryRemoved: run.runtimeDirectoryRemoved === true && directoryRemoved };
  evidence.runs.push(result);
  if (!validIdentity || !processStopped || !result.closed || !result.runtimeDirectoryRemoved) evidence.failures.push(file);
}
if (process.platform === "win32" && metadataFiles.length === 0) evidence.failures.push("Missing Windows native metadata oracle cleanup evidence.");
await writeFile(path.join(directory, "cleanup.json"), `${JSON.stringify(evidence, null, 2)}\n`);
assert.equal(evidence.failures.length, 0, `Real Herdr cleanup is unconfirmed: ${evidence.failures.join(", ")}`);
