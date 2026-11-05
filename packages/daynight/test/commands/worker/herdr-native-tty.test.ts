import { constants } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ pidInfo: vi.fn(), devname: vi.fn(), ioctl: vi.fn(), open: vi.fn(), stat: vi.fn(), close: vi.fn(), spawn: vi.fn() }));
vi.mock("koffi", () => ({ load: () => ({ func: (signature: string) => signature.includes("proc_pidinfo") ? f.pidInfo : signature.includes("devname_r") ? f.devname : f.ioctl }) }));
vi.mock("node:fs/promises", () => ({ open: f.open }));
vi.mock("node:child_process", () => ({ execFile: f.spawn }));
import { readMacProcessTty, readMacTtySize } from "../../../src/commands/worker/herdr/native-tty.js";
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  f.pidInfo.mockImplementation((pid: number, _flavor: number, _arg: number, buffer: Buffer) => { buffer.writeUInt32LE(0x40, 0); buffer.writeUInt32LE(pid, 12); buffer.writeUInt32LE(42, 108); return 136; });
  f.devname.mockImplementation((_dev: number, _mode: number, buffer: Buffer) => { buffer.write("ttys017\0"); return 1; });
  f.ioctl.mockImplementation((_fd: number, _command: number, _type: string, buffer: Buffer) => { buffer.writeUInt16LE(40, 0); buffer.writeUInt16LE(119, 2); return 0; });
  f.open.mockResolvedValue({ fd: 123, stat: f.stat, close: f.close }); f.stat.mockResolvedValue({ isCharacterDevice: () => true }); f.close.mockResolvedValue(undefined);
});
describe.skipIf(process.platform !== "darwin")("direct macOS input geometry", () => {
  it("reads the original process terminal and geometry without spawning commands", async () => {
    expect(await readMacProcessTty(456, signal())).toBe("/dev/ttys017");
    expect(await readMacTtySize("/dev/ttys017", signal())).toEqual({ width: 119, height: 40 });
    expect(f.pidInfo).toHaveBeenCalledWith(456, 3, 0, expect.any(Buffer), 136);
    expect(f.devname).toHaveBeenCalledWith(42, 0o020000, expect.any(Buffer), 128);
    expect(f.open).toHaveBeenCalledWith("/dev/ttys017", constants.O_RDONLY | constants.O_NOCTTY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    expect(f.ioctl).toHaveBeenCalledWith(123, 0x40087468, "void *", expect.any(Buffer));
    expect(f.close).toHaveBeenCalledOnce(); expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 2147483648])("rejects invalid PID %s before native calls", async pid => {
    await expect(readMacProcessTty(pid, signal())).rejects.toThrow(); expect(f.pidInfo).not.toHaveBeenCalled();
  });
  it.each([0, 100, 137])("rejects a partial process record of %s bytes", async length => {
    f.pidInfo.mockReturnValue(length); await expect(readMacProcessTty(456, signal())).rejects.toThrow(); expect(f.devname).not.toHaveBeenCalled();
  });
  it.each(["pid", "no-tty", "no-device"])("rejects %s process observations", async kind => {
    f.pidInfo.mockImplementation((_pid, _flavor, _arg, buffer: Buffer) => { buffer.writeUInt32LE(kind === "no-tty" ? 0 : 0x40); buffer.writeUInt32LE(kind === "pid" ? 789 : 456, 12); buffer.writeUInt32LE(kind === "no-device" ? 0xffffffff : 42, 108); return 136; });
    await expect(readMacProcessTty(456, signal())).rejects.toThrow(); expect(f.devname).not.toHaveBeenCalled();
  });
  it.each([null, "console", "ttys017/other", ""])("rejects unsupported terminal name %s", async name => {
    f.devname.mockImplementation((_dev, _mode, buffer: Buffer) => { if (name !== null) buffer.write(name + "\0"); return name === null ? null : 1; });
    await expect(readMacProcessTty(456, signal())).rejects.toThrow();
  });
  it("refuses unterminated device names", async () => {
    f.devname.mockImplementation((_dev, _mode, buffer: Buffer) => { buffer.fill(65); return 1; }); await expect(readMacProcessTty(456, signal())).rejects.toThrow();
  });
  it.each(["/dev/tty", "/dev/ttys017/../null", "/tmp/ttys017"])("rejects path %s before opening", async tty => {
    await expect(readMacTtySize(tty, signal())).rejects.toThrow(); expect(f.open).not.toHaveBeenCalled();
  });
  it("preserves open failure without attempting an ioctl", async () => {
    f.open.mockRejectedValue(new Error("open failed")); await expect(readMacTtySize("/dev/ttys017", signal())).rejects.toThrow("open failed"); expect(f.ioctl).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
  it("closes a descriptor that is not a character device", async () => {
    f.stat.mockResolvedValue({ isCharacterDevice: () => false }); await expect(readMacTtySize("/dev/ttys017", signal())).rejects.toThrow(); expect(f.ioctl).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  });
  it("closes after stat and ioctl failures", async () => {
    f.stat.mockRejectedValueOnce(new Error("stat failed")); await expect(readMacTtySize("/dev/ttys017", signal())).rejects.toThrow("stat failed");
    f.ioctl.mockReturnValue(-1); await expect(readMacTtySize("/dev/ttys017", signal())).rejects.toThrow(); expect(f.close).toHaveBeenCalledTimes(2);
  });
  it("does not manufacture dimensions for a zero-sized terminal", async () => {
    f.ioctl.mockReturnValue(0); expect(await readMacTtySize("/dev/ttys017", signal())).toEqual({ width: 0, height: 0 });
  });
  it("rejects cancellation before native work", async () => {
    const abort = new AbortController(); abort.abort(new Error("cancelled"));
    await expect(readMacProcessTty(456, abort.signal)).rejects.toThrow("cancelled"); await expect(readMacTtySize("/dev/ttys017", abort.signal)).rejects.toThrow("cancelled"); expect(f.pidInfo).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it.each(["open", "stat", "ioctl"])("closes the descriptor when cancelled during %s", async phase => {
    const abort = new AbortController();
    if (phase === "open") f.open.mockImplementation(async () => { abort.abort(new Error("cancelled")); return { fd: 123, stat: f.stat, close: f.close }; });
    if (phase === "stat") f.stat.mockImplementation(async () => { abort.abort(new Error("cancelled")); return { isCharacterDevice: () => true }; });
    if (phase === "ioctl") f.ioctl.mockImplementation(() => { abort.abort(new Error("cancelled")); return 0; });
    await expect(readMacTtySize("/dev/ttys017", abort.signal)).rejects.toThrow("cancelled"); expect(f.close).toHaveBeenCalledOnce();
  });
});
