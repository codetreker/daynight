import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";

type EventKind = "execution-observed" | "spawn" | "exit" | "close" | "stdout-close" | "stderr-close" |
  "execution-completed" | "test-handle-opened" | "test-handle-closed" | "unlink-start" | "unlink-error" | "unlink-success";
type UnlinkError = { code: string | null; errno: number | null; syscall: "unlink" | "rmdir" | null };
const errorFields = (error: unknown): UnlinkError => {
  const value: Partial<NodeJS.ErrnoException> = error !== null && typeof error === "object" ? error as NodeJS.ErrnoException : {};
  return {
    code: typeof value.code === "string" && /^E[A-Z0-9_]{1,30}$/.test(value.code) ? value.code : null,
    errno: typeof value.errno === "number" && Number.isSafeInteger(value.errno) ? value.errno : null,
    syscall: value.syscall === "unlink" || value.syscall === "rmdir" ? value.syscall : null,
  };
};

/** Observations only: a completed child does not identify a file's remaining holder. */
export class ToolUnlinkDiagnostics {
  private readonly started = performance.now();
  private readonly events: { sequence: number; elapsedMs: number; kind: EventKind; error?: UnlinkError }[] = [];
  private readonly process = {
    pid: null as number | null, identityPrecision: "pid-only" as const, birth: null,
    spawnObserved: false, exitObserved: false, closeObserved: false,
    stdoutCloseObserved: false, stderrCloseObserved: false, executionCompleted: false,
    exitCode: null as number | null, signal: null as NodeJS.Signals | null,
  };
  private testHandleOpen = false;

  private record(kind: EventKind, error?: UnlinkError): void {
    this.events.push({ sequence: this.events.length + 1, elapsedMs: performance.now() - this.started, kind, ...(error ? { error } : {}) });
  }

  observe(child: ChildProcess): void {
    this.process.pid = child.pid ?? null;
    this.record("execution-observed");
    child.once("spawn", () => { this.process.spawnObserved = true; this.record("spawn"); });
    child.once("exit", (code, signal) => {
      this.process.exitObserved = true; this.process.exitCode = code; this.process.signal = signal; this.record("exit");
    });
    child.once("close", () => { this.process.closeObserved = true; this.record("close"); });
    child.stdout?.once("close", () => { this.process.stdoutCloseObserved = true; this.record("stdout-close"); });
    child.stderr?.once("close", () => { this.process.stderrCloseObserved = true; this.record("stderr-close"); });
  }

  executionCompleted(): void { this.process.executionCompleted = true; this.record("execution-completed"); }
  testHandleOpened(): void { this.testHandleOpen = true; this.record("test-handle-opened"); }
  testHandleClosed(): void { this.testHandleOpen = false; this.record("test-handle-closed"); }

  receipt() {
    // Whitelist facts; Error message/stack/path, argv, streams and environment
    // may contain user paths or secrets. PID is not a native birth identity.
    return structuredClone({
      version: 1, kind: "tool-executable-unlink", target: "<fixture>/worker-node.exe", commandKind: "node-script",
      process: this.process,
      holder: this.testHandleOpen ? { kind: "test-owned-handle-present", pid: process.pid } : { kind: "unknown", pid: null },
      events: this.events,
    });
  }

  async unlink(file: string, remove: (file: string) => Promise<void> = rm): Promise<void> {
    this.record("unlink-start");
    try { await remove(file); this.record("unlink-success"); }
    catch (error) {
      this.record("unlink-error", errorFields(error));
      try { console.error(JSON.stringify(this.receipt())); }
      finally { throw error; }
    }
  }
}

/** A known test owner denies deletion; ordinary Node read handles share it. */
export const holdToolFileWithoutDeleteSharing = async (file: string, diagnostics?: ToolUnlinkDiagnostics): Promise<() => void> => {
  const koffi = await import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const create = kernel.func("uintptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, uintptr_t template)");
  const close = kernel.func("int __stdcall CloseHandle(uintptr_t handle)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const handle = create(file, 0x80000000, 3, null, 3, 0x80, 0);
  if (BigInt(handle) === (1n << BigInt(koffi.sizeof("uintptr_t") * 8)) - 1n) throw new Error(`Fixture CreateFileW failed (Win32 ${lastError()}).`);
  diagnostics?.testHandleOpened();
  return () => {
    if (close(handle) === 0) throw new Error(`Fixture CloseHandle failed (Win32 ${lastError()}).`);
    diagnostics?.testHandleClosed();
  };
};
