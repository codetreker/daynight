import { readFileSync } from "node:fs";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { runCommand } from "../src/command.ts";

export type Topology = { baseURL: string; authURL: string; proxyURL: string; cliEntry: string; cliConfigDirectory: string };
const runDirectory = process.env.DAYNIGHT_E2E_RUN_DIRECTORY;
if (runDirectory === undefined) throw new Error("Product E2E fixtures require the isolated runner.");
export const topology = JSON.parse(readFileSync(path.join(runDirectory, "environment.json"), "utf8")) as Topology;
export const cliEnvironment = { ...process.env, DN_CONFIG_DIR: topology.cliConfigDirectory };
export const cli = async (args: string[]) => await runCommand(process.execPath, [topology.cliEntry, ...args], {
  cwd: topology.cliConfigDirectory, env: cliEnvironment, timeoutMs: 30_000,
});
export const test = base;
export { expect };
