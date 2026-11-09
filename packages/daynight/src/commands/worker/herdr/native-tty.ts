import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { SessionV2Error } from "../../../session/v2/values.js";

// Darwin libproc.h, sys/proc_info.h, sys/ttycom.h and _stdlib.h define these ABIs.
// proc_bsdinfo is 136 bytes; pbi_pid and e_tdev are at offsets 12 and 108.
// TIOCGWINSZ returns four uint16 fields; only rows and columns are input geometry.
const loadNative = async () => {
  const koffi = await import("koffi"), library = koffi.load("/usr/lib/libSystem.B.dylib");
  return {
    pidInfo: library.func("int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size)"),
    deviceName: library.func("void *devname_r(int32_t device, uint16_t mode, void *buffer, int length)"),
    ioctl: library.func("int ioctl(int fd, unsigned long request, ...)"),
  };
};
let native: ReturnType<typeof loadNative> | undefined;
const kernel = () => native ??= loadNative();
const supported = (valid: boolean): void => { if (process.platform !== "darwin" || !valid) throw new SessionV2Error("unsupported_protocol"); };

/** Resolve only the original shell's controlling PTY, without spawning a command. */
export const readMacProcessTty = async (pid: number, signal: AbortSignal): Promise<string> => {
  supported(Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff);
  signal.throwIfAborted(); const api = await kernel(); signal.throwIfAborted();
  const info = Buffer.alloc(136);
  const length = api.pidInfo(pid, 3, 0, info, info.length) as number;
  signal.throwIfAborted();
  if (length !== info.length || info.readUInt32LE(12) !== pid || (info.readUInt32LE(0) & 0x40) === 0 || info.readUInt32LE(108) === 0xffffffff) throw new SessionV2Error("target_changed");
  const name = Buffer.alloc(128), pointer = api.deviceName(info.readInt32LE(108), 0o020000, name, name.length);
  signal.throwIfAborted();
  const end = name.indexOf(0), value = end > 0 ? name.subarray(0, end).toString("utf8") : "";
  if (pointer === null || !/^ttys[0-9]+$/.test(value)) throw new SessionV2Error("target_changed");
  return `/dev/${value}`;
};

/** A read-only nonblocking descriptor cannot become this process's controlling TTY. */
export const readMacTtySize = async (tty: string, signal: AbortSignal): Promise<{ width: number; height: number }> => {
  supported(/^\/dev\/ttys[0-9]+$/.test(tty));
  signal.throwIfAborted(); const api = await kernel(); signal.throwIfAborted();
  const handle = await open(tty, constants.O_RDONLY | constants.O_NOCTTY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    signal.throwIfAborted(); const entry = await handle.stat(); signal.throwIfAborted();
    if (!entry.isCharacterDevice()) throw new SessionV2Error("target_changed");
    const size = Buffer.alloc(8);
    const result = api.ioctl(handle.fd, 0x40087468, "void *", size) as number;
    signal.throwIfAborted();
    if (result !== 0) throw new SessionV2Error("target_changed");
    return { width: size.readUInt16LE(2), height: size.readUInt16LE(0) };
  } finally { await handle.close(); }
};
