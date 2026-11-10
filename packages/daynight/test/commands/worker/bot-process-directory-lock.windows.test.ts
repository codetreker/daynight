import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { startWindowsDirectoryHolder, startWindowsDirectoryTrace } from "./windows-directory-handles.fixtures.js";

test.skipIf(process.platform !== "win32")("identifies a real directory handle candidate while removal stays blocked until that handle is released", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-directory-lock");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")), target = path.join(home, "ordinary");
  await mkdir(target);
  let trace: Awaited<ReturnType<typeof startWindowsDirectoryTrace>> | undefined;
  let holder: Awaited<ReturnType<typeof startWindowsDirectoryHolder>> | undefined;
  const failures: unknown[] = [];
  try {
    trace = await startWindowsDirectoryTrace();
    holder = await startWindowsDirectoryHolder(target);
    await expect(rm(target, { recursive: true, force: true })).rejects.toMatchObject({ code: "EBUSY" });
    const evidence = await trace.trace(target, [holder.pid]);
    const holderPid = holder.pid;
    expect(evidence.matchingHandles).toContainEqual({ pid: holder.pid, handle: expect.stringMatching(/^0x[0-9a-f]+$/), path: expect.any(String) });
    expect(evidence.matchingHandles.filter(candidate => candidate.pid === holder!.pid).every(candidate => candidate.path === evidence.target)).toBe(true);
    // Matched handles are candidates; the controlled holder's delete-sharing
    // restriction is established by CreateFileW and this release transition.
    await expect(rm(target, { recursive: true, force: true })).rejects.toMatchObject({ code: "EBUSY" });
    await holder.release();
    holder = undefined;
    await expect(rm(target, { recursive: true, force: true })).resolves.toBeUndefined();
    console.log(JSON.stringify({ fixture: "windows-directory-lock", holderPid, blockedBeforeTrace: true, blockedAfterTrace: true, removedAfterRelease: true, evidence }));
  } catch (error) { failures.push(error); }
  finally {
    for (const cleanup of [async () => { if (holder !== undefined) await holder.stop(); }, async () => { if (trace !== undefined) await trace.close(); }, async () => { await rm(home, { recursive: true, force: true }); }]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length !== 0) throw new AggregateError(failures, "Directory lock verification and cleanup failed.", { cause: failures[0] });
}, 60_000);
