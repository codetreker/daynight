import path from "node:path";
import * as koffi from "koffi";

if (process.platform !== "win32") throw new Error("Directory-handle evidence requires Windows.");
const kernel = koffi.load("kernel32.dll"), nt = koffi.load("ntdll.dll");
const createFile = kernel.func("uintptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, uintptr_t template)");
const closeHandle = kernel.func("int __stdcall CloseHandle(uintptr_t handle)");
const getLastError = kernel.func("uint32_t __stdcall GetLastError()");
const openProcess = kernel.func("uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
const duplicateHandle = kernel.func("int __stdcall DuplicateHandle(uintptr_t sourceProcess, uintptr_t source, intptr_t targetProcess, void *target, uint32_t access, int inherit, uint32_t options)");
const getFileType = kernel.func("uint32_t __stdcall GetFileType(uintptr_t handle)");
const getName = kernel.func("uint32_t __stdcall GetFinalPathNameByHandleW(uintptr_t handle, void *name, uint32_t length, uint32_t flags)");
const queryHandles = nt.func("int32_t __stdcall NtQuerySystemInformation(uint32_t kind, void *data, uint32_t length, void *returned)");
const pointerSize = koffi.sizeof("uintptr_t");
if (pointerSize !== 4 && pointerSize !== 8) throw new Error("Unsupported Windows pointer size.");
const pointer = (data, offset) => pointerSize === 8 ? data.readBigUInt64LE(offset) : BigInt(data.readUInt32LE(offset));
const invalidHandle = (1n << BigInt(pointerSize * 8)) - 1n;
const failure = (stage, code = getLastError()) => Object.assign(new Error(`Windows directory evidence ${stage} failed (${code}).`), { stage, code });
const close = handle => { if (closeHandle(handle) === 0) throw failure("close-handle"); };
const use = (handle, action) => {
  let value, error;
  try { value = action(handle); } catch (caught) { error = caught; }
  try { close(handle); } catch (caught) { error = error === undefined ? caught : new AggregateError([error, caught], "Directory observation and handle release failed.", { cause: error }); }
  if (error !== undefined) throw error;
  return value;
};
const useAsync = async (handle, action) => {
  let value, error;
  try { value = await action(handle); } catch (caught) { error = caught; }
  try { close(handle); } catch (caught) { error = error === undefined ? caught : new AggregateError([error, caught], "Directory observation and handle release failed.", { cause: error }); }
  if (error !== undefined) throw error;
  return value;
};
const directory = (name, access, share) => {
  const handle = createFile(name, access, share, null, 3, 0x02000000, 0);
  if (BigInt(handle) === invalidHandle) throw failure("open-directory");
  return handle;
};
const nameBuffer = Buffer.alloc(65536);
const nameOf = handle => {
  const data = nameBuffer;
  const length = getName(handle, data, data.length / 2, 0);
  if (length === 0) throw failure("file-name");
  if (length >= data.length / 2) throw new Error("Directory observation name exceeded its buffer.");
  return data.subarray(0, length * 2).toString("utf16le");
};
const snapshot = () => {
  let size = 1024 * 1024;
  while (size <= 64 * 1024 * 1024) {
    const data = Buffer.alloc(size), returned = Buffer.alloc(4);
    const status = queryHandles(64, data, data.length, returned);
    if (status === -1073741820) { size = Math.max(size * 2, returned.readUInt32LE()); continue; }
    if (status < 0) throw failure("system-handles", status >>> 0);
    const count = pointer(data, 0), header = pointerSize * 2, stride = pointerSize === 8 ? 40 : 28;
    if (count > BigInt(Math.floor((data.length - header) / stride))) throw new Error("Invalid Windows handle snapshot length.");
    const result = [];
    for (let index = 0; index < Number(count); index++) {
      const offset = header + index * stride;
      result.push({ pid: pointer(data, offset + pointerSize), handle: pointer(data, offset + pointerSize * 2), type: data.readUInt16LE(offset + pointerSize * 3 + 6) });
    }
    return result;
  }
  throw new Error("Windows handle snapshot exceeded 64 MiB.");
};
const comparable = name => path.win32.normalize(name).replace(/\\+$/, "").toLowerCase();
const increment = (counts, code) => { counts[String(code)] = (counts[String(code)] ?? 0) + 1; };
const trace = async (target, preferredPids) => {
  const startedAt = new Date().toISOString();
  return await useAsync(directory(target, 0, 7), async targetHandle => {
    const targetName = nameOf(targetHandle), entries = snapshot();
    const own = entries.find(entry => entry.pid === BigInt(process.pid) && entry.handle === BigInt(targetHandle));
    if (own === undefined) throw new Error("The metadata handle is missing from the Windows handle snapshot.");
    const processes = new Map();
    for (const entry of entries) {
      if (entry.type !== own.type || entry.pid === 0n || entry.pid === BigInt(process.pid)) continue;
      if (entry.pid > 0xffffffffn) throw new Error("Invalid Windows snapshot process identity.");
      const pid = Number(entry.pid);
      if (!processes.has(pid)) processes.set(pid, []);
      processes.get(pid).push(entry.handle);
    }
    await send({ kind: "snapshot", startedAt, target: targetName, snapshotHandles: entries.length });
    const matchingHandles = [], processErrors = {}, duplicateErrors = {}, typeErrors = {}, nameErrors = {};
    let examined = 0;
    // This layout and duplicate/name observation follow Microsoft's File Locksmith.
    // https://github.com/microsoft/PowerToys/blob/ccd0473af8b8ab266c1b9861f928d4b85dffa291/src/modules/FileLocksmith/FileLocksmithLibInterop/NtdllExtensions.cpp#L351-L436
    const priority = new Map(preferredPids.map((pid, index) => [pid, index]));
    const ordered = [...processes].sort(([left], [right]) => (priority.get(left) ?? preferredPids.length) - (priority.get(right) ?? preferredPids.length));
    for (const [pid, handles] of ordered) {
      const processHandle = openProcess(0x40, 0, pid);
      if (BigInt(processHandle) === 0n) { increment(processErrors, getLastError()); continue; }
      await useAsync(processHandle, async source => {
        for (const handle of handles) {
          const duplicate = Buffer.alloc(pointerSize);
          if (duplicateHandle(source, handle, -1, duplicate, 0, 0, 2) === 0) { increment(duplicateErrors, getLastError()); continue; }
          let candidate;
          use(pointer(duplicate, 0), copied => {
            const type = getFileType(copied);
            if (type !== 1) { if (type === 0) increment(typeErrors, getLastError()); return; }
            examined++;
            let name;
            try { name = nameOf(copied); } catch (error) { increment(nameErrors, error.code ?? error.message); return; }
            if (comparable(name) === comparable(targetName)) candidate = { pid, handle: `0x${handle.toString(16)}`, path: name };
          });
          if (candidate !== undefined) { matchingHandles.push(candidate); await send({ kind: "candidate", value: candidate }); }
        }
      });
    }
    return { startedAt, finishedAt: new Date().toISOString(), target: targetName, matchingHandles, examined,
      snapshotHandles: entries.length, processErrors, duplicateErrors, typeErrors, nameErrors,
      scanComplete: Object.keys(processErrors).length + Object.keys(duplicateErrors).length + Object.keys(typeErrors).length + Object.keys(nameErrors).length === 0 };
  });
};
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const describe = (error, depth = 0) => ({ name: error.name, message: error.message, stage: error.stage, code: error.code,
  ...(depth < 4 && error.cause instanceof Error ? { cause: describe(error.cause, depth + 1) } : {}),
  ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.map(value => value instanceof Error ? describe(value, depth + 1) : String(value)) } : {}) });

if (process.argv[2] === "hold") {
  const target = process.argv[3];
  if (target === undefined) throw new Error("A controlled directory is required.");
  let handle = directory(target, 1, 3);
  const release = () => { if (handle !== null) { close(handle); handle = null; } };
  process.once("disconnect", release);
  process.once("message", async message => {
    if (message !== "release") throw new Error("Unexpected directory-holder message.");
    release();
    await send({ kind: "released" });
    process.disconnect();
  });
  await send({ kind: "ready", pid: process.pid });
} else if (process.argv[2] === "trace") {
  process.once("message", async message => {
    try {
      if (message?.kind === "trace" && typeof message.target === "string") await send({ kind: "result", value: await trace(message.target, message.preferredPids) });
      else if (message?.kind !== "close") throw new Error("Unexpected directory-trace message.");
    } catch (error) { await send({ kind: "failure", error: describe(error) }); }
    finally { process.disconnect(); }
  });
  await send({ kind: "ready", pid: process.pid });
} else throw new Error("Unknown Windows directory observation mode.");
