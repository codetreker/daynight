import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Operation } from "../../../src/api/operation.js";
import type { HerdrCommand, HerdrSpawn } from "../../../src/commands/worker/herdr/command.js";
type Stage = "external-script" | "processes" | "console";
type Checkpoint = "entry" | "cim-complete" | "projection-complete" | "type-complete" | "attach-complete" | "json-complete" | "assembly-complete" | "wmi-get-returned" | "envelope-complete" | "members-complete";
/** Diagnostics never supply OS evidence. Retain only a complete allowlisted line,
 * with bounded storage even when stderr contains an unterminated private value.
 */
export const createWindowsQueryCheckpointObserver = (stage: Stage, checkpoint: (value: Checkpoint) => void): ((chunk: Buffer) => void) => {
  const allowed: readonly Checkpoint[] = stage === "processes" ? ["entry", "cim-complete", "assembly-complete", "wmi-get-returned", "projection-complete", "json-complete", "envelope-complete"] : stage === "console" ? ["entry", "type-complete", "attach-complete", "members-complete", "json-complete", "envelope-complete"] : [];
  let line = "", discarded = false;
  return chunk => {
    for (const byte of chunk) {
      if (byte === 10) {
        if (!discarded) {
          const value = line.replace(/\r$/, "");
          for (const known of allowed) if (value === `DAYNIGHT_QUERY:${known}`) checkpoint(known);
        }
        line = ""; discarded = false;
      } else if (!discarded) {
        if (line.length >= 80 || (byte !== 13 && (byte < 32 || byte > 126))) { line = ""; discarded = true; }
        else line += String.fromCharCode(byte);
      }
    }
  };
};
export type WindowsQueryObservation = { stage: Stage; elapsedMs: number; code: number | string | null; killed: boolean | null; signal: string | null; stdoutBytes: number; stderrBytes: number; closed: boolean; cleanupConfirmed: boolean; errorType: string | null; lastCheckpoint?: Checkpoint | null };
const validateWindowsProcessTargets = (pids: readonly number[]) => {
  if (pids.length !== 3 || new Set(pids).size !== 3 || pids.some(pid => !Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff)) throw new Error("The independent Windows process query requires three distinct uint32 PIDs.");
};
/** System.Management is independent of the production Win32 metadata reader.
 * Dispose every WMI object before publishing the complete ASCII envelope.
 * https://learn.microsoft.com/en-us/dotnet/api/system.management.managementobjectsearcher
 */
export const windowsProcessQuery = (pids: readonly number[]): string => {
  validateWindowsProcessTargets(pids);
  const query = "SELECT ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE " + pids.map(pid => `ProcessId=${pid}`).join(" OR ");
  return `$ErrorActionPreference='Stop';
[Console]::Error.WriteLine('DAYNIGHT_QUERY:entry'); [Console]::Error.Flush();
$null=[System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');
[Console]::Error.WriteLine('DAYNIGHT_QUERY:assembly-complete'); [Console]::Error.Flush();
function Encode([string]$value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }
$lines=[Collections.Generic.List[string]]::new(); $lines.Add('DAYNIGHT_WINDOWS_WMI_V1'); $lines.Add((Encode ($PSVersionTable.PSVersion.ToString())));
$searcher=[System.Management.ManagementObjectSearcher]::new('root\\cimv2','${query}');
try {
  $collection=$searcher.Get();
  try {
    if($collection -isnot [System.Management.ManagementObjectCollection] -or $collection -isnot [System.IDisposable]) { throw 'The independent WMI collection identity was lost.' }
    [Console]::Error.WriteLine('DAYNIGHT_QUERY:wmi-get-returned'); [Console]::Error.Flush();
    $iterator=$collection.GetEnumerator();
    try {
      while($iterator.MoveNext()) {
        $row=$iterator.Current;
        try {
          $birth=[string]$row['CreationDate'];
          if($birth -cnotmatch '^[0-9]{14}\\.[0-9]{6}[+-][0-9]{3}$') { throw 'The independent WMI birth is incomplete.' }
          $ticks=[System.Management.ManagementDateTimeConverter]::ToDateTime($birth).ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);
          $fields=[string[]]@(([uint32]$row['ProcessId']).ToString([Globalization.CultureInfo]::InvariantCulture),([uint32]$row['ParentProcessId']).ToString([Globalization.CultureInfo]::InvariantCulture),(Encode ([string]$row['ExecutablePath'])),(Encode ([string]$row['CommandLine'])),$birth,$ticks);
          $lines.Add([string]::Join([string][char]9,$fields));
        } finally { ([System.IDisposable]$row).Dispose() }
      }
      [Console]::Error.WriteLine('DAYNIGHT_QUERY:projection-complete'); [Console]::Error.Flush();
    } finally { ([System.IDisposable]$iterator).Dispose() }
  } finally { if($collection -is [System.IDisposable]) { ([System.IDisposable]$collection).Dispose() } }
} finally { ([System.IDisposable]$searcher).Dispose() }
[Console]::Error.WriteLine('DAYNIGHT_QUERY:envelope-complete'); [Console]::Error.Flush();
[Console]::Out.Write([string]::Join([string][char]10,$lines.ToArray()));`;
};
export type WindowsProcessQueryResult = { version: string; processes: { ProcessId: number; ParentProcessId: number; ExecutablePath: string; CommandLine: string; CreationDate: string; CreationDateTicks: string }[] };
const decodeWindowsQueryField = (field: string): string => {
  const bytes = Buffer.from(field, "base64");
  if (!field || bytes.toString("base64") !== field) throw new Error("Invalid independent WMI field.");
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!value.trim() || value.includes("\0")) throw new Error("Incomplete independent WMI field.");
  return value;
};
const windowsWmiBirthTicks = (birth: string): string => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(birth);
  if (!match) throw new Error("Incomplete independent WMI birth.");
  const [year, month, day, hour, minute, second, microseconds] = match.slice(1, 8).map(Number) as [number, number, number, number, number, number, number];
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second), date = new Date(milliseconds);
  if (year < 1601 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw new Error("Invalid independent WMI birth.");
  const offset = Number(match[9]) * (match[8] === "+" ? 1 : -1);
  return (BigInt(milliseconds - offset * 60_000) * 10_000n + BigInt(microseconds) * 10n + 621355968000000000n).toString();
};
export const decodeWindowsProcessQuery = (stdout: string, pids: readonly number[], observations: WindowsQueryObservation[] = []): WindowsProcessQueryResult => {
  try {
    validateWindowsProcessTargets(pids);
    if (Buffer.byteLength(stdout) > 64 * 1024) throw new Error("Oversized independent WMI envelope.");
    const lines = stdout.split("\n");
    if (lines.length !== 5 || lines[0] !== "DAYNIGHT_WINDOWS_WMI_V1") throw new Error("Incomplete independent WMI envelope.");
    const version = decodeWindowsQueryField(lines[1]!);
    if (!/^5\.1\.\d+\.\d+$/.test(version)) throw new Error("The independent WMI oracle requires PS5.");
    const processes = lines.slice(2).map(line => {
      const fields = line.split("\t");
      if (fields.length !== 6) throw new Error("Incomplete independent WMI process.");
      const [pid, parent, executable, commandLine, birth, ticks] = fields as [string, string, string, string, string, string];
      if (![pid, parent].every(value => /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 0xffff_ffff) || !pids.includes(Number(pid))) throw new Error("Invalid independent WMI PID.");
      const ExecutablePath = decodeWindowsQueryField(executable), CommandLine = decodeWindowsQueryField(commandLine);
      if (!path.win32.isAbsolute(ExecutablePath) || path.win32.parse(ExecutablePath).root.length <= 1 || /[\r\n]/.test(ExecutablePath) || windowsWmiBirthTicks(birth) !== ticks) throw new Error("Invalid independent WMI process identity.");
      return { ProcessId: Number(pid), ParentProcessId: Number(parent), ExecutablePath, CommandLine, CreationDate: birth, CreationDateTicks: ticks };
    });
    if (new Set(processes.map(row => row.ProcessId)).size !== 3) throw new Error("Duplicate independent WMI process.");
    return { version, processes };
  } catch {
    const observation = observations.at(-1);
    if (observation?.stage === "processes") observation.errorType = "InvalidWindowsProcesses";
    throw new Error(`The independent Windows process proof is incomplete (stdoutBytes=${Buffer.byteLength(stdout)}).`);
  }
};
/** Emits the original console P/Invoke signatures entirely in the query process.
 * No compiler, assembly file, module auto-loading, or extra process supplies it.
 * https://learn.microsoft.com/en-us/dotnet/api/system.reflection.emit.typebuilder.definepinvokemethod
 */
export const windowsConsoleQuery = (pid: number): string => {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff) throw new Error("The independent console query requires an original uint32 PID.");
  return `$ErrorActionPreference='Stop';
[Console]::Error.WriteLine('DAYNIGHT_QUERY:entry'); [Console]::Error.Flush();
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('DaynightIndependentConsole'),[Reflection.Emit.AssemblyBuilderAccess]::Run);
$typeBuilder=$assembly.DefineDynamicModule('Console').DefineType('NativeConsole',[Reflection.TypeAttributes]::Public);
$methodAttributes=[Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl;
$importType=[Runtime.InteropServices.DllImportAttribute]; $importConstructor=$importType.GetConstructor([type[]]@([string]));
$importFields=[Reflection.FieldInfo[]]@($importType.GetField('EntryPoint'),$importType.GetField('SetLastError'),$importType.GetField('CallingConvention'),$importType.GetField('CharSet'),$importType.GetField('ExactSpelling'),$importType.GetField('PreserveSig'));
function DefineNative([string]$name,[type]$returnType,[type[]]$parameters) {
  $method=$typeBuilder.DefineMethod($name,$methodAttributes,$returnType,$parameters);
  $values=[object[]]@($name,$true,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::None,$false,$true);
  $method.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new($importConstructor,[object[]]@('kernel32.dll'),$importFields,$values));
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig);
  if($returnType -eq [bool]) {
    $return=$method.DefineParameter(0,[Reflection.ParameterAttributes]::Retval,$null);
    $return.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new([Runtime.InteropServices.MarshalAsAttribute].GetConstructor([type[]]@([Runtime.InteropServices.UnmanagedType])),[object[]]@([Runtime.InteropServices.UnmanagedType]::Bool)));
  }
  if($name -eq 'GetConsoleProcessList') { $null=$method.DefineParameter(1,[Reflection.ParameterAttributes]::Out,'ids') }
}
DefineNative 'FreeConsole' ([bool]) ([type[]]@());
DefineNative 'AttachConsole' ([bool]) ([type[]]@([uint32]));
DefineNative 'GetConsoleProcessList' ([uint32]) ([type[]]@([uint32[]],[uint32]));
$native=$typeBuilder.CreateType();
foreach($name in [string[]]@('FreeConsole','AttachConsole','GetConsoleProcessList')) {
  $method=$native.GetMethod($name); $imports=$method.GetCustomAttributes($importType,$false);
  if(!$method.IsPublic -or !$method.IsStatic -or ($method.Attributes -band [Reflection.MethodAttributes]::PinvokeImpl) -eq 0 -or $imports.Length -ne 1) { throw 'The independent console import is incomplete.' }
  $import=$imports[0];
  if($import.Value -cne 'kernel32.dll' -or $import.EntryPoint -cne $name -or !$import.SetLastError -or !$import.PreserveSig -or $import.CallingConvention -ne [Runtime.InteropServices.CallingConvention]::Winapi -or $import.CharSet -ne [Runtime.InteropServices.CharSet]::None -or $import.ExactSpelling -or ($method.GetMethodImplementationFlags() -band [Reflection.MethodImplAttributes]::PreserveSig) -eq 0) { throw 'The independent console import metadata changed.' }
  if($name -ne 'GetConsoleProcessList') {
    $returns=$method.ReturnParameter.GetCustomAttributes([Runtime.InteropServices.MarshalAsAttribute],$false);
    if($method.ReturnType -ne [bool] -or $returns.Length -ne 1 -or $returns[0].Value -ne [Runtime.InteropServices.UnmanagedType]::Bool) { throw 'The independent console BOOL metadata changed.' }
  }
}
$free=$native.GetMethod('FreeConsole').GetParameters(); $attach=$native.GetMethod('AttachConsole').GetParameters(); $list=$native.GetMethod('GetConsoleProcessList'); $listParameters=$list.GetParameters();
if($free.Length -ne 0 -or $attach.Length -ne 1 -or $attach[0].ParameterType -ne [uint32] -or $list.ReturnType -ne [uint32] -or $listParameters.Length -ne 2 -or $listParameters[0].ParameterType -ne [uint32[]] -or !$listParameters[0].IsOut -or $listParameters[0].IsIn -or $listParameters[1].ParameterType -ne [uint32]) { throw 'The independent console signature changed.' }
[Console]::Error.WriteLine('DAYNIGHT_QUERY:type-complete'); [Console]::Error.Flush();
$null=$native::FreeConsole(); $attached=$false; $detached=$false; $members=[Collections.Generic.List[string]]::new();
try {
  $attached=$native::AttachConsole(${pid});
  $attachError=[Runtime.InteropServices.Marshal]::GetLastWin32Error();
  [Console]::Error.WriteLine('DAYNIGHT_QUERY:attach-complete'); [Console]::Error.Flush();
  if(!$attached) { throw 'The independent console attachment failed.' }
  $ids=[uint32[]]::new(256); $count=$native::GetConsoleProcessList($ids,256);
  if($count -eq 0 -or $count -gt 256) { throw 'The independent console member list is incomplete.' }
  for($index=0; $index -lt $count; $index++) { $members.Add($ids[$index].ToString([Globalization.CultureInfo]::InvariantCulture)) }
  [Console]::Error.WriteLine('DAYNIGHT_QUERY:members-complete'); [Console]::Error.Flush();
} finally {
  if($attached) {
    $detached=$native::FreeConsole();
    if(!$detached) { throw 'The independent console detach is unconfirmed.' }
  }
}
$version=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PSVersionTable.PSVersion.ToString()));
$errorCode=([long]$attachError -band 4294967295L).ToString([Globalization.CultureInfo]::InvariantCulture);
$fields=[string[]]@('1',$errorCode,$count.ToString([Globalization.CultureInfo]::InvariantCulture),'1',[string]::Join(',',$members.ToArray()));
[Console]::Error.WriteLine('DAYNIGHT_QUERY:envelope-complete'); [Console]::Error.Flush();
[Console]::Out.Write([string]::Join([string][char]10,[string[]]@('DAYNIGHT_WINDOWS_CONSOLE_V1',$version,[string]::Join([string][char]9,$fields))));`;
};
export type WindowsConsoleQueryResult = { version: string; attached: true; errorCode: number; count: number; detached: true; processIds: number[] };
export const decodeWindowsConsoleQuery = (stdout: string, pids: readonly number[], observations: WindowsQueryObservation[] = []): WindowsConsoleQueryResult => {
  try {
    validateWindowsProcessTargets(pids);
    if (Buffer.byteLength(stdout) > 64 * 1024) throw new Error("Oversized independent console envelope.");
    const lines = stdout.split("\n");
    if (lines.length !== 3 || lines[0] !== "DAYNIGHT_WINDOWS_CONSOLE_V1") throw new Error("Incomplete independent console envelope.");
    const version = decodeWindowsQueryField(lines[1]!);
    if (!/^5\.1\.\d+\.\d+$/.test(version)) throw new Error("The independent console observer requires PS5.");
    const fields = lines[2]!.split("\t");
    if (fields.length !== 5) throw new Error("Incomplete independent console fields.");
    const [attached, error, count, detached, members] = fields as [string, string, string, string, string];
    const uint32 = (value: string) => /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 0xffff_ffff;
    if (attached !== "1" || detached !== "1" || !uint32(error) || !uint32(count) || Number(count) < 1 || Number(count) > 256) throw new Error("The independent console observation is incomplete.");
    const values = members.split(",");
    if (values.length !== Number(count) || values.some(value => !uint32(value) || Number(value) === 0)) throw new Error("The independent console member list is incomplete.");
    const processIds = values.map(Number);
    if (new Set(processIds).size !== processIds.length || !pids.every(pid => processIds.includes(pid))) throw new Error("The original processes do not share the observed console.");
    return { version, attached: true, errorCode: Number(error), count: Number(count), detached: true, processIds };
  } catch {
    const observation = observations.at(-1);
    if (observation?.stage === "console") observation.errorType = "InvalidWindowsConsole";
    throw new Error(`The independent Windows console proof is incomplete (stdoutBytes=${Buffer.byteLength(stdout)}).`);
  }
};
/** Observer execution belongs to the test harness. Native/daemon environments
 * remain inputs under test; provider and agent configuration is never copied.
 */
export const prepareWindowsObserverEnvironment = async (root: string, harness: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> => {
  const entries = Object.entries(harness), environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "SystemDrive", "ComSpec", "WINDIR", "OS", "PATH", "PATHEXT", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432"]) {
    const value = entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (value !== undefined) environment[name] = value;
  }
  if (!environment.SystemRoot || !path.win32.isAbsolute(environment.SystemRoot)) throw new Error("The Windows observer requires the harness's absolute SystemRoot.");
  if (!path.isAbsolute(root)) throw new Error("The Windows observer requires an absolute task directory.");
  const directory = path.join(root, "observer"), home = path.join(directory, "home"), appData = path.join(home, "AppData"), roaming = path.join(appData, "Roaming"), local = path.join(appData, "Local"), temporary = path.join(directory, "tmp");
  for (const target of [directory, home, appData, roaming, local, temporary]) {
    try { await mkdir(target, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("The Windows observer requires ordinary task-owned directories.");
  }
  // Supplies the selected system PS5 module path; PowerShell may expand the
  // effective path with other installation locations during startup.
  // https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-5.1
  return { ...environment, HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temporary, TMP: temporary,
    PSModulePath: path.win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") };
};
export const decodeWindowsPlatformJson = (stage: Stage, stdout: string, observations: WindowsQueryObservation[]): unknown => {
  try { return JSON.parse(stdout); }
  catch {
    const observation = observations.at(-1);
    if (observation?.stage === stage) observation.errorType = "InvalidJson";
    throw new Error(`The independent Windows ${stage} query did not produce complete JSON (stdoutBytes=${Buffer.byteLength(stdout)}).`);
  }
};
/** Fixed UTF-8 fields avoid JSON modules and console-code-page substitution. */
export const windowsExternalScriptQuery = (source: string): string => "$ErrorActionPreference='Stop'; $c=Get-Command -CommandType ExternalScript -Name '" + source.replaceAll("'", "''") + "' -ErrorAction Stop; $text=[string]::Join(\"`n\",[string[]]@($PSVersionTable.PSVersion.ToString(),$c.CommandType.ToString(),$c.Source)); [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)))";
export const decodeWindowsExternalScript = (stdout: string, observations: WindowsQueryObservation[] = []): { version: string; type: string; source: string } => {
  try {
    const envelope = stdout.trim(), bytes = Buffer.from(envelope, "base64");
    if (!envelope || bytes.toString("base64") !== envelope) throw new Error("Invalid Base64 envelope.");
    const fields = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n");
    if (fields.length !== 3 || fields.some(field => field.length === 0 || /[\0\r]/.test(field))) throw new Error("Incomplete ExternalScript fields.");
    return { version: fields[0]!, type: fields[1]!, source: fields[2]! };
  } catch {
    const observation = observations.at(-1);
    if (observation?.stage === "external-script") observation.errorType = "InvalidExternalScript";
    throw new Error(`The independent ExternalScript proof is incomplete (stdoutBytes=${Buffer.byteLength(stdout)}).`);
  }
};

/** Only transport is shared with production. Each script remains an independent
 * OS observation, using its caller's explicit environment and the original
 * ten-second request limit.
 */
export const runWindowsPlatformQuery = async (stage: Stage, input: HerdrCommand, operation: Operation, observations: WindowsQueryObservation[]): Promise<string> => {
  const command = await import(new URL("../../../dist/commands/worker/herdr/command.js", import.meta.url).href) as typeof import("../../../src/commands/worker/herdr/command.js");
  const observation: WindowsQueryObservation = { stage, elapsedMs: 0, code: null, killed: null, signal: null, stdoutBytes: 0, stderrBytes: 0, closed: false, cleanupConfirmed: false, errorType: null, lastCheckpoint: null };
  const started = performance.now();
  const observeCheckpoint = createWindowsQueryCheckpointObserver(stage, value => { observation.lastCheckpoint = value; });
  const start: HerdrSpawn = (file, args, options) => {
    const child = command.spawnHerdrProcess(file, args, { ...options, ...(process.platform === "win32" ? { detached: false, windowsHide: false } : {}) });
    child.stdout?.on("data", (value: Buffer) => { observation.stdoutBytes += value.length; });
    child.stderr?.on("data", (value: Buffer) => { observation.stderrBytes += value.length; observeCheckpoint(value); });
    child.once("close", (code, signal) => { observation.closed = true; if (typeof observation.code !== "string") observation.code = code; observation.signal = signal; observation.killed = child.killed; });
    child.once("error", error => { const code = (error as NodeJS.ErrnoException).code; if (typeof code === "string" && /^E[A-Z0-9_]{1,63}$/.test(code)) observation.code = code; });
    return child;
  };
  try {
    const result = await command.runHerdrCommand(input, operation, start);
    observation.cleanupConfirmed = observation.closed;
    if (!observation.closed) throw new Error("The independent Windows query close is unconfirmed.");
    observation.elapsedMs = Math.round(performance.now() - started);
    return result.stdout;
  } catch (error) {
    observation.cleanupConfirmed = observation.closed && !command.hasUnconfirmedHerdrCommandCleanup(error);
    observation.errorType = error instanceof command.HerdrCommandCleanupError ? "HerdrCommandCleanupError" : error instanceof command.HerdrCommandDeadlineError ? "HerdrCommandDeadlineError" : error instanceof command.HerdrCommandError ? "HerdrCommandError" : error instanceof RangeError ? "RangeError" : "Error";
    observation.elapsedMs = Math.round(performance.now() - started);
    // Error causes may include EncodedCommand and output. Keep only the bounded
    // observation, and preserve cleanup uncertainty in the caller's evidence.
    throw new Error(`The independent Windows ${stage} query failed: ${JSON.stringify(observation)}.`);
  } finally { observations.push(observation); }
};
