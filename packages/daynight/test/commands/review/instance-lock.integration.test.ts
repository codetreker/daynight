import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireInstanceLock } from "../../../src/commands/review/instance-lock.js";

let directory: string;
beforeAll(async () => {
  const temporary = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  directory = await mkdtemp(path.join(temporary, "instance-lock-"));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

const staleRecord = { owner: "previous-owner", pid: 2_147_483_647, startedAt: "2000-01-01T00:00:00.000Z" };
const absent = (): NodeJS.ErrnoException => Object.assign(new Error("Process does not exist"), { code: "ESRCH" });
const waitForMessage = (child: ChildProcess): Promise<unknown> => new Promise((resolve, reject) => {
  const cleanup = (): void => { clearTimeout(timeout); child.off("message", received); child.off("exit", exited); };
  const received = (message: unknown): void => { cleanup(); resolve(message); };
  const exited = (code: number | null): void => { cleanup(); reject(new Error(`Lock contender exited before reporting its result: ${code}`)); };
  const timeout = setTimeout(() => { cleanup(); reject(new Error("Lock contender did not report within ten seconds.")); }, 10_000);
  child.once("message", received); child.once("exit", exited);
});
const contender = (file: string) => {
  const executable = new URL("../../../dist/commands/review/instance-lock.js", import.meta.url).href;
  const source = `import { acquireInstanceLock } from ${JSON.stringify(executable)};
process.on('message', async (message) => {
  if (message !== 'acquire') return;
  try {
    const lock = await acquireInstanceLock(process.argv[1]);
    process.on('message', async (command) => {
      if (command !== 'release') return;
      await lock.release();
      process.send({ status: 'released' }, () => process.exit(0));
    });
    process.send({ status: 'acquired', pid: process.pid, previousProcessesExcluded: lock.previousProcessesExcluded });
  } catch (error) { process.send({ status: 'refused', message: String(error) }, () => process.exit(0)); }
});
process.send({ status: 'ready' });`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, file], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = "";
  child.stderr!.on("data", (data: Buffer) => { errors += data.toString(); });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { if (code === 0 || signal !== null) resolve(); else reject(new Error(errors)); });
  });
  return {
    child,
    exited,
    stop: async (): Promise<void> => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; },
  };
};

describe("instance-lock ownership", () => {
  it("refuses a live CLI and releases its own lock idempotently", async () => {
    const file = path.join(directory, "live.lock");
    const lock = await acquireInstanceLock(file, "first");
    expect(lock.previousProcessesExcluded).toBe(true);
    const content = await readFile(file, "utf8");
    await expect(acquireInstanceLock(file)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("still running") }) });
    expect(await readFile(file, "utf8")).toBe(content);
    await lock.release();
    await lock.release();
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims only an ESRCH owner without claiming that its agents stopped", async () => {
    const file = path.join(directory, "dead.lock");
    await writeFile(file, JSON.stringify(staleRecord));
    const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw absent(); });
    const lock = await acquireInstanceLock(file, "replacement");
    expect(probe).toHaveBeenCalledExactlyOnceWith(staleRecord.pid, 0);
    expect(lock.previousProcessesExcluded).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ owner: "replacement", pid: process.pid });
    await lock.release();
  });

  it.each(["EPERM", "EINVAL"])("retains a lock when process inspection fails with %s and preserves the error", async (code) => {
    const file = path.join(directory, `${code}.lock`);
    const content = JSON.stringify(staleRecord);
    await writeFile(file, content);
    const cause = Object.assign(new Error("Inspection failed"), { code });
    vi.spyOn(process, "kill").mockImplementation(() => { throw cause; });
    await expect(acquireInstanceLock(file)).rejects.toMatchObject({ cause: expect.objectContaining({ cause }) });
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it.each(["", "not-json", "null", "[]", JSON.stringify({ ...staleRecord, owner: "" }), JSON.stringify({ ...staleRecord, startedAt: "invalid" }),
    ...[0, -1, 1.5, 2_147_483_648, "123", null].map((pid) => JSON.stringify({ ...staleRecord, pid }))])("retains invalid owner data %j without probing a process", async (content) => {
    const file = path.join(directory, `invalid-${crypto.randomUUID()}.lock`);
    await writeFile(file, content);
    const probe = vi.spyOn(process, "kill");
    await expect(acquireInstanceLock(file)).rejects.toThrow("Cannot acquire instance lock");
    expect(probe).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it("exposes an unreadable owner record and retains it", async () => {
    const file = path.join(directory, "directory.lock");
    await mkdir(file);
    await expect(acquireInstanceLock(file)).rejects.toMatchObject({ cause: expect.objectContaining({ code: "EISDIR" }) });
  });

  it("refuses to unlink an instance lock whose ownership changed", async () => {
    const file = path.join(directory, "changed.lock");
    const lock = await acquireInstanceLock(file, "owner");
    await writeFile(file, "other-owner");
    await expect(lock.release()).rejects.toThrow("no longer belongs");
    expect(await readFile(file, "utf8")).toBe("other-owner");
  });

  it("allows exactly one concurrent child to reclaim a dead owner's lock", async () => {
    const file = path.join(directory, "contended.lock");
    const previous = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 10_000 });
    expect(previous.status).toBe(0);
    await writeFile(file, JSON.stringify({ ...staleRecord, pid: Number(previous.stdout) }));
    const first = contender(file);
    const second = contender(file);
    try {
      expect(await Promise.all([waitForMessage(first.child), waitForMessage(second.child)])).toEqual([{ status: "ready" }, { status: "ready" }]);
      const results = [waitForMessage(first.child), waitForMessage(second.child)];
      first.child.send("acquire"); second.child.send("acquire");
      const outcomes = await Promise.all(results) as { status: string; pid?: number; previousProcessesExcluded?: boolean }[];
      expect(outcomes.filter((result) => result.status === "acquired")).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === "refused")).toHaveLength(1);
      const winningIndex = outcomes.findIndex((result) => result.status === "acquired");
      expect(outcomes[winningIndex]!.previousProcessesExcluded).toBe(false);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pid: outcomes[winningIndex]!.pid });
      const winner = [first, second][winningIndex]!;
      const released = waitForMessage(winner.child);
      winner.child.send("release");
      expect(await released).toEqual({ status: "released" });
      await Promise.all([first.exited, second.exited]);
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await Promise.all([first.stop(), second.stop()]); }
  }, 20_000);
});
