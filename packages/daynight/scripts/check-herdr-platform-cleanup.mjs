import assert from "node:assert/strict";
import path from "node:path";
import { checkHerdrPlatformCleanup } from "./herdr-platform-cleanup.mjs";

const directory = path.resolve(import.meta.dirname, "../../../.tmp/herdr-tools/research-platform");
const evidence = await checkHerdrPlatformCleanup(directory, { requirePartial: process.platform === "win32" });
assert.equal(evidence.failures.length, 0, `Real Herdr cleanup is unconfirmed: ${evidence.failures.join(", ")}`);
