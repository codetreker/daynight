import { spawn } from "node:child_process";
import { readdir, readFile, lstat, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";

const validPid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fff_ffff;
const validId = id => typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id);
const validOwnerId = id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const validToken = token => typeof token === "string" && /^[1-9][0-9]{0,18}$/.test(token) && BigInt(token) >= 504911232000000000n && BigInt(token) <= 3155378975999999999n;
const sources = new Set(["cim-creation-date-ticks", "dotnet-start-time-ticks"]);
const validSourceToken = (source, token) => sources.has(source) && validToken(token) && (source !== "cim-creation-date-ticks" || BigInt(token) % 10n === 0n);
const originalKey = row => `${row.pid}:${row.startToken}`;
const details = error => ({ name: error?.name ?? "Error", code: error?.code ?? null, errno: error?.errno ?? null });
const failure = code => ({ name: "CleanupObservationError", code });
const cleanupStages = ["script-start", "get-process-start", "get-process-done", "safe-handle-start", "safe-handle-done", "start-time-start", "start-time-done", "dispose-start", "dispose-done", "json-start", "json-done"];
const cleanupStagePattern = new RegExp(`__DAYNIGHT_CLEANUP_STAGE_(${cleanupStages.join("|")})__`, "g");

/** Own only the observer child. Its close event joins both exit and stdio;
 * an unconfirmed cleanup never supplies process observations.
 */
export const runCleanupQuery = (file, args, { timeoutMs = 10_000, cleanupMs = 2000, captureStages = false } = {}) => new Promise(resolve => {
  const startedAt = performance.now();
  const stages = [];
  const recordStage = stage => { if (captureStages && stages.length < 32) stages.push({ stage, receivedAfterMs: Math.round(performance.now() - startedAt) }); };
  const child = spawn(file, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = []; let bytes = 0, stderrBytes = 0, stderrSuffix = "", error = null, cleanupTimer, finished = false;
  const finish = (code, signal, closed) => {
    if (finished) return;
    finished = true; clearTimeout(timer); clearTimeout(cleanupTimer);
    if (closed) recordStage("observer-close");
    resolve({ pid: child.pid ?? null, code, signal, closed, error, stdoutBytes: bytes, stderrBytes, stdout: Buffer.concat(chunks).toString("utf8"), ...(captureStages ? { stages } : {}) });
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
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length;
    if (captureStages) {
      const input = stderrSuffix + chunk.toString("utf8");
      cleanupStagePattern.lastIndex = 0;
      let match, consumed = 0;
      while ((match = cleanupStagePattern.exec(input)) !== null) { recordStage(match[1]); consumed = cleanupStagePattern.lastIndex; }
      stderrSuffix = input.slice(consumed).slice(-128);
    }
    if (stderrBytes > 64 * 1024) stop(failure("STDERR_LIMIT"));
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("error", cause => stop(details(cause)));
  child.on("spawn", () => recordStage("observer-spawn"));
  child.on("error", cause => { error ??= details(cause); });
  child.on("exit", () => recordStage("observer-exit"));
  child.on("close", (code, signal) => finish(code, signal, true));
});

/** These are the same independent sources as the saved evidence, not the
 * production Win32 proof reader. Never compare CIM microseconds to .NET ticks.
 */
export const windowsCleanupScript = (targets, { captureStages = false } = {}) => {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 1000 || targets.some(row => !validPid(row.pid) || !sources.has(row.source))) throw new Error("Invalid independent cleanup targets.");
  if (captureStages && (targets.length !== 1 || targets[0].source !== "dotnet-start-time-ticks")) throw new Error("Cleanup stage diagnostics require one .NET target.");
  const data = Buffer.from(JSON.stringify(targets)).toString("base64");
  const stage = name => captureStages ? `[Console]::Error.WriteLine('__DAYNIGHT_CLEANUP_STAGE_${name}__'); [Console]::Error.Flush();` : "";
  return `$ErrorActionPreference='Stop';
${stage("script-start")}
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
      try { ${stage("get-process-start")} $p=[Diagnostics.Process]::GetProcessById([int]$target.pid); ${stage("get-process-done")} }
      catch { $e=$_.Exception; while($e.InnerException) { $e=$e.InnerException }; if($e -is [ArgumentException]) { $row.state='missing' } else { throw } }
      if($null -ne $p) {
        try { ${stage("safe-handle-start")} $null=$p.SafeHandle; ${stage("safe-handle-done")} ${stage("start-time-start")} $row.startToken=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture); ${stage("start-time-done")} $row.state='present' }
        finally { ${stage("dispose-start")} $p.Dispose(); ${stage("dispose-done")} }
      }
    }
  } catch { $row.state='unknown'; $row.startToken=$null; $row.error=ErrorData $_ }
  $rows.Add($row);
}
${stage("json-start")}
@{schemaVersion=1;rows=@($rows.ToArray())} | ConvertTo-Json -Depth 6 -Compress;
${stage("json-done")}`;
};

export const observeWindowsCleanup = async (targets, { execute = runCleanupQuery, systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT, captureStages = false } = {}) => {
  let query;
  try {
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw Object.assign(new Error("Missing system PowerShell root."), { code: "SYSTEM_ROOT_MISSING" });
    const script = windowsCleanupScript(targets, { captureStages });
    query = await execute(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { captureStages });
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
  const partial = cleanup.partialWorkspace;
  const observation = cleanup.partialWorkspaceObservation;
  const closure = cleanup.partialWorkspaceClosure;
  const independent = cleanup.partialWorkspaceIndependent;
  const partialStage = run.resourceStage === "preparing-workspace";
  const explicit = partialStage ? [run.daemonPid, run.shellPid] : [run.daemonPid, run.shellPid, run.receipt?.helperPid, run.receipt?.childPid];
  const originals = (Array.isArray(capture?.processes) ? capture.processes : []).map(row => ({ ...row, source: "cim-creation-date-ticks" }));
  const after = cleanup.originalProcesses;
  const ownerFields = ["projectId", "taskId", "claimId", "worktreeId"];
  const ready = cleanup.readinessDiagnostics?.readyFile;
  const pane = cleanup.readinessDiagnostics?.pane;
  const signals = new Set(["execution-policy", "command-not-found", "path-not-found", "access-denied", "parser-error", "terminating-error", "powershell-prompt"]);
  const validReadiness = cleanup.readinessDiagnosticError === undefined && cleanup.readinessVerified === true &&
    (partial?.readyValidation === "missing" || partial?.readyValidation === "verified") &&
    (ready?.state === "missing" || ready?.state === "present" && partial.readyValidation === "verified" &&
      ["nonceMatches", "pidMatches", "executableMatches", "validStartToken"].every(field => ready[field] === true) && Number.isSafeInteger(ready.size) && ready.size >= 0 && ready.size <= 4096) &&
    pane?.state === "observed" && pane.shellPid === run.shellPid && Number.isSafeInteger(pane.screenBytes) && pane.screenBytes >= 0 && pane.screenBytes <= 4096 &&
    Array.isArray(pane.screenSignals) && pane.screenSignals.every(signal => signals.has(signal)) && new Set(pane.screenSignals).size === pane.screenSignals.length;
  const validPartial = partialStage && typeof run.error === "string" && run.error.includes("The original PowerShell root readiness phase failed") &&
    run.receipt === null && run.initialInputAttempts === 0 && Array.isArray(run.requests) && run.requests.length === 0 &&
    run.processProofCompleted === undefined && run.sameOriginalNativeAfterInput === undefined &&
    ownerFields.every(field => validOwnerId(run.owner?.[field]) && partial?.owner?.[field] === run.owner[field]) &&
    partial?.binding?.session === "w" && [partial.binding.workspaceId, partial.binding.paneId, partial.binding.terminalId].every(validId) &&
    validId(partial.tabId) && validId(partial.initialTabId) && partial.tabId !== partial.initialTabId &&
    validId(partial.initialPaneId) && validId(partial.initialTerminalId) && partial.initialPaneId !== partial.binding.paneId && partial.initialTerminalId !== partial.binding.terminalId &&
    partial.shellPid === run.shellPid && partial.failurePhase === "root-readiness" && partial.layoutVerified === true &&
    ownerFields.every(field => observation?.owner?.[field] === partial.owner[field]) &&
    ["session", "workspaceId", "paneId", "terminalId"].every(field => observation?.binding?.[field] === partial.binding[field]) &&
    observation?.shellPid === partial.shellPid && ["tabId", "initialTabId", "initialPaneId", "initialTerminalId"].every(field => observation[field] === partial[field]) && observation.failurePhase === partial.failurePhase && observation.layoutVerified === true &&
    ownerFields.every(field => closure?.owner?.[field] === partial.owner[field]) &&
    ["session", "workspaceId", "paneId", "terminalId"].every(field => closure?.binding?.[field] === partial.binding[field]) &&
    closure?.shellPid === partial.shellPid && ["tabId", "initialTabId", "initialPaneId", "initialTerminalId"].every(field => closure[field] === partial[field]) && closure.failurePhase === partial.failurePhase && closure.layoutVerified === true &&
    closure.noAgentLaunch === true && closure.closeConfirmed === true &&
    ["ownerAbsent", "workspaceAbsent", "paneAbsent", "terminalAbsent", "tabAbsent"].every(field => closure.after?.[field] === true) &&
    ownerFields.every(field => independent?.owner?.[field] === partial.owner[field]) &&
    ["session", "workspaceId", "paneId", "terminalId"].every(field => independent?.binding?.[field] === partial.binding[field]) &&
    ["tabId", "initialTabId", "initialPaneId", "initialTerminalId"].every(field => independent?.[field] === partial[field]) &&
    ["ownerAbsent", "workspaceAbsent", "paneAbsent", "terminalAbsent", "tabAbsent"].every(field => independent[field] === true) &&
    partial.noAgentLaunch === true && partial.closeConfirmed === true && validReadiness &&
    ["ownerAbsent", "workspaceAbsent", "paneAbsent", "terminalAbsent", "tabAbsent"].every(field => partial.after?.[field] === true) &&
    validId(run.endpoints?.api) && validId(run.endpoints?.client) && run.endpoints.api !== run.endpoints.client &&
    cleanup.mockClosed === true && cleanup.apiClosed === true && cleanup.clientClosed === true;
  const validCapture = explicit.every(validPid) && new Set(explicit).size === explicit.length &&
    capture?.stage === "before-stop" && Array.isArray(capture.roots) &&
    explicit.every(pid => capture.roots.includes(pid)) && capture.roots.every(validPid) &&
    (!partialStage || capture.roots.length === explicit.length && new Set(capture.roots).size === explicit.length) &&
    originals.length > 0 && originals.length <= 1000 && new Set(originals.map(originalKey)).size === originals.length &&
    originals.every(row => validPid(row.pid) && Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 && validSourceToken(row.source, row.startToken)) &&
    capture.roots.every(pid => originals.some(row => row.pid === pid));
  const validStop = Array.isArray(after) && after.length === originals.length && after.every(row => row && typeof row === "object") &&
    new Set(after.map(originalKey)).size === after.length &&
    originals.every(original => after.some(row => row.pid === original.pid && row.parentPid === original.parentPid && row.startToken === original.startToken && row.stage === "after-stop" && row.observation === "exited")) &&
    cleanup.workspaceClosed === true && cleanup.instance?.ownedChildClosed === true && cleanup.instance.apiClosed === true && cleanup.instance.clientClosed === true &&
    !["captureError", "processReadbackError", "workspaceError", "instanceError"].some(key => cleanup[key] !== undefined);
  const partialFields = ["partialWorkspace", "partialWorkspaceObservation", "partialWorkspaceClosure", "partialWorkspaceIndependent", "readinessDiagnostics", "readinessDiagnosticError", "readinessVerified"];
  const valid = run.schemaVersion === 1 && run.platform === "win32" && (partialStage ? validPartial : partialFields.every(field => cleanup[field] === undefined)) && validCapture && validStop;
  return { valid, originals };
};
const observeOriginals = async (run, metadata, observeWindows) => {
  const { valid, originals } = windowsOriginals(run, metadata);
  const targets = [...new Map(originals.map(({ pid, source }) => [`${source}:${pid}`, { pid, source }])).values()];
  const observation = valid ? await observeWindows(targets) : { rows: [], query: null, error: failure("INVALID_ORIGINAL_STOP_EVIDENCE") };
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

const noResourceInitializationFailure = run => run.schemaVersion === 1 && run.resourceStage === "initialization" &&
  typeof run.error === "string" && run.error.length > 0 && run.errorDetails &&
  Number.isFinite(run.errorDetails.elapsedMs) && run.errorDetails.elapsedMs >= 0 &&
  run.endpoints === null && run.receipt === null && run.daemonPid === undefined && run.shellPid === undefined &&
  run.processProofCompleted === undefined && run.sameOriginalNativeAfterInput === undefined &&
  run.initialInputAttempts === 0 && Array.isArray(run.requests) && run.requests.length === 0 &&
  run.cleanup.mockClosed === true && Array.isArray(run.cleanup.windowsQueries) && run.cleanup.windowsQueries.length === 0 &&
  ["processCapture", "originalProcesses", "instance", "workspaceClosed", "partialWorkspace", "partialWorkspaceObservation", "partialWorkspaceClosure", "partialWorkspaceIndependent", "readinessDiagnostics", "readinessDiagnosticError", "readinessVerified", "apiClosed", "clientClosed", "captureError", "processReadbackError", "workspaceError", "instanceError", "preparationProbes", "preparationProbeSetupError"].every(key => run.cleanup[key] === undefined);

export const checkHerdrPlatformCleanup = async (directory, { platform = process.platform, observeWindows = observeWindowsCleanup, requirePartial = false } = {}) => {
  const entries = await readdir(directory);
  const files = entries.filter(file => /^acceptance-(?:argv-)?(codex|copilot)-.*\.json$/.test(file));
  const partialFiles = entries.filter(file => /^acceptance-partial-codex-.*\.json$/.test(file));
  const metadataFiles = entries.filter(file => /^acceptance-windows-metadata-.*\.json$/.test(file));
  const evidence = { checkedAt: new Date().toISOString(), runs: [], failures: [] };
  for (const file of [...files, ...partialFiles]) {
    const run = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    const pids = [...new Set([run.daemonPid, run.shellPid, run.receipt?.helperPid, run.receipt?.childPid, ...(run.cleanup.originalProcesses ?? []).map(row => row.pid)].filter(Boolean))];
    const initializationFailure = run.resourceStage === "initialization";
    const resourcesAbsent = noResourceInitializationFailure(run) === true;
    const processResult = resourcesAbsent ? { resourcesAbsent: true, processes: [], processEvidenceError: null } : platform === "win32" ? await observeOriginals(run, false, observeWindows) : { processes: pids.map(inspectPid) };
    const controlled = partialFiles.includes(file), marker = run.controlledReadinessFailure;
    const validControlled = controlled && platform === "win32" && run.resourceStage === "preparing-workspace" &&
      run.officialNativeIdentification === false && run.controlledArgumentRoundTrip === false &&
      marker?.kind === "after-real-readiness" && marker.realRootVerified === true && marker.shellPid === run.shellPid &&
      marker.totalMs === 20_000 && Number.isSafeInteger(marker.remainingMs) && marker.remainingMs > 0 && marker.remainingMs <= marker.totalMs &&
      run.cleanup?.partialWorkspace?.readyValidation === "verified" && run.cleanup?.readinessDiagnostics?.readyFile?.state === "present" &&
      marker.failureKind === "deadline" && typeof run.error === "string" && run.error.includes("Operation deadline exceeded.") &&
      run.errorDetails?.name === "HerdrAgentActionError" && typeof run.errorDetails.message === "string" && run.errorDetails.message.includes("The original PowerShell root readiness phase failed");
    const livePids = processResult.processes.filter(row => (row.observation === "same-original" || row.observation === "present")).map(row => row.pid), unknownPids = processResult.processes.filter(row => row.observation === "unknown").map(row => row.pid);
    const endpointsClosed = run.endpoints ? await Promise.all(Object.values(run.endpoints).map(endpoint => closedEndpoint(endpoint, platform))) : [];
    const shortLinkRemoved = !run.shortLink || await lstat(run.shortLink).then(() => false, error => error.code === "ENOENT");
    const preparationProbesClosed = !run.cleanup.preparationProbeSetupError && (run.cleanup.preparationProbes ?? []).every(probe => probe.closed === true);
    const windowsQueriesClosed = (run.cleanup.windowsQueries ?? []).every(query => query.closed === true && query.cleanupConfirmed === true);
    const result = { file, resourceState: resourcesAbsent ? "no-resource-initialization-failure" : initializationFailure ? "unconfirmed-initialization" : "started", ...(controlled ? { controlledReadinessFailure: validControlled } : {}), ...processResult, livePids, unknownPids, endpointsClosed, shortLinkRemoved, preparationProbesClosed, windowsQueriesClosed, runtimeDirectoryRemoved: run.cleanup.runtimeDirectoryRemoved === true };
    evidence.runs.push(result);
    if (controlled && !validControlled || !controlled && marker !== undefined || initializationFailure && !resourcesAbsent || platform === "win32" && !resourcesAbsent && !result.processStopped || livePids.length || unknownPids.length || endpointsClosed.some(value => !value) || !shortLinkRemoved || !preparationProbesClosed || !windowsQueriesClosed || !result.runtimeDirectoryRemoved) evidence.failures.push(file);
  }
  for (const agent of ["codex", "copilot"]) if (!files.some(file => file.startsWith(`acceptance-${agent}-`))) evidence.failures.push(`Missing ${agent} completion evidence.`);
  if (platform === "win32" && !files.some(file => file.startsWith("acceptance-argv-codex-"))) evidence.failures.push("Missing Windows ExternalScript argument evidence.");
  if (platform === "win32" && requirePartial && partialFiles.length !== 1) evidence.failures.push("Missing or duplicate controlled Windows partial workspace evidence.");
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
