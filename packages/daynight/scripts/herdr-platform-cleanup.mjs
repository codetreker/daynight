import { spawn } from "node:child_process";
import { readdir, readFile, lstat, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";

const validPid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fff_ffff;
const validToken = token => typeof token === "string" && /^[1-9][0-9]{0,18}$/.test(token) && BigInt(token) >= 504911232000000000n && BigInt(token) <= 3155378975999999999n;
const sources = new Set(["cim-creation-date-ticks", "dotnet-start-time-ticks"]);
const validSourceToken = (source, token) => sources.has(source) && validToken(token) && (source !== "cim-creation-date-ticks" || BigInt(token) % 10n === 0n);
const details = error => ({ name: error?.name ?? "Error", code: error?.code ?? null, errno: error?.errno ?? null });
const failure = code => ({ name: "CleanupObservationError", code });

/** Own only the observer child. Its close event joins both exit and stdio;
 * an unconfirmed cleanup never supplies process observations.
 */
export const runCleanupQuery = (file, args, { timeoutMs = 10_000, cleanupMs = 2000 } = {}) => new Promise(resolve => {
  const child = spawn(file, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = []; let bytes = 0, stderrBytes = 0, error = null, cleanupTimer, finished = false;
  const finish = (code, signal, closed) => {
    if (finished) return;
    finished = true; clearTimeout(timer); clearTimeout(cleanupTimer);
    resolve({ pid: child.pid ?? null, code, signal, closed, error, stdoutBytes: bytes, stderrBytes, stdout: Buffer.concat(chunks).toString("utf8") });
  };
  const stop = reason => {
    error ??= reason;
    if (cleanupTimer !== undefined) return;
    try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    catch (cause) { error = { ...error, cleanupError: details(cause) }; }
    cleanupTimer = setTimeout(() => {
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish(child.exitCode, child.signalCode, false);
    }, cleanupMs);
  };
  const timer = setTimeout(() => stop(failure("ETIMEDOUT")), timeoutMs);
  child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes <= 256 * 1024) chunks.push(chunk); else stop(failure("OUTPUT_LIMIT")); });
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) stop(failure("STDERR_LIMIT")); });
  for (const stream of [child.stdout, child.stderr]) stream.on("error", cause => stop(details(cause)));
  child.on("error", cause => { error ??= details(cause); });
  child.on("close", (code, signal) => finish(code, signal, true));
});

/** These are the same independent sources as the saved evidence, not the
 * production Win32 proof reader. Never compare CIM microseconds to .NET ticks.
 */
export const windowsCleanupScript = targets => {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 1000 || targets.some(row => !validPid(row.pid) || !sources.has(row.source))) throw new Error("Invalid independent cleanup targets.");
  const data = Buffer.from(JSON.stringify(targets)).toString("base64");
  return `$ErrorActionPreference='Stop';
$targets=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')));
$rows=[Collections.Generic.List[object]]::new();
function ErrorData($failure) {
  $e=$failure.Exception; while($e.InnerException) { $e=$e.InnerException }
  @{name=$e.GetType().FullName;code=$e.HResult;nativeCode=$(if($e -is [ComponentModel.Win32Exception]) { $e.NativeErrorCode } else { $null })}
}
foreach($target in $targets) {
  $row=@{pid=[int]$target.pid;source=[string]$target.source;state='unknown';startToken=$null;error=$null};
  try {
    if($target.source -ceq 'cim-creation-date-ticks') {
      $instances=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+$target.pid) -ErrorAction Stop);
      try {
        if($instances.Count -eq 0) { $row.state='missing' }
        elseif($instances.Count -ne 1 -or $instances[0].ProcessId -ne $target.pid -or $null -eq $instances[0].CreationDate) { throw 'Incomplete CIM identity.' }
        else { $row.startToken=$instances[0].CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture); $row.state='present' }
      } finally { foreach($item in $instances) { if($item -is [IDisposable]) { $item.Dispose() } } }
    } else {
      $p=$null;
      try { $p=[Diagnostics.Process]::GetProcessById([int]$target.pid) }
      catch { $e=$_.Exception; while($e.InnerException) { $e=$e.InnerException }; if($e -is [ArgumentException]) { $row.state='missing' } else { throw } }
      if($null -ne $p) {
        try { $null=$p.SafeHandle; $row.startToken=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture); $row.state='present' }
        finally { $p.Dispose() }
      }
    }
  } catch { $row.state='unknown'; $row.startToken=$null; $row.error=ErrorData $_ }
  $rows.Add($row);
}
@{schemaVersion=1;rows=@($rows.ToArray())} | ConvertTo-Json -Depth 6 -Compress;`;
};

export const observeWindowsCleanup = async (targets, { execute = runCleanupQuery, systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT } = {}) => {
  let query;
  try {
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw Object.assign(new Error("Missing system PowerShell root."), { code: "SYSTEM_ROOT_MISSING" });
    const script = windowsCleanupScript(targets);
    query = await execute(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    if (!query.closed || query.error || query.code !== 0 || query.signal !== null) return { query: { ...query, stdout: undefined }, rows: [], error: query.error ?? failure("QUERY_NOT_COMPLETED") };
    const envelope = JSON.parse(query.stdout);
    if (envelope?.schemaVersion !== 1 || !Array.isArray(envelope.rows) || envelope.rows.length !== targets.length) throw failure("INVALID_QUERY_ENVELOPE");
    const rows = envelope.rows;
    const keys = new Set();
    for (const row of rows) {
      const key = `${row?.source}:${row?.pid}`;
      if (!targets.some(target => target.pid === row?.pid && target.source === row?.source) || keys.has(key) || !["missing", "present", "unknown"].includes(row.state) || (row.state === "present" ? !validSourceToken(row.source, row.startToken) || row.error !== null : row.startToken !== null) || (row.state === "missing" ? row.error !== null : row.state === "unknown" && (!row.error || typeof row.error !== "object"))) throw failure("INVALID_QUERY_IDENTITY");
      keys.add(key);
    }
    return { query: { ...query, stdout: undefined }, rows, error: null };
  } catch (error) { return { query: query ? { ...query, stdout: undefined } : null, rows: [], error: details(error) }; }
};

const closedEndpoint = (endpoint, platform) => new Promise(resolve => {
  const socket = new Socket(), timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
  socket.once("error", error => { clearTimeout(timer); socket.destroy(); resolve(["ENOENT", "ECONNREFUSED"].includes(error.code)); });
  socket.connect(platform === "win32" ? `\\\\.\\pipe\\${endpoint}` : endpoint);
});

const windowsOriginals = (run, metadata) => {
  if (metadata) {
    const valid = run.schemaVersion === 1 && run.source === "isolated-ps5-dotnet-oracle" && run.platform === "win32" && validPid(run.pid) && validToken(run.startToken) && run.closed === true;
    return { valid, originals: [{ pid: run.pid, source: "dotnet-start-time-ticks", startToken: run.startToken ?? null }] };
  }
  const cleanup = run.cleanup ?? {}, capture = cleanup.processCapture;
  const explicit = [run.daemonPid, run.shellPid, run.receipt?.helperPid, run.receipt?.childPid];
  const originals = (Array.isArray(capture?.processes) ? capture.processes : []).map(row => ({ ...row, source: "cim-creation-date-ticks" }));
  const after = cleanup.originalProcesses;
  const valid = run.schemaVersion === 1 && run.platform === "win32" && explicit.every(validPid) && new Set(explicit).size === 4 && capture?.stage === "before-stop" && Array.isArray(capture.roots) && explicit.every(pid => capture.roots.includes(pid)) && capture.roots.every(validPid) && originals.length > 0 && originals.length <= 1000 && new Set(originals.map(row => row.pid)).size === originals.length && originals.every(row => validPid(row.pid) && Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 && validSourceToken(row.source, row.startToken)) && capture.roots.every(pid => originals.some(row => row.pid === pid)) && Array.isArray(after) && after.length === originals.length && after.every(row => row && typeof row === "object") && new Set(after.map(row => row.pid)).size === after.length && originals.every(original => after.some(row => row.pid === original.pid && row.parentPid === original.parentPid && row.startToken === original.startToken && row.stage === "after-stop" && row.observation === "exited")) && cleanup.workspaceClosed === true && cleanup.instance?.ownedChildClosed === true && cleanup.instance.apiClosed === true && cleanup.instance.clientClosed === true && !["captureError", "processReadbackError", "workspaceError", "instanceError"].some(key => cleanup[key] !== undefined);
  return { valid, originals };
};
const observeOriginals = async (run, metadata, observeWindows) => {
  const { valid, originals } = windowsOriginals(run, metadata);
  const observation = valid ? await observeWindows(originals.map(({ pid, source }) => ({ pid, source }))) : { rows: [], query: null, error: failure("INVALID_ORIGINAL_STOP_EVIDENCE") };
  const processes = originals.map(original => {
    const current = observation.rows.find(row => row.pid === original.pid && row.source === original.source);
    const error = observation.error ?? current?.error ?? (current ? null : failure("MISSING_QUERY_RESULT"));
    return { pid: original.pid, source: original.source, originalStartToken: original.startToken, currentStartToken: current?.startToken ?? null, observation: error ? "unknown" : current.state === "missing" ? "missing" : current.startToken === original.startToken ? "same-original" : "replaced", error };
  });
  return { processes, query: observation.query, processEvidenceError: observation.error, processStopped: valid && processes.length > 0 && processes.every(row => row.observation === "missing" || row.observation === "replaced") };
};
const inspectPid = pid => {
  try { process.kill(pid, 0); return { pid, observation: "present", error: null }; }
  catch (error) { return { pid, observation: error.code === "ESRCH" ? "missing" : "unknown", error: error.code === "ESRCH" ? null : details(error) }; }
};

export const checkHerdrPlatformCleanup = async (directory, { platform = process.platform, observeWindows = observeWindowsCleanup } = {}) => {
  const entries = await readdir(directory);
  const files = entries.filter(file => /^acceptance-(?:argv-)?(codex|copilot)-.*\.json$/.test(file));
  const metadataFiles = entries.filter(file => /^acceptance-windows-metadata-.*\.json$/.test(file));
  const evidence = { checkedAt: new Date().toISOString(), runs: [], failures: [] };
  for (const file of files) {
    const run = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    const pids = [...new Set([run.daemonPid, run.shellPid, run.receipt?.helperPid, run.receipt?.childPid, ...(run.cleanup.originalProcesses ?? []).map(row => row.pid)].filter(Boolean))];
    const processResult = platform === "win32" ? await observeOriginals(run, false, observeWindows) : { processes: pids.map(inspectPid) };
    const livePids = processResult.processes.filter(row => (row.observation === "same-original" || row.observation === "present")).map(row => row.pid), unknownPids = processResult.processes.filter(row => row.observation === "unknown").map(row => row.pid);
    const endpointsClosed = run.endpoints ? await Promise.all(Object.values(run.endpoints).map(endpoint => closedEndpoint(endpoint, platform))) : [];
    const shortLinkRemoved = !run.shortLink || await lstat(run.shortLink).then(() => false, error => error.code === "ENOENT");
    const preparationProbesClosed = !run.cleanup.preparationProbeSetupError && (run.cleanup.preparationProbes ?? []).every(probe => probe.closed === true);
    const windowsQueriesClosed = (run.cleanup.windowsQueries ?? []).every(query => query.closed === true && query.cleanupConfirmed === true);
    const result = { file, ...processResult, livePids, unknownPids, endpointsClosed, shortLinkRemoved, preparationProbesClosed, windowsQueriesClosed, runtimeDirectoryRemoved: run.cleanup.runtimeDirectoryRemoved === true };
    evidence.runs.push(result);
    if (platform === "win32" && !result.processStopped || livePids.length || unknownPids.length || endpointsClosed.some(value => !value) || !shortLinkRemoved || !preparationProbesClosed || !windowsQueriesClosed || !result.runtimeDirectoryRemoved) evidence.failures.push(file);
  }
  for (const agent of ["codex", "copilot"]) if (!files.some(file => file.startsWith(`acceptance-${agent}-`))) evidence.failures.push(`Missing ${agent} completion evidence.`);
  if (platform === "win32" && !files.some(file => file.startsWith("acceptance-argv-codex-"))) evidence.failures.push("Missing Windows ExternalScript argument evidence.");
  for (const file of metadataFiles) {
    const run = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    const validIdentity = run.schemaVersion === 1 && run.source === "isolated-ps5-dotnet-oracle" && run.platform === "win32" && validPid(run.pid) && validToken(run.startToken);
    const processResult = platform === "win32" ? await observeOriginals(run, true, observeWindows) : { processStopped: validIdentity && inspectPid(run.pid).observation === "missing" };
    const directoryRemoved = typeof run.directory === "string" && path.isAbsolute(run.directory) && await lstat(run.directory).then(() => false, error => error.code === "ENOENT");
    const result = { file, validIdentity, ...processResult, closed: run.closed === true, runtimeDirectoryRemoved: run.runtimeDirectoryRemoved === true && directoryRemoved };
    evidence.runs.push(result);
    if (!validIdentity || !result.processStopped || !result.closed || !result.runtimeDirectoryRemoved) evidence.failures.push(file);
  }
  if (platform === "win32" && metadataFiles.length === 0) evidence.failures.push("Missing Windows native metadata oracle cleanup evidence.");
  await writeFile(path.join(directory, "cleanup.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
};
