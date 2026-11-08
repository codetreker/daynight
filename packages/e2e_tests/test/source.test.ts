import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { preparePinnedSource } from "../src/source.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

test("an interrupted initial source checkout is rebuilt and reused at the exact revision", async () => {
  const checkout = await mkdtemp(path.join(repository, ".tmp", "e2e-source-test-"));
  try {
    execFileSync("git", ["init", checkout], { stdio: "ignore" });
    const options = { checkout, revision, upstream: repository, localSource: repository };
    await preparePinnedSource(options);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(), revision);
    assert.equal(await preparePinnedSource(options), checkout);
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

test("changed pinned sources are rejected without resetting their content", async () => {
  const checkout = await mkdtemp(path.join(repository, ".tmp", "e2e-source-test-"));
  try {
    const options = { checkout, revision, upstream: repository, localSource: repository };
    await preparePinnedSource(options);
    const readme = path.join(checkout, "README.md");
    await writeFile(readme, "changed source\n");
    await assert.rejects(preparePinnedSource(options));
    assert.equal(await readFile(readme, "utf8"), "changed source\n");
  } finally { await rm(checkout, { recursive: true, force: true }); }
});
