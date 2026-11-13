import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Operation } from "../../../api/operation.js";
import { verifyToolLaunch, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { captureToolEnvironment } from "../../../platform/tool-environment.js";
import { replaceFileAtomically } from "../../../platform/files.js";
import { syncDurableDirectory } from "../../../platform/durable-directory.js";
import { canonicalResourceOwner, resourceOwnerKey, sameResourceOwner } from "../resource-owner.js";
import type { HerdrExecutionOwner } from "./agents.js";
import { assertOwnedDirectory, launchArgvDigest, mappingFiles, optionalOwnedJson, parseToolReceipt, publishOwnedFile, publishOwnedJson, readToolManifest, toolManifestEnvironment } from "./tool-launch-protocol.js";
import type { HerdrToolLaunchManifest, HerdrToolLaunchReceipt } from "./tool-launch-protocol.js";
import { createMappingProcessLifecycle } from "./tool-launch-lifecycle.js";
import { releaseHerdrJobObserver, retainHerdrJobObserver } from "./tool-launch-windows-job.js";
import { readWindowsProcessMetadata } from "./windows-process-metadata.js";

export type { HerdrToolLaunchReceipt } from "./tool-launch-protocol.js";
export type HerdrToolLaunchMapping = {
  manifestPath: string;
  nonce: string;
  selectionKey: string;
  environment: Readonly<Record<typeof toolManifestEnvironment, string>>;
  windowsCommand?: readonly string[];
  verifyReady(shellPid: number, operation: Operation, shellNonce?: string): Promise<void>;
  readReceipt(operation: Operation): Promise<HerdrToolLaunchReceipt | null>;
  verifyReceipt(args: readonly string[], operation: Operation): Promise<HerdrToolLaunchReceipt>;
  verifyProcesses(input: { shellPid: number; receipt?: HerdrToolLaunchReceipt; foregroundPids?: readonly number[] }, operation: Operation): Promise<void>;
  captureProcesses(pids: readonly number[], operation: Operation, freeze?: boolean): Promise<number[]>;
  confirmStopped(operation: Operation): Promise<boolean>;
  stopProcesses(operation: Operation): Promise<void>;
  releaseFrozen(): Promise<void>;
  retire(operation: Operation): Promise<void>;
};
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const helperEntry = (): string => fileURLToPath(new URL("./tool-launch-child.js", import.meta.url));

/** Functions belong only to the controlled pane shell, never to the native child's PATH. */
export const posixToolMappingRc = (input: { nodeExecutable?: string; childEntry?: string } = {}): string => {
  const node = input.nodeExecutable ?? process.execPath, child = input.childEntry ?? helperEntry();
  if (![node, child].every(value => path.isAbsolute(value) && !/[\r\n\0]/.test(value))) throw new Error("Herdr helper paths must be absolute.");
  return `if [[ -n "\${${toolManifestEnvironment}-}" ]]; then
  daynight_tool_manifest="\$${toolManifestEnvironment}"
  builtin unset ${toolManifestEnvironment}
  builtin export -n daynight_tool_manifest
  codex() { ${shellQuote(node)} ${shellQuote(child)} "$daynight_tool_manifest" codex -- "$@"; }
  copilot() { ${shellQuote(node)} ${shellQuote(child)} "$daynight_tool_manifest" copilot -- "$@"; }
  builtin export -n -f codex copilot
fi
`;
};

const windowsScript = (agent: "codex" | "copilot"): string => `$ErrorActionPreference = 'Stop'
$manifestFile = [Environment]::GetEnvironmentVariable('${toolManifestEnvironment}')
$manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$encodedManifest = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($manifestFile))
$encodedArgs = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($args) -Compress)))
$previousPath = $env:PATH
try {
  if ($null -eq $manifest.nativePath) { Remove-Item Env:PATH -ErrorAction SilentlyContinue } else { $env:PATH = $manifest.nativePath }
  & $manifest.nodeExecutable $manifest.childEntry --encoded-manifest $encodedManifest '${agent}' --encoded-args $encodedArgs
} finally { $env:PATH = $previousPath }
`;
const windowsBootstrap = `$ErrorActionPreference = 'Stop'
$manifestFile = [Environment]::GetEnvironmentVariable('${toolManifestEnvironment}')
$manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$directory = Split-Path -LiteralPath $manifestFile
$env:PATH = $directory + [IO.Path]::PathSeparator + $manifest.nativePath
foreach ($tool in @('codex','copilot')) {
  $command = Get-Command $tool -ErrorAction Stop
  if ($command.CommandType -ne 'ExternalScript' -or $command.Source -ne (Join-Path $directory ($tool + '.ps1'))) { throw 'The owned Herdr ExternalScript mapping was not selected.' }
}
$self = Get-Process -Id $PID
$ready = @{ nonce=$manifest.nonce; pid=$PID; executable=$self.Path; startToken=$self.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress
$temporary = Join-Path $directory ('shell-ready.' + [Guid]::NewGuid().ToString() + '.tmp')
$stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $bytes=[Text.Encoding]::UTF8.GetBytes($ready); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
[IO.File]::Move($temporary,(Join-Path $directory 'shell-ready.json'))
`;
const sameManifest = (left: HerdrToolLaunchManifest, right: HerdrToolLaunchManifest): boolean =>
  sameResourceOwner(left.owner, right.owner) && left.launch.selectionKey === right.launch.selectionKey && left.platform === right.platform &&
  // POSIX anchors the runtime in its controlled shell; Windows owns it in this manifest.
  (left.platform === "win32" || left.nodeExecutable === right.nodeExecutable && left.childEntry === right.childEntry);

/** Reconnect reads the original manifest. It never fills a missing historical selection. */
const createMapping = async (input: {
  directory: string;
  owner: HerdrExecutionOwner;
  launch: ResolvedToolLaunch;
  nativeEnvironment: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  childEntry?: string;
  platform?: NodeJS.Platform;
  existingOnly?: boolean;
}, operation: Operation): Promise<HerdrToolLaunchMapping | null> => {
  operation.check();
  if (input.launch.context !== "herdr" || input.launch.tool === "herdr") throw new Error("A Herdr mapping requires a frozen native agent launch.");
  const owner = canonicalResourceOwner(input.owner), platform = input.platform ?? process.platform;
  if (!["darwin", "linux", "win32"].includes(platform)) throw new Error("The Herdr tool mapping platform is unsupported.");
  const key = createHash("sha256").update(resourceOwnerKey(owner)).update(input.launch.selectionKey).digest("hex");
  const parent = path.join(input.directory, "tool-launch"), registry = path.join(parent, key), indexFile = path.join(registry, "index.json");
  let index: { generation: string } | null;
  try { index = await optionalOwnedJson(indexFile) as { generation: string } | null; }
  catch (cause) { throw new Error("The original Herdr tool manifest cannot be inspected.", { cause }); }
  if (index !== null && (Object.keys(index).join() !== "generation" || typeof index.generation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(index.generation))) throw new Error("The original Herdr mapping generation index is invalid.");
  if (index === null && input.existingOnly) throw new Error("The original Herdr mapping generation index is missing; process ownership remains unknown.");
  let directory = path.join(registry, index?.generation ?? randomUUID());
  let manifestPath = path.join(directory, "manifest.json");
  if (index !== null && !input.existingOnly) {
    const retired = await optionalOwnedJson(path.join(directory, "retired.json"));
    if (retired !== null) {
      const original = await readToolManifest(manifestPath);
      if (JSON.stringify(retired) !== JSON.stringify({ nonce: original.nonce, selectionKey: original.launch.selectionKey, owner: original.owner })) throw new Error("The original Herdr mapping retirement proof is invalid.");
      if (original.platform === "win32") releaseHerdrJobObserver(manifestPath, original);
      directory = path.join(registry, randomUUID()); manifestPath = path.join(directory, "manifest.json");
    }
  }
  const existing = await optionalOwnedJson(manifestPath);
  if (existing === null && index !== null && path.basename(directory) === index.generation) throw new Error("The original Herdr mapping manifest is missing; its generation cannot be recreated.");
  const expected: HerdrToolLaunchManifest = { schemaVersion: 1, owner, nonce: randomUUID(), launch: input.launch,
    nativePath: captureToolEnvironment(input.nativeEnvironment, platform).PATH ?? null, nodeExecutable: input.nodeExecutable ?? process.execPath, childEntry: input.childEntry ?? helperEntry(), platform };
  if (existing === null) {
    await assertOwnedDirectory(input.directory);
    await assertOwnedDirectory(parent, true); await assertOwnedDirectory(registry, true); await assertOwnedDirectory(directory, true);
    await verifyToolLaunch(input.launch, operation);
    try { await publishOwnedJson(manifestPath, expected); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
    const next = { generation: path.basename(directory) };
    if (index === null) await publishOwnedJson(indexFile, next);
    else { await replaceFileAtomically(indexFile, JSON.stringify(next), 0o600); syncDurableDirectory(registry); }
  }
  const manifest = await readToolManifest(manifestPath);
  if (!sameManifest(manifest, expected)) throw new Error("The Herdr tool manifest differs from its frozen execution selection.");
  const files = mappingFiles(manifestPath);
  let windowsCommand: readonly string[] | undefined;
  if (platform === "win32") {
    const systemRoot = input.nativeEnvironment.SystemRoot ?? input.nativeEnvironment.SYSTEMROOT;
    if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) throw new Error("SystemRoot must identify system PowerShell 5 for Herdr tool mappings.");
    const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const bootstrap = path.join(directory, "bootstrap.ps1");
    for (const [file, contents] of [[bootstrap, windowsBootstrap], [path.join(directory, "codex.ps1"), windowsScript("codex")], [path.join(directory, "copilot.ps1"), windowsScript("copilot")]]) {
      if (!input.existingOnly) {
        try { await publishOwnedFile(file!, contents!); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
      }
      const entry = await lstat(file!);
      if (!entry.isFile() || entry.isSymbolicLink() || await readFile(file!, "utf8") !== contents) throw new Error("The original Herdr PowerShell mapping differs from the owned script.");
    }
    windowsCommand = [executable, "-NoProfile", "-NoLogo", "-NoExit", "-File", bootstrap];
  }
  const readReceipt = async (active: Operation): Promise<HerdrToolLaunchReceipt | null> => {
    active.check();
    const value = await optionalOwnedJson(files.receipt);
    if (value === null) return null;
    const receipt = parseToolReceipt(value, manifest), intent = parseToolReceipt(await optionalOwnedJson(files.intent), manifest, false);
    const { childPid: _child, ...withoutChild } = receipt;
    if (JSON.stringify(withoutChild) !== JSON.stringify(intent)) throw new Error("The Herdr tool receipt differs from the original launch intent.");
    return receipt;
  };
  return {
    ...createMappingProcessLifecycle(manifestPath, manifest, input.nativeEnvironment),
    manifestPath, nonce: manifest.nonce, selectionKey: manifest.launch.selectionKey, environment: { [toolManifestEnvironment]: manifestPath }, ...(windowsCommand === undefined ? {} : { windowsCommand }),
    verifyReady: async (shellPid, active, shellNonce) => {
      active.check();
      if (!Number.isSafeInteger(shellPid) || shellPid <= 0) throw new TypeError("Herdr shell readiness requires a positive process identifier.");
      if (windowsCommand === undefined) {
        const nonce = shellNonce ?? manifest.nonce;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce)) throw new TypeError("Herdr shell readiness requires the original canonical nonce.");
        const file = path.join(input.directory, "shell-ready", `${nonce}.${shellPid}`);
        for (;;) {
          active.check();
          let handle;
          try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; await delay(10, undefined, { signal: active.signal }); continue; }
          try {
            const entry = await handle.stat();
            if (!entry.isFile() || entry.size > 128 || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.() || await handle.readFile("utf8") !== `${nonce}\n${shellPid}\n`) throw new Error("The original Bash readiness does not match the owned pane mapping.");
            return;
          } finally { await handle.close(); }
        }
      }
      for (;;) {
        active.check();
        const value = await optionalOwnedJson(files.ready);
        if (value !== null) {
          const row = value as Record<string, unknown>;
          if (row.nonce !== manifest.nonce || row.pid !== shellPid || typeof row.executable !== "string" || row.executable.toLowerCase() !== windowsCommand[0]!.toLowerCase() || typeof row.startToken !== "string" || !/^\d+$/.test(row.startToken)) throw new Error("The original PowerShell readiness does not match the owned root pane.");
          const observed = await readWindowsProcessMetadata(shellPid, active);
          if (observed.executable !== row.executable || observed.startToken !== row.startToken) throw new Error("The original PowerShell root process identity changed.");
          return;
        }
        await delay(10, undefined, { signal: active.signal });
      }
    },
    readReceipt,
    verifyReceipt: async (args, active) => {
      for (;;) {
        active.check();
        const receipt = await readReceipt(active);
        if (receipt !== null) {
          if (receipt.logicalArgvDigest !== launchArgvDigest(manifest.launch.tool, args)) throw new Error("The original Herdr tool launch receipt has different logical arguments.");
          if (manifest.platform === "win32") (await retainHerdrJobObserver(manifestPath, manifest, receipt, active)).check();
          return receipt;
        }
        await delay(10, undefined, { signal: active.signal });
      }
    },
  };
};

const mappingTails = new Map<string, Promise<void>>();
/** The Worker instance lock owns this registry; the queue serializes its local preparations. */
export const createToolLaunchMapping = async (input: Parameters<typeof createMapping>[0], operation: Operation): Promise<HerdrToolLaunchMapping | null> => {
  const key = `${input.directory}\0${resourceOwnerKey(input.owner)}\0${input.launch.selectionKey}`, previous = mappingTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), tail = previous.then(() => gate);
  mappingTails.set(key, tail);
  await previous;
  try { operation.check(); return await createMapping(input, operation); }
  finally { release(); if (mappingTails.get(key) === tail) mappingTails.delete(key); }
};

export { mappingFiles, publishOwnedJson, optionalOwnedJson } from "./tool-launch-protocol.js";
