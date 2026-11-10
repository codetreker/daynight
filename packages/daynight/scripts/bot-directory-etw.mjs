import path from "node:path";
import * as koffi from "koffi";

if (process.platform !== "win32" || koffi.sizeof("uintptr_t") !== 8) throw new Error("Bot directory ETW evidence requires Windows x64.");
const [operation, value] = process.argv.slice(2);
if (operation === "aliases") {
  if (value === undefined) throw new Error("A workspace path is required.");
  const root = path.win32.resolve(value), drive = path.win32.parse(root).root.slice(0, 2);
  if (!/^[A-Za-z]:$/.test(drive)) throw new Error("The diagnostic workspace must use a local drive.");
  const kernel = koffi.load("kernel32.dll"), query = kernel.func("uint32_t __stdcall QueryDosDeviceW(str16 name, void *target, uint32_t length)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const target = Buffer.alloc(65536), length = query(drive, target, target.length / 2);
  if (length === 0) throw new Error(`QueryDosDeviceW failed (${lastError()}).`);
  const device = target.subarray(0, length * 2).toString("utf16le").split("\0")[0];
  if (!device?.startsWith("\\Device\\")) throw new Error("The workspace drive has no native device mapping.");
  console.log(JSON.stringify({ drive, device }));
} else if (operation === "threads") {
  const kernel = koffi.load("kernel32.dll");
  const snapshot = kernel.func("uintptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)");
  const first = kernel.func("int __stdcall Thread32First(uintptr_t snapshot, void *entry)");
  const next = kernel.func("int __stdcall Thread32Next(uintptr_t snapshot, void *entry)");
  const close = kernel.func("int __stdcall CloseHandle(uintptr_t handle)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const startedAt = new Date().toISOString(), handle = snapshot(4, 0), capturedAt = new Date().toISOString();
  if (BigInt(handle) === 0xffffffffffffffffn) throw new Error(`CreateToolhelp32Snapshot failed (${lastError()}).`);
  const threads = [];
  let failure;
  try {
    const entry = Buffer.alloc(28); entry.writeUInt32LE(entry.length);
    let found = first(handle, entry);
    while (found !== 0) {
      if (threads.length === 100_000 || entry.readUInt32LE() < 16) throw new Error("Invalid bounded thread snapshot.");
      threads.push({ tid: entry.readUInt32LE(8), pid: entry.readUInt32LE(12) });
      entry.writeUInt32LE(entry.length);
      found = next(handle, entry);
    }
    if (lastError() !== 18) throw new Error(`Thread enumeration failed (${lastError()}).`);
  } catch (error) { failure = error; }
  if (close(handle) === 0) {
    const cleanup = new Error(`Thread snapshot CloseHandle failed (${lastError()}).`);
    failure = failure === undefined ? cleanup : new AggregateError([failure, cleanup], "Thread snapshot and cleanup failed.", { cause: failure });
  }
  if (failure !== undefined) throw failure;
  console.log(JSON.stringify({ startedAt, capturedAt, threads }));
} else if (operation === "stop-job") {
  if (value === undefined || !/^Local\\Daynight-Bot-Directory-[0-9a-f-]{36}$/.test(value)) throw new Error("An owned diagnostic Job identity is required.");
  const kernel = koffi.load("kernel32.dll");
  const open = kernel.func("void * __stdcall OpenJobObjectW(uint32_t access, int inherit, str16 name)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const handle = open(0xc, 0, value);
  if (handle === null) {
    if (lastError() !== 2) throw new Error(`OpenJobObjectW failed (${lastError()}).`);
    console.log(JSON.stringify({ job: value, absent: true, stopped: true }));
  } else {
    const api = await (await import("../dist/platform/windows-job.js")).loadWindowsJobKernel();
    let failure;
    try {
      api.terminate(handle);
      const deadline = Date.now() + 5000;
      while (api.active(handle) !== 0 || api.inspect(handle).length !== 0) {
        if (Date.now() >= deadline) throw new Error("Diagnostic Job did not stop completely.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } catch (error) { failure = error; }
    try { api.close(handle); } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Diagnostic Job cleanup failed.", { cause: failure }); }
    if (failure !== undefined) throw failure;
    console.log(JSON.stringify({ job: value, absent: false, stopped: true }));
  }
} else if (operation === "stop") {
  if (value === undefined || !/^daynight-bot-directory-[0-9a-f-]{36}$/.test(value)) throw new Error("A scoped diagnostic session identity is required.");
  const api = koffi.load("advapi32.dll");
  const control = api.func("uint32_t __stdcall ControlTraceW(uint64_t session, str16 name, void *properties, uint32_t code)");
  // EVENT_TRACE_PROPERTIES contains a 48-byte WNODE_HEADER and these ULONG
  // counters before the x64 LoggerThreadId; strings follow the 120-byte struct.
  // https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties
  const data = Buffer.alloc(4096);
  data.writeUInt32LE(data.length, 0);
  data.writeUInt32LE(120, 116);
  data.writeUInt32LE(1144, 112);
  const status = control(0, value, data, 1);
  if (status !== 0) throw Object.assign(new Error(`ControlTraceW stop failed (${status}).`), { code: status });
  console.log(JSON.stringify({ session: value, stopped: true, eventsLost: data.readUInt32LE(88), buffersWritten: data.readUInt32LE(92),
    logBuffersLost: data.readUInt32LE(96), realTimeBuffersLost: data.readUInt32LE(100), maximumFileSizeMiB: data.readUInt32LE(60) }));
} else throw new Error("Unknown Bot directory ETW operation.");
