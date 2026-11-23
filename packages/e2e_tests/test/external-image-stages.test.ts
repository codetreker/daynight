import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recoverEnvironment } from "../src/recovery.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const stagesURL = new URL("../../daynight/scripts/external-image-harness/stages.ts", import.meta.url).href;
const commandURL = new URL("../src/command.ts", import.meta.url).href;
const directory = async (): Promise<string> => {
  const run = path.join(repository, ".tmp", "product-e2e", randomUUID());
  await mkdir(path.join(run, "results"), { recursive: true });
  await mkdir(path.join(run, "private"));
  return run;
};
const execute = (run: string, script: string): void => {
  execFileSync(process.execPath, ["--input-type=module", "-e", script, repository, run], { timeout: 15_000, stdio: "pipe" });
};

test("external image stages prove joined build and environment before owner and independent recovery", async () => {
  const run = await directory();
  try {
    execute(run, `
      import { ExternalImageStages } from ${JSON.stringify(stagesURL)};
      import { runCommand } from ${JSON.stringify(commandURL)};
      const stages = new ExternalImageStages(process.argv[1], process.argv[2]);
      await stages.initialize();
      await runCommand(process.execPath, ['-e', 'process.exit(0)'], {cwd:process.argv[1],timeoutMs:5000,onOutput:()=>{}});
      await stages.finishBuild(new AbortController().signal);
      stages.beginEnvironment();
      await runCommand(process.execPath, ['-e', 'process.exit(0)'], {cwd:process.argv[1],timeoutMs:5000,onOutput:()=>{}});
      await stages.finishEnvironment(new AbortController().signal);
      await stages.verifyOwner();
    `);
    for (const stage of ["build", "environment"]) {
      const marker = JSON.parse(await readFile(path.join(run, "results", `${stage}-complete.json`), "utf8"));
      assert.deepEqual(marker, { schemaVersion: 1, directoryId: path.basename(run), complete: true });
    }
    await recoverEnvironment({ repository, runDirectory: run, phase: "build" });
    await assert.rejects(stat(path.join(run, "private")), { code: "ENOENT" });
  } finally { await rm(run, { recursive: true }); }
});

test("a joined failure records its stage, but an interrupted environment cannot be marked or cleaned", async () => {
  const run = await directory();
  try {
    await writeFile(path.join(run, "private", "evidence"), "keep");
    execute(run, `
      import { ExternalImageStages } from ${JSON.stringify(stagesURL)};
      import { runCommand } from ${JSON.stringify(commandURL)};
      const stages = new ExternalImageStages(process.argv[1], process.argv[2]);
      await stages.initialize();
      try { await runCommand(process.execPath, ['-e', 'process.exit(7)'], {cwd:process.argv[1],timeoutMs:5000,onOutput:()=>{}}); } catch {}
      await stages.settleFailure(false);
      stages.beginEnvironment();
      await stages.settleFailure(true);
      try { await stages.verifyOwner(); throw new Error('Unconfirmed setup was accepted'); }
      catch (error) { if (!String(error).includes('Environment setup process stop is unverified')) throw error; }
    `);
    await assert.rejects(stat(path.join(run, "results", "environment-complete.json")), { code: "ENOENT" });
    await assert.rejects(recoverEnvironment({ repository, runDirectory: run, phase: "environment" }), /Environment setup process stop is unverified/);
    assert.equal(await readFile(path.join(run, "private", "evidence"), "utf8"), "keep");
  } finally { await rm(run, { recursive: true }); }
});

test("an unresolved command prevents stage completion and owner cleanup", async () => {
  const run = await directory();
  try {
    await writeFile(path.join(run, "private", "evidence"), "keep");
    execute(run, `
      import { ExternalImageStages } from ${JSON.stringify(stagesURL)};
      import { runCommand } from ${JSON.stringify(commandURL)};
      const stages = new ExternalImageStages(process.argv[1], process.argv[2]);
      await stages.initialize();
      try { await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {cwd:process.argv[1],timeoutMs:100,onOutput:()=>{}}); } catch {}
      await stages.settleFailure(false);
      try { await stages.verifyOwner(); throw new Error('Unconfirmed build was accepted'); }
      catch (error) { if (!String(error).includes('Build process stop is unverified')) throw error; }
    `);
    await assert.rejects(stat(path.join(run, "results", "build-complete.json")), { code: "ENOENT" });
    await assert.rejects(recoverEnvironment({ repository, runDirectory: run, phase: "build" }), /Build process stop is unverified/);
    assert.equal(await readFile(path.join(run, "private", "evidence"), "utf8"), "keep");
  } finally { await rm(run, { recursive: true }); }
});

test("an active build command prevents the stage marker until its process group stops", async () => {
  const run = await directory();
  try {
    execute(run, `
      import assert from 'node:assert/strict';
      import { stat } from 'node:fs/promises';
      import path from 'node:path';
      import { ExternalImageStages } from ${JSON.stringify(stagesURL)};
      import { startCommand } from ${JSON.stringify(commandURL)};
      const stages = new ExternalImageStages(process.argv[1], process.argv[2]);
      await stages.initialize();
      const command = startCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {cwd:process.argv[1],timeoutMs:5000,onOutput:()=>{}});
      await assert.rejects(stages.finishBuild(new AbortController().signal), /lifecycle.*unconfirmed/);
      await assert.rejects(stat(path.join(process.argv[2], 'results', 'build-complete.json')), {code:'ENOENT'});
      await command.stop();
      await stages.finishBuild(new AbortController().signal);
      await stages.verifyOwner();
    `);
    await recoverEnvironment({ repository, runDirectory: run, phase: "build" });
    await assert.rejects(stat(path.join(run, "private")), { code: "ENOENT" });
  } finally { await rm(run, { recursive: true }); }
});
