import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfiguration } from "../../../src/commands/review/config.js";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";
import {
  createApfsFinalizer, executeApfsCommand, realApfsCleanupDependencies, verifyApfsImageOwnership,
  type CleanupRecord, type VerifiedApfsImage,
} from "../../fixtures/apfs-cleanup.js";

const execute = promisify(execFile);
const bounded = async <T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`${label} timed out`)); }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
};

const startFileHolder = (file: string, cwd: string) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { openSync, closeSync } from "node:fs";
    const descriptor = openSync(process.argv[1], "r");
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
      process.stdout.write(JSON.stringify({ released: process.pid }) + "\\n");
      process.stdin.destroy();
    };
    process.stdin.on("data", release);
    process.stdin.on("end", release);
    process.stdout.write(JSON.stringify({ ready: process.pid }) + "\\n");
  `, file], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const events = new EventEmitter();
  let stderr = "";
  let stdout = "";
  let readyPid: number | undefined;
  let releasedAt: number | undefined;
  let processFailure: Error | undefined;
  let exited = false;
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    let newline: number;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try {
        const message = JSON.parse(line) as { ready?: number; released?: number };
        if (message.ready !== undefined) readyPid = message.ready;
        if (message.released !== undefined) {
          if (message.released !== child.pid) throw new Error("Unexpected holder release PID");
          releasedAt = performance.now();
        }
      } catch (error) { processFailure = error instanceof Error ? error : new Error(String(error)); }
      events.emit("change");
    }
  });
  child.on("error", (error) => { processFailure = error; events.emit("change"); });
  child.stdin.on("error", (error) => { processFailure = error; events.emit("change"); });
  const exit = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      if (code !== 0 || signal !== null) processFailure = new Error(`File holder exited with ${code}/${signal}: ${stderr}`);
      events.emit("change");
      resolve();
    });
  });
  const waitReady = new Promise<void>((resolve, reject) => {
    const check = () => {
      if (processFailure !== undefined || exited) { events.off("change", check); reject(processFailure ?? new Error(`File holder exited before readiness: ${stderr}`)); }
      else if (readyPid !== undefined) { events.off("change", check); resolve(); }
    };
    events.on("change", check);
    check();
  });
  let releaseRequested = false;
  const release = (): void => {
    if (releaseRequested || exited) return;
    releaseRequested = true;
    child.stdin.end("release\n");
  };
  return {
    child, ready: bounded(waitReady, 3_000, "File holder readiness"), release,
    readyPid: () => readyPid, releasedAt: () => releasedAt,
    finish: async () => {
      release();
      try { await bounded(exit, 3_000, "File holder exit"); }
      catch (error) {
        child.kill("SIGTERM");
        try { await bounded(exit, 2_000, "Terminated file holder exit"); }
        catch (terminationError) { throw new AggregateError([error, terminationError], "Owned file holder did not exit", { cause: error }); }
        throw error;
      }
      if (processFailure !== undefined) throw processFailure;
      if (releasedAt === undefined) throw new Error(`File holder did not acknowledge descriptor release: ${stderr}`);
    },
  };
};

const modes = [
  { format: "APFS", caseSensitive: false },
  { format: "Case-sensitive APFS", caseSensitive: true },
] as const;

describe.skipIf(process.platform !== "darwin" || process.env.DAYNIGHT_TEST_APFS !== "1").each(modes)(
  "$format configuration paths",
  ({ format, caseSensitive }) => {
    let directory: string | undefined;
    let mountDirectory: string;
    let homeDirectory: string;
    let imageFile: string;
    let attachmentAttempted = false;
    let attachmentPlist: string | undefined;
    let ownership: VerifiedApfsImage | undefined;
    let volumeHolderPid: number | undefined;
    const finalizeOnce = createApfsFinalizer(() => ({
      directory, mountDirectory, imageFile, attachmentAttempted, attachmentPlist,
      ...(ownership === undefined ? {} : { ownership }),
      ...(volumeHolderPid === undefined ? {} : { volumeHolderPid }),
    }));

    beforeAll(async () => {
      const temporaryDirectory = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
      await mkdir(temporaryDirectory, { recursive: true });
      directory = await mkdtemp(path.join(temporaryDirectory, "apfs-config-"));
      mountDirectory = path.join(directory, "mounted volume");
      await mkdir(mountDirectory);
      imageFile = path.join(directory, "filesystem.sparseimage");
      await execute("/usr/bin/hdiutil", [
        "create", "-size", "256m", "-type", "SPARSE", "-layout", "GPTSPUD", "-fs", format,
        "-volname", caseSensitive ? "DaynightSensitive" : "DaynightInsensitive", "-quiet", imageFile,
      ], { timeout: 60_000 });
      imageFile = await realpath(imageFile);
      attachmentAttempted = true;
      attachmentPlist = (await execute("/usr/bin/hdiutil", [
        "attach", "-plist", "-nobrowse", "-noautoopen", "-mountpoint", mountDirectory, imageFile,
      ], { timeout: 30_000 })).stdout;
      ownership = await verifyApfsImageOwnership(imageFile, attachmentPlist);
      homeDirectory = path.join(mountDirectory, "Review Home 用户");
      await mkdir(resolveReviewPaths(homeDirectory).stateDirectory, { recursive: true });
      const probe = path.join(homeDirectory, "CaseProbe");
      await mkdir(probe);
      if (caseSensitive) {
        await expect(stat(path.join(homeDirectory, "caseprobe"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect((await stat(path.join(homeDirectory, "caseprobe"))).ino).toBe((await stat(probe)).ino);
      }
    }, 120_000);

    afterAll(async () => {
      await finalizeOnce();
    }, 40_000);

    it.each([
      ["../Repo", "../repo"],
      ["../New/Repo", "../new/repo"],
    ])("uses volume lookup rules for missing destinations %s and %s", async (first, second) => {
      const paths = resolveReviewPaths(homeDirectory);
      await writeFile(paths.configFile, JSON.stringify({
        review: { repositories: [
          { remote: "https://github.com/owner/first", path: first },
          { remote: "https://github.com/owner/second", path: second },
        ] },
      }));
      const originalEntries = await readdir(homeDirectory);
      if (caseSensitive) {
        expect((await loadConfiguration(paths)).repositories).toHaveLength(2);
      } else {
        await expect(loadConfiguration(paths)).rejects.toThrow("same location");
      }
      expect(await readdir(homeDirectory)).toEqual(originalEntries);
    });

    it("uses volume lookup rules for state-directory aliases", async () => {
      const paths = resolveReviewPaths(homeDirectory);
      await writeFile(paths.configFile, JSON.stringify({
        review: { repositories: [{ remote: "https://github.com/owner/repo", path: "../.DAYNIGHT/repo" }] },
      }));
      if (caseSensitive) {
        expect((await loadConfiguration(paths)).repositories).toHaveLength(1);
      } else {
        await expect(loadConfiguration(paths)).rejects.toThrow("must not overlap");
      }
    });

    it("rejects missing Unicode spelling aliases using actual APFS lookup", async () => {
      const paths = resolveReviewPaths(homeDirectory);
      const reference = path.join(homeDirectory, "caf\u00e9-reference");
      await mkdir(reference);
      expect((await stat(path.join(homeDirectory, "cafe\u0301-reference"))).ino).toBe((await stat(reference)).ino);
      await writeFile(paths.configFile, JSON.stringify({
        review: { repositories: [
          { remote: "https://github.com/owner/first", path: "../New/caf\u00e9" },
          { remote: "https://github.com/owner/second", path: "../New/cafe\u0301" },
        ] },
      }));
      const originalEntries = await readdir(homeDirectory);
      await expect(loadConfiguration(paths)).rejects.toThrow("same location");
      expect(await readdir(homeDirectory)).toEqual(originalEntries);
    });
    if (caseSensitive) {
      it("recovers ordinary detach after an observed same-user file holder releases", async () => {
        const heldFile = path.join(mountDirectory, "held-file.txt");
        await writeFile(heldFile, "An owned read-only descriptor keeps this volume busy.\n");
        const holder = startFileHolder(heldFile, fileURLToPath(new URL("../../../../../", import.meta.url)));
        const records: CleanupRecord[] = [];
        let firstBusyAt: number | undefined;
        let releaseTimer: NodeJS.Timeout | undefined;
        let detachCalls = 0;
        let originalError: unknown;
        let startedAt: number | undefined;
        let finishedAt: number | undefined;
        const detachEvents: { startedAt: number; finishedAt: number; result: "busy" | "success" | "failure" }[] = [];
        try {
          await holder.ready;
          expect(holder.readyPid()).toBe(holder.child.pid);
          expect(holder.readyPid()).toBeTypeOf("number");
          volumeHolderPid = holder.readyPid();
          startedAt = performance.now();
          await finalizeOnce({
            ...realApfsCleanupDependencies,
            execute: async (command, args, options) => {
              const isDetach = command === "/usr/bin/hdiutil" && args[0] === "detach";
              const detachStartedAt = isDetach ? performance.now() : undefined;
              if (isDetach) detachCalls += 1;
              try {
                const result = await executeApfsCommand(command, args, options);
                if (detachStartedAt !== undefined) detachEvents.push({ startedAt: detachStartedAt, finishedAt: performance.now(), result: "success" });
                return result;
              } catch (error) {
                if (detachStartedAt !== undefined) {
                  const detachFinishedAt = performance.now();
                  const isBusy = typeof (error as { stderr?: unknown }).stderr === "string"
                    && ((error as { stderr: string }).stderr).includes("Resource busy");
                  detachEvents.push({ startedAt: detachStartedAt, finishedAt: detachFinishedAt, result: isBusy ? "busy" : "failure" });
                  if (isBusy && firstBusyAt === undefined) {
                    firstBusyAt = detachFinishedAt;
                    releaseTimer = setTimeout(holder.release, 6_001);
                  }
                }
                throw error;
              }
            },
            report: (record) => { records.push(record); realApfsCleanupDependencies.report(record); },
          }).finally(() => { finishedAt = performance.now(); });
          expect(firstBusyAt).toBeDefined();
          const volumeHolders = records.filter((record) => record.kind === "diagnostic" && record.command === "/usr/sbin/lsof" && record.args.includes(mountDirectory));
          expect(volumeHolders).toHaveLength(1);
          expect(volumeHolders[0]).toMatchObject({ args: ["-nP", "-Fpcfnt", "-a", "-p", String(holder.child.pid), "+f", "--", mountDirectory] });
          expect(volumeHolders.some((record) => record.kind === "diagnostic" && record.result?.stdout.split("\n").includes(`p${holder.child.pid}`))).toBe(true);
          expect(holder.releasedAt()).toBeGreaterThanOrEqual(firstBusyAt! + 6_000);
          expect(detachCalls).toBeGreaterThan(0);
          expect(detachCalls).toBeLessThanOrEqual(3);
          expect(performance.now() - startedAt!).toBeLessThan(30_000);
          expect(records.at(-1)).toMatchObject({ kind: "image", imageFile, state: "absent" });
          await expect(stat(directory!)).rejects.toMatchObject({ code: "ENOENT" });
        } catch (error) { originalError = error; }
        finally {
          clearTimeout(releaseTimer);
          try { await holder.finish(); }
          catch (cleanupError) {
            if (originalError !== undefined) throw new AggregateError([originalError, cleanupError], "APFS holder regression and owned child cleanup failed", { cause: originalError });
            throw cleanupError;
          } finally {
            process.stderr.write(`APFS holder recovery: ${JSON.stringify({
              holderPid: holder.child.pid, readyPid: holder.readyPid(), volumeHolderPid, firstBusyAt, releasedAt: holder.releasedAt(), detachCalls, detachEvents,
              finalizationStartedAt: startedAt, finalizationFinishedAt: finishedAt,
              elapsedMs: startedAt === undefined || finishedAt === undefined ? undefined : finishedAt - startedAt,
              finalState: records.filter((record) => record.kind === "image").at(-1),
              holderExited: holder.child.exitCode === 0,
            })}\n`);
          }
        }
        if (originalError !== undefined) throw originalError;
      }, 40_000);
    }
  },
);
