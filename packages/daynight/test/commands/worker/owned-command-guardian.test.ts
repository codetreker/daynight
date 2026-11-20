import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { captureProcessProof, inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import { reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries, runLifecycleOwnedCommand, withOwnedCommandLifecycle, type OwnedCommandLifecycleEvent } from "../../../src/commands/worker/owned-command-lifecycle.js";
import { startOwnedRepositoryGit } from "../../../src/repository/git-owned.js";

const roots: string[] = [];
const root = async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/owned-guardian");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "command-"));
  roots.push(directory);
  return directory;
};
const waitFile = async (file: string) => {
  let value = "";
  await vi.waitFor(async () => { value = await readFile(file, "utf8"); expect(value).not.toBe(""); }, { timeout: 10_000, interval: 20 });
  return value;
};
const killOriginal = async (proof: ProcessProof | undefined) => {
  if (proof !== undefined && await inspectProcessProof(proof) === "running") process.kill(proof.pid, "SIGKILL");
};
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe.skipIf(process.platform === "win32")("POSIX owned command guardian", () => {
  it.each([
    { git: false, exitMain: false }, { git: false, exitMain: true },
    { git: true, exitMain: false }, { git: true, exitMain: true },
  ])("closes resistant descendants with git=$git and mainAlreadyExited=$exitMain", async ({ git, exitMain }) => {
    const directory = await root(), ready = path.join(directory, "leaf"), mainReady = path.join(directory, "main"), release = path.join(directory, "release");
    const leaf = `import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
    const source = `import {spawn} from 'node:child_process';import {existsSync,writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(mainReady)},String(process.pid));const child=spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(leaf)}],{stdio:'ignore'});child.unref();setInterval(()=>{if(existsSync(${JSON.stringify(release)}))process.exit(0);},10);`;
    const script = path.join(directory, "resistant.mjs");
    await writeFile(script, source);
    const cancellation = new AbortController(), events: OwnedCommandLifecycleEvent[] = [];
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 30_000, requestMs: 30_000 } });
    const save = async (event: OwnedCommandLifecycleEvent) => { events.push(event); };
    // Git really owns the shell/Node child. The leaf closes every inherited
    // stdio descriptor, so the root's close event cannot stand in for its exit.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const handle = git ? withOwnedCommandLifecycle(save, () => startOwnedRepositoryGit(directory,
      ["-c", `alias.resistant=!${quote(process.execPath)} ${quote(script)}`, "resistant"], operation)) : undefined;
    const pending = handle === undefined
      ? runLifecycleOwnedCommand({ file: process.execPath, args: [script], environment: process.env }, operation, save).then(value => ({ kind: "success", value }), error => ({ kind: "failure", error }))
      : handle.outcome;
    let leafProof: ProcessProof | undefined, mainProof: ProcessProof | undefined;
    try {
      mainProof = await captureProcessProof(Number(await waitFile(mainReady)));
      leafProof = await captureProcessProof(Number(await waitFile(ready)));
      expect(leafProof.processGroupId).toBe(events.find(event => event.stage === "bound")?.proof?.pid);
      if (exitMain) await writeFile(release, "exit");
      else if (handle !== undefined) handle.requestStop();
      else cancellation.abort(new Error("stop resistant command"));
      const outcome = await pending;
      expect(outcome.kind).toBe(exitMain ? "success" : "failure");
      if (handle !== undefined) await expect(handle.joined).resolves.toEqual({ kind: "local-closed", cleanupErrors: [] });
      expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped"]);
      await vi.waitFor(async () => {
        expect(await inspectProcessProof(leafProof!)).toBe("stopped");
        expect(await inspectProcessProof(mainProof!)).toBe("stopped");
        expect(await inspectProcessProof(events[1]!.proof!)).toBe("stopped");
      }, { timeout: 5000, interval: 25 });
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally {
      cancellation.abort();
      await killOriginal(leafProof);
      await killOriginal(mainProof);
      await pending;
      const boundary = events[0]?.resourceId;
      if (boundary !== undefined && retainedOwnedCommandBoundaries().some(value => value.resourceId === boundary)) {
        await reconcileOwnedCommandBoundary(boundary, save, Date.now() + 10_000);
      }
      operation.dispose();
    }
  }, 35_000);

  it("retains a live guardian after a stop deadline and reconciles its resistant descendant", async () => {
    const directory = await root(), ready = path.join(directory, "ready"), terminated = path.join(directory, "term");
    const source = `import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(terminated)},'received'));writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
    const cancellation = new AbortController(), events: OwnedCommandLifecycleEvent[] = [];
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 30_000, requestMs: 30_000 } });
    const save = async (event: OwnedCommandLifecycleEvent) => { events.push(event); };
    const stop = processProof.stopControllerProcesses;
    // Give the real signal/inspection path less than its graceful interval.
    // Reconciliation then receives a fresh budget for the same saved identity.
    const stopping = vi.spyOn(processProof, "stopControllerProcesses").mockImplementationOnce((proof, native, _deadline, lease, options) => stop(proof, native, Date.now() + 1000, lease, options));
    const pending = runLifecycleOwnedCommand({ file: process.execPath, args: ["--input-type=module", "--eval", source], environment: process.env }, operation, save).catch(error => error);
    let original: ProcessProof | undefined;
    try {
      original = await captureProcessProof(Number(await waitFile(ready)));
      cancellation.abort(new Error("bounded stop"));
      await expect(pending).resolves.toMatchObject({ name: "OwnedCommandCleanupError" });
      expect(await readFile(terminated, "utf8")).toBe("received");
      expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "unknown"]);
      expect(await inspectProcessProof(events[1]!.proof!)).toBe("running");
      expect(await inspectProcessProof(original)).toBe("running");
      stopping.mockRestore();
      await reconcileOwnedCommandBoundary(events[0]!.resourceId, save, Date.now() + 10_000);
      expect(events.at(-1)?.stage).toBe("stopped");
      expect(await inspectProcessProof(original)).toBe("stopped");
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally {
      cancellation.abort(); stopping.mockRestore();
      await killOriginal(original);
      await pending;
      const boundary = events[0]?.resourceId;
      if (boundary !== undefined && retainedOwnedCommandBoundaries().some(value => value.resourceId === boundary)) {
        await reconcileOwnedCommandBoundary(boundary, save, Date.now() + 10_000);
      }
      operation.dispose();
    }
  }, 20_000);

  it("cleans its original group if the owner disconnects after the command has exited", async () => {
    const directory = await root(), ready = path.join(directory, "leaf");
    const leaf = `import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
    const source = `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(leaf)}],{stdio:'ignore'});child.unref();`;
    const helper = path.resolve(import.meta.dirname, "../../../dist/commands/worker/owned-command-helper.js");
    const child = spawn(process.execPath, [helper, randomUUID()], { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout!.resume();
    // Join each resource explicitly: manual parent-side IPC disconnection can
    // omit ChildProcess's aggregate close event even after all handles close.
    const closed = Promise.all([
      new Promise<void>(resolve => child.once("exit", () => resolve())),
      new Promise<void>(resolve => child.once("disconnect", () => resolve())),
      ...[child.stdout!, child.stderr!].map(stream => new Promise<void>(resolve => stream.once("close", () => resolve()))),
    ]);
    const bound = Promise.withResolvers<ProcessProof>(), result = Promise.withResolvers<void>();
    let diagnostic = "";
    const observations: string[] = [];
    child.on("exit", (code, signal) => observations.push(`exit=${code}/${signal}`));
    child.on("close", () => observations.push("close"));
    child.on("disconnect", () => observations.push("disconnect"));
    child.stdout!.on("close", () => observations.push("stdout-close"));
    child.stderr!.on("close", () => observations.push("stderr-close"));
    child.stderr!.on("data", chunk => { diagnostic += String(chunk); });
    const bounded = async <T>(promise: Promise<T>, stage: string): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Launcher ${stage} did not settle: ${diagnostic}; ${observations.join(",")}`)), 5000);
        })]);
      } finally { clearTimeout(timer); }
    };
    child.on("message", (value: unknown) => {
      const message = value as { kind: string; proof: ProcessProof };
      if (message.kind === "bound") bound.resolve(message.proof);
      if (message.kind === "result") result.resolve();
      observations.push(message.kind);
    });
    child.once("error", error => { bound.reject(error); result.reject(error); });
    let proof: ProcessProof | undefined, leafProof: ProcessProof | undefined;
    try {
      proof = await bounded(bound.promise, "birth");
      child.send({ kind: "run", file: process.execPath, args: ["--input-type=module", "--eval", source], environment: process.env });
      leafProof = await captureProcessProof(Number(await waitFile(ready)));
      await bounded(result.promise, "result");
      expect(await inspectProcessProof(proof)).toBe("running");
      child.disconnect();
      await bounded(closed, "disconnect");
      await vi.waitFor(async () => expect(await inspectProcessProof(leafProof!)).toBe("stopped"), { timeout: 5000, interval: 25 });
    } finally {
      // Before intentional disconnect, a failed observation can leave an
      // uncaptured descendant. Retire its whole original group before the
      // guardian, rather than losing the only witness to that descendant.
      if (child.connected && proof !== undefined) {
        await processProof.stopControllerProcesses(proof, [], Date.now() + 10_000, undefined, { guardian: true });
      }
      if (child.connected) child.disconnect();
      if (proof === undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await bounded(closed, "fixture cleanup");
      await killOriginal(leafProof);
    }
  }, 20_000);
});
