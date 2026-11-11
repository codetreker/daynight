import * as koffi from "koffi";

if (process.platform !== "win32" || !process.send) throw new Error("Executable sharing control requires Windows IPC.");
const kernel = koffi.load("kernel32.dll");
const createFile = kernel.func("uintptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, uintptr_t template)");
const closeHandle = kernel.func("int __stdcall CloseHandle(uintptr_t handle)");
const lastError = kernel.func("uint32_t __stdcall GetLastError()");
const invalid = (1n << BigInt(koffi.sizeof("uintptr_t") * 8)) - 1n;
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
let handle, timer, failure;
const released = new Promise((resolve, reject) => {
  process.once("message", message => message?.kind === "release" ? resolve() : reject(new Error("Unexpected holder command.")));
  process.once("disconnect", () => reject(new Error("Holder parent disconnected before release.")));
  timer = setTimeout(() => reject(new Error("Executable holder deadline expired.")), 8000);
});
// Attach a handler before native preparation can fail.
void released.catch(() => {});
try {
  // Permit reads and writes, but retain a real kernel denial of delete sharing.
  const opened = createFile(process.argv[2], 0x80000000, 3, null, 3, 0x80, 0);
  if (BigInt(opened) === invalid) throw new Error(`CreateFileW failed (${lastError()}).`);
  handle = opened;
  await send({ kind: "held", pid: process.pid });
  await released;
} catch (error) { failure = error; }
finally {
  clearTimeout(timer);
  if (handle !== undefined && closeHandle(handle) === 0) {
    const error = new Error(`CloseHandle failed (${lastError()}).`);
    failure = failure === undefined ? error : new AggregateError([failure, error], "Executable holder and release failed.");
  }
}
try {
  await send(failure === undefined ? { kind: "released" } : { kind: "failed", message: String(failure) });
} finally { if (process.connected) process.disconnect(); }
if (failure !== undefined) throw failure;
