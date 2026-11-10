import * as koffi from "koffi";
import type { LocalImageRootIdentity } from "./local-source.js";

const refuse = (code = "source_forbidden"): never => { throw Object.assign(new Error("Local image source is unavailable."), { code }); };
const components = (value: string): string[] => {
  if (!value || !value.isWellFormed() || /[\p{Cc}<>"|?*]/u.test(value)) refuse();
  const result = value.replaceAll("/", "\\").split("\\").filter(Boolean);
  for (const part of result) {
    if (part === "." || part === "..") continue;
    const device = part.split(".", 1)[0]!.replace(/[ .]+$/u, "");
    if (part.includes(":") || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(device)) refuse();
  }
  return result;
};
const diskPath = (value: string): { drive: string; parts: string[] } => {
  if (!/^[A-Za-z]:[\\/]/u.test(value)) return refuse();
  return { drive: `${value[0]!.toUpperCase()}:\\`, parts: value.length === 3 ? [] : components(value.slice(3)) };
};

/** Decode only the documented symlink/junction layouts, never a filter's opaque tag. */
export function decodeWindowsReparsePoint(bytes: Buffer): { target: string; relative: boolean } {
  if (bytes.length < 16 || bytes.length > 16384 || bytes.readUInt16LE(4) + 8 !== bytes.length || bytes.readUInt16LE(6) !== 0) return refuse();
  const tag = bytes.readUInt32LE(0), symbolic = tag === 0xa000000c, junction = tag === 0xa0000003;
  if (!symbolic && !junction || symbolic && bytes.length < 20) return refuse();
  const base = symbolic ? 20 : 16, flags = symbolic ? bytes.readUInt32LE(16) : 0;
  if (flags !== 0 && flags !== 1) return refuse();
  const name = (offset: number, length: number): string => {
    if (offset % 2 || length % 2 || base + offset + length > bytes.length) return refuse();
    const text = bytes.subarray(base + offset, base + offset + length).toString("utf16le");
    if (!text.isWellFormed() || /\p{Cc}/u.test(text)) return refuse();
    return text;
  };
  let target = name(bytes.readUInt16LE(8), bytes.readUInt16LE(10));
  name(bytes.readUInt16LE(12), bytes.readUInt16LE(14));
  const relative = flags === 1;
  if (relative) { if (/^[\\/]|^[A-Za-z]:/u.test(target)) return refuse(); components(target); }
  else {
    // The kernel's substitute name is trusted only after decoding the known tag;
    // source locators can never supply an NT or extended namespace themselves.
    if (target.startsWith("\\??\\")) target = target.slice(4);
    diskPath(target);
  }
  return { target, relative };
}

type Handle = number | bigint;
export type WindowsFile = { handle: Handle; path: string; id: string; size: bigint; directory: boolean; reparse: boolean; links: number; legacy: LocalImageRootIdentity; snapshot: string };

/** Resolve one name relative to its held parent; pathname ancestors are never reparsed. */
export function openWindowsImageRoot(cwd: string, expectedRoot?: LocalImageRootIdentity) {
  if (process.platform !== "win32") return refuse("policy_restricted");
  const kernel = koffi.load("kernel32.dll");
  const api = (name: string, result: string, args: string[]) => kernel.func("__stdcall", name, result, args);
  const createFile = api("CreateFileW", "intptr_t", ["str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "intptr_t"]);
  const nt = koffi.load("ntdll.dll");
  const unicodeString = koffi.struct({ Length: "uint16_t", MaximumLength: "uint16_t", Buffer: "void *" });
  const objectAttributes = koffi.struct({ Length: "uint32_t", RootDirectory: "intptr_t", ObjectName: koffi.pointer(unicodeString), Attributes: "uint32_t", SecurityDescriptor: "void *", SecurityQualityOfService: "void *" });
  const ntCreateFile = nt.func("__stdcall", "NtCreateFile", "int32_t", [koffi.out(koffi.pointer("intptr_t")), "uint32_t", koffi.pointer(objectAttributes), "void *", "void *", "uint32_t", "uint32_t", "uint32_t", "uint32_t", "void *", "uint32_t"]);
  const statusToError = nt.func("__stdcall", "RtlNtStatusToDosError", "uint32_t", ["int32_t"]);
  const closeHandle = api("CloseHandle", "int", ["intptr_t"]), lastError = api("GetLastError", "uint32_t", []);
  const fileInfo = api("GetFileInformationByHandle", "int", ["intptr_t", "void *"]);
  const fileInfoEx = api("GetFileInformationByHandleEx", "int", ["intptr_t", "int", "void *", "uint32_t"]);
  const fileType = api("GetFileType", "uint32_t", ["intptr_t"]);
  const driveType = api("GetDriveTypeW", "uint32_t", ["str16"]);
  const volumeInfo = api("GetVolumeInformationByHandleW", "int", ["intptr_t", "void *", "uint32_t", "void *", "void *", "void *", "void *", "uint32_t"]);
  const finalPath = api("GetFinalPathNameByHandleW", "uint32_t", ["intptr_t", "void *", "uint32_t", "uint32_t"]);
  const ioctl = api("DeviceIoControl", "int", ["intptr_t", "uint32_t", "void *", "uint32_t", "void *", "uint32_t", "void *", "void *"]);
  const readFile = api("ReadFile", "int", ["intptr_t", "void *", "uint32_t", "void *", "void *"]);
  const writeFile = api("WriteFile", "int", ["intptr_t", "void *", "uint32_t", "void *", "void *"]);
  const flush = api("FlushFileBuffers", "int", ["intptr_t"]);
  const nativeError = (code = Number(lastError())): never => {
    return refuse([2, 3].includes(code) ? "source_not_found" : code === 5 ? "permission_denied" : [32, 33].includes(code) ? "source_busy" : [112, 39].includes(code) ? "source_capacity" : "source_unavailable");
  };
  const close = (files: WindowsFile[]): void => { for (const file of files.toReversed()) closeHandle(file.handle); files.length = 0; };
  const inspect = (handle: Handle, path: string): WindowsFile => {
    const legacy = Buffer.alloc(52), basic = Buffer.alloc(40), standard = Buffer.alloc(24), id = Buffer.alloc(24);
    if (!fileInfo(handle, legacy) || !fileInfoEx(handle, 0, basic, basic.length) || !fileInfoEx(handle, 1, standard, standard.length) || !fileInfoEx(handle, 18, id, id.length)) nativeError();
    if (fileType(handle) !== 1 || standard[20] !== 0) refuse();
    const identity = id.toString("hex"), size = standard.readBigInt64LE(8), directory = standard[21] === 1;
    if (size < 0n) refuse();
    return { handle, path, id: identity, size, directory, reparse: (legacy.readUInt32LE(0) & 0x400) !== 0, links: standard.readUInt32LE(16),
      legacy: { dev: String(legacy.readUInt32LE(28)), ino: String(BigInt(legacy.readUInt32LE(44)) << 32n | BigInt(legacy.readUInt32LE(48))) },
      // AccessTime changes on reads and does not describe source modification.
      snapshot: `${identity}:${size}:${basic.subarray(16, 36).toString("hex")}:${standard.readUInt32LE(16)}` };
  };
  const safeVolume = (handle: Handle): void => {
    const name = Buffer.alloc(64);
    if (!volumeInfo(handle, null, 0, null, null, null, name, 32)) nativeError();
    // expectedRoot comes from Node's 64-bit stat identity. ReFS requires a
    // different persisted 128-bit identity before it can share this contract.
    if (name.toString("utf16le").split("\0", 1)[0] !== "NTFS") refuse("policy_restricted");
  };
  const opened = (handle: Handle, path: string): WindowsFile => {
    try { safeVolume(handle); return inspect(handle, path); } catch (error) { closeHandle(handle); throw error; }
  };
  const append = (parent: WindowsFile, part: string) => parent.path.replace(/\\$/u, "") + "\\" + part;
  const openChild = (parent: WindowsFile, part: string, writing = false): WindowsFile => {
    if (part === "." || part === ".." || components(part).length !== 1 || /[\\/]/u.test(part)) return refuse();
    const name = Buffer.from(part, "utf16le"), handles: Handle[] = [0];
    if (name.length > 65534) return refuse();
    // Share restrictions protect file contents and renames, but do not prevent
    // FILE_WRITE_ATTRIBUTES from changing a directory's reparse data. A single
    // relative component is therefore essential, even while all parents are held.
    const status = Number(ntCreateFile(handles, writing ? 0x00120196 : 0x00120089,
      { Length: koffi.sizeof(objectAttributes), RootDirectory: parent.handle, ObjectName: { Length: name.length, MaximumLength: name.length, Buffer: name }, Attributes: 0x40, SecurityDescriptor: null, SecurityQualityOfService: null },
      Buffer.alloc(16), null, 0, writing ? 0 : 1, 1, 0x00200020, null, 0));
    if (status < 0) return nativeError(Number(statusToError(status)));
    if (!handles[0]) return refuse("source_unavailable");
    return opened(handles[0], append(parent, part));
  };
  const pinDrive = (drive: string, held: WindowsFile[]): WindowsFile => {
    if (driveType(drive) !== 3) return refuse("policy_restricted");
    const handle = createFile(drive, 0x80000000, 1, null, 3, 0x02200000, 0) as Handle;
    if (handle === -1 || handle === -1n) return nativeError();
    const file = opened(handle, drive); held.push(file);
    if (!file.directory || file.reparse) return refuse();
    const bytes = Buffer.alloc(65536), count = Number(finalPath(file.handle, bytes, 32768, 1));
    if (!count || count >= 32768) return nativeError();
    const pinned = bytes.subarray(0, count * 2).toString("utf16le");
    if (!/^\\\\\?\\Volume\{[a-fA-F0-9-]+\}\\/u.test(pinned)) return refuse("policy_restricted");
    // This path is diagnostic only; child opens use this directory's handle.
    file.path = pinned; return file;
  };
  const substitution = (file: WindowsFile) => {
    const bytes = Buffer.alloc(16384), count = Buffer.alloc(4);
    if (!ioctl(file.handle, 0x900a8, null, 0, bytes, bytes.length, count, null)) nativeError();
    const decoded = decodeWindowsReparsePoint(bytes.subarray(0, count.readUInt32LE(0)));
    if (inspect(file.handle, file.path).snapshot !== file.snapshot) refuse("source_changed");
    return decoded;
  };
  // Used only to identify the original cwd or an absolute locator's root
  // prefix. No file data is read before the pinned root has been reached.
  const directoryPrefix = (value: string, held: WindowsFile[], expand: () => void, stop?: string): { file: WindowsFile; rest: string[] } => {
    const candidate = diskPath(value), stack = [pinDrive(candidate.drive, held)];
    let parts = candidate.parts, steps = 0;
    for (;;) {
      const parent = stack.at(-1)!;
      if (parent.id === stop) return { file: parent, rest: parts };
      if (!parts.length) { if (stop) return refuse(); return { file: parent, rest: [] }; }
      if (++steps > 8192 || held.length > 4096) return refuse();
      const part = parts.shift()!;
      if (part === ".") continue;
      if (part === "..") { if (stack.length === 1) return refuse(); stack.pop(); continue; }
      const file = openChild(parent, part); held.push(file);
      if (file.reparse) {
        expand(); const decoded = substitution(file);
        if (decoded.relative) parts = [...components(decoded.target), ...parts];
        else {
          const target = diskPath(decoded.target); stack.splice(0, stack.length, pinDrive(target.drive, held));
          parts = [...target.parts, ...parts];
        }
      } else { if (!file.directory) return refuse(); stack.push(file); }
    }
  };
  const rootHandles: WindowsFile[] = [];
  let root: WindowsFile;
  try {
    let links = 0;
    root = directoryPrefix(cwd, rootHandles, () => { if (++links > 40) refuse(); }).file;
    if (expectedRoot && (root.legacy.dev !== expectedRoot.dev || root.legacy.ino !== expectedRoot.ino)) refuse();
  } catch (error) { close(rootHandles); throw error; }
  let closed = false;
  const verifyRoot = () => { if (closed || inspect(root.handle, root.path).id !== root.id) refuse("context_unavailable"); };
  const absoluteParts = (value: string, held: WindowsFile[], expand: () => void): string[] => directoryPrefix(value, held, expand, root.id).rest;
  return { close() { if (closed) return; closed = true; close(rootHandles); }, verifyRoot,
    inspect: (file: WindowsFile) => inspect(file.handle, file.path), closeFiles: close,
    source(value: string): { file: WindowsFile; held: WindowsFile[] } {
      verifyRoot(); const held: WindowsFile[] = [], stack = [root]; let links = 0, steps = 0;
      try {
        const expand = () => { if (++links > 40) refuse(); };
        let parts = /^[A-Za-z]:[\\/]/u.test(value) ? absoluteParts(value, held, expand) : components(value);
        while (parts.length) {
          if (++steps > 8192 || held.length > 4096) refuse();
          const part = parts.shift()!;
          if (part === ".") continue;
          if (part === "..") { if (stack.length === 1) refuse(); stack.pop(); continue; }
          const file = openChild(stack.at(-1)!, part); held.push(file);
          if (file.reparse) {
            expand(); const decoded = substitution(file);
            if (decoded.relative) parts = [...components(decoded.target), ...parts];
            else { stack.length = 1; parts = [...absoluteParts(decoded.target, held, expand), ...parts]; }
            continue;
          }
          if (parts.some(value => value !== ".")) { if (!file.directory) refuse(); stack.push(file); }
          else { if (file.directory) refuse(); return { file, held }; }
        }
        return refuse();
      } catch (error) { close(held); throw error; }
    },
    output(value: string): { file: WindowsFile; held: WindowsFile[] } {
      const candidate = diskPath(value), held: WindowsFile[] = [];
      try {
        let parent = pinDrive(candidate.drive, held);
        for (const part of candidate.parts.slice(0, -1)) {
          if (part === "." || part === "..") refuse();
          const next = openChild(parent, part); held.push(next);
          if (!next.directory || next.reparse) refuse(); parent = next;
        }
        const part = candidate.parts.at(-1); if (!part || part === "." || part === "..") return refuse();
        const file = openChild(parent, part, true); held.push(file);
        if (file.directory || file.reparse || file.size !== 0n || file.links !== 1) refuse();
        return { file, held };
      } catch (error) { close(held); throw error; }
    },
    read(file: WindowsFile, bytes: Buffer, limit: number): number {
      const count = Buffer.alloc(4); if (!readFile(file.handle, bytes, limit, count, null)) nativeError(); return count.readUInt32LE(0);
    },
    write(file: WindowsFile, bytes: Buffer): void {
      for (let offset = 0; offset < bytes.length;) { const count = Buffer.alloc(4); if (!writeFile(file.handle, bytes.subarray(offset), bytes.length - offset, count, null)) nativeError(); const size = count.readUInt32LE(0); if (!size) refuse("source_unavailable"); offset += size; }
    },
    flush(file: WindowsFile): void { if (!flush(file.handle)) nativeError(); },
  };
}
