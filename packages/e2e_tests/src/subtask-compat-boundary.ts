import { assertCommandQuiescence, type CommandOptions, type ManagedCommand } from "./command.ts";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { recoverRunOwnership, startOwnedPlaywright } from "./fixture-owner.ts";
import { completeFailedEnvironmentSetup, markEnvironmentComplete, type CleanupReceipt } from "./recovery.ts";

// The environment factory has returned and all its commands have joined. The
// subsequently launched authentication browser is owned by the Playwright gate.
export const completeCompatEnvironmentSetup = async (runDirectory: string): Promise<void> => {
  assertCommandQuiescence();
  await markEnvironmentComplete(runDirectory);
};

// A returned environment is joined before any authentication browser starts.
// An interrupted factory without a returned owner remains unconfirmed.
export const settleCompatEnvironmentSetupFailure = async (runDirectory: string, returned: boolean, cancelled: boolean): Promise<boolean> =>
  await completeFailedEnvironmentSetup(runDirectory, true, !returned && cancelled);

export const startCompatPlaywright = async (input: { repository: string; runDirectory: string; command: string; args: readonly string[]; options: CommandOptions }): Promise<ManagedCommand> => {
  input.options.signal?.throwIfAborted();
  return await startOwnedPlaywright(input);
};

export const finalizeCompatEnvironment = async (input: {
  repository: string;
  runDirectory: string;
  environment: { close(): Promise<void> } | undefined;
  environmentComplete: boolean;
  preparingEnvironment: boolean;
  buildComplete: boolean;
}): Promise<{ completed: boolean; receipt?: CleanupReceipt; failures: unknown[] }> => {
  const failures: unknown[] = [];
  let fixtureVerified = false;
  try { await recoverRunOwnership({ repository: input.repository, runDirectory: input.runDirectory, mode: "owner" }); fixtureVerified = true; }
  catch (error) { failures.push(error); }
  if (fixtureVerified && input.environmentComplete && input.environment !== undefined) {
    try { await input.environment.close(); }
    catch (error) { failures.push(error); }
  }
  let runtimeVerified = !input.preparingEnvironment;
  let receipt: CleanupReceipt | undefined;
  if (fixtureVerified && input.environmentComplete && input.preparingEnvironment) {
    try {
      receipt = JSON.parse(await readFile(path.join(input.runDirectory, "results", "environment-cleanup.json"), "utf8")) as CleanupReceipt;
      runtimeVerified = receipt.verified;
      if (!runtimeVerified && failures.length === 0) failures.push(new Error("Runtime cleanup did not produce a verified successful receipt."));
    } catch (error) { failures.push(error); }
  }
  if (!input.buildComplete) failures.push(new Error("Build process stop is unverified; original resources and evidence are retained."));
  if (input.preparingEnvironment && !input.environmentComplete) failures.push(new Error("Environment setup process stop is unverified; original resources and evidence are retained."));
  if (fixtureVerified && runtimeVerified && failures.length === 0) {
    for (const directory of ["private", "artifacts"]) {
      try { await rm(path.join(input.runDirectory, directory), { recursive: true, force: true }); }
      catch (error) { failures.push(error); }
    }
  }
  return { completed: fixtureVerified && runtimeVerified && failures.length === 0, ...(receipt === undefined ? {} : { receipt }), failures };
};
