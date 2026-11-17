import { readFileSync } from "node:fs";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { CommandFailure, type CommandOptions } from "../src/command.ts";
import { beginBrowserScope, bindBrowserScope, finishBrowserScope, startOwnedAuxiliary } from "../src/fixture-owner.ts";

export type Topology = { baseURL: string; authURL: string; proxyURL: string; cliEntry: string; cliConfigDirectory: string };
const runDirectory = process.env.DAYNIGHT_E2E_RUN_DIRECTORY;
if (runDirectory === undefined) throw new Error("Product E2E fixtures require the isolated runner.");
export const topology = JSON.parse(readFileSync(path.join(runDirectory, "environment.json"), "utf8")) as Topology;
// Node's color-conflict warning would corrupt the image decoder's stderr protocol.
const { FORCE_COLOR: _forcedColor, ...environment } = process.env;
export const cliEnvironment = { ...environment, DN_CONFIG_DIR: topology.cliConfigDirectory };
const repository = path.resolve(import.meta.dirname, "../../..");
export const startOwnedCommand = async (command: string, args: readonly string[], options: CommandOptions, independentController = false) => startOwnedAuxiliary({ repository, runDirectory, command, args, options, independentController });
export const runOwnedCommand = async (command: string, args: readonly string[], options: CommandOptions) => {
  const result = await (await startOwnedCommand(command, args, options)).finished;
  if (result.exitCode !== 0) throw new CommandFailure(command, result);
  return result;
};
export const cli = async (args: string[]) => await runOwnedCommand(process.execPath, [topology.cliEntry, ...args], {
  cwd: topology.cliConfigDirectory, env: cliEnvironment, timeoutMs: 30_000,
});
export const test = base.extend({
  browser: [async ({ playwright, browserName, headless, channel, launchOptions }, use) => {
    if (browserName !== "chromium") throw new Error("The product E2E browser ownership fixture requires Chromium.");
    const scope = await beginBrowserScope(repository, runDirectory);
    let server: Awaited<ReturnType<typeof playwright.chromium.launchServer>> | undefined, bound = false;
    try {
      server = await playwright.chromium.launchServer({ ...launchOptions, headless, ...(channel === undefined ? {} : { channel }) });
      const pid = server.process().pid;
      if (pid === undefined) throw new Error("The original browser process identity is unavailable.");
      await bindBrowserScope(repository, runDirectory, scope, pid); bound = true;
      const browser = await playwright.chromium.connect(server.wsEndpoint());
      try { await use(browser); } finally { await browser.close(); }
    } finally {
      if (server !== undefined) try { await server.close(); } finally { if (bound) await finishBrowserScope(repository, runDirectory, scope); }
    }
  }, { scope: "worker", timeout: 0 }],
});
export { expect };
