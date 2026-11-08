import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recoverEnvironment } from "./recovery.ts";

const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pointer = process.env.DAYNIGHT_E2E_RUN_POINTER;
if (pointer === undefined) throw new Error("CI recovery requires DAYNIGHT_E2E_RUN_POINTER from the product E2E step.");
const filename = path.resolve(pointer);
if (!filename.startsWith(`${repository}${path.sep}`)) throw new Error("The E2E run pointer must stay inside the checkout.");
const record = JSON.parse(await readFile(filename, "utf8")) as { schemaVersion: number; runDirectory: string; phase: "build" | "environment" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (record.schemaVersion !== 1 || typeof record.runDirectory !== "string" || !["build", "environment"].includes(record.phase) ||
  path.dirname(record.runDirectory) !== path.join(repository, ".tmp", "product-e2e") || !uuid.test(path.basename(record.runDirectory))) {
  throw new Error("The E2E run pointer does not identify a run in this checkout.");
}
await recoverEnvironment({ repository, runDirectory: record.runDirectory, phase: record.phase });
const lockFile = path.join(repository, ".tmp", "product-e2e-build-lock");
let owner: { schemaVersion: number; runDirectory: string } | undefined;
try { owner = JSON.parse(await readFile(lockFile, "utf8")) as typeof owner; }
catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
if (owner !== undefined) {
  if (owner.schemaVersion !== 1 || owner.runDirectory !== record.runDirectory) throw new Error("Build lock belongs to another E2E run; recovery will not remove it.");
  await rm(lockFile);
}
console.log(`E2E recovery verified resources and private data for ${path.basename(record.runDirectory)}.`);
