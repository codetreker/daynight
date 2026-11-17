import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { prepareWorkerFixtureConfiguration, workerFixtureConfiguration } from "../src/worker-config.ts";

// The CLI reads JSON and YAML through this same YAML parser with unique keys.
const require = createRequire(path.resolve(import.meta.dirname, "../../daynight/package.json"));
const { parseDocument } = require("yaml") as typeof import("../../daynight/node_modules/yaml/dist/index.js");
const token = "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890";
const cases = [
  ["JSON", JSON.stringify({ serverUrl: "https://daynight.example", serverToken: token, workerId: "old-worker", worker: { agent: "claude" } })],
  ["YAML", `serverUrl: https://daynight.example\nserverToken: ${token}\nworkerId: old-worker\nworker:\n  agent: claude\n`],
] as const;

for (const [format, source] of cases) test(`builds isolated Worker configuration from ${format} CLI credentials`, () => {
  const original = parseDocument(source, { strict: true, uniqueKeys: true, stringKeys: true });
  assert.deepEqual(original.errors, []);
  const server = original.toJS() as { serverUrl: string; serverToken: string };
  const generated = workerFixtureConfiguration({ serverUrl: server.serverUrl, serverToken: server.serverToken, workerId: "new-worker",
    repositoryRoot: "/tmp/repositories", peer: "/tmp/codex.mjs", projectId: "project", remote: "https://example.test/repo.git", repository: "/tmp/repository" });
  const result = parseDocument(generated, { strict: true, uniqueKeys: true, stringKeys: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.toJS(), { serverUrl: "https://daynight.example", serverToken: token, workerId: "new-worker", worker: {
    agentControlMode: "web", agent: "codex", pollIntervalMs: 1000, maxConcurrent: 1, repositoryRoot: "/tmp/repositories",
    toolPaths: { codex: "/tmp/codex.mjs" }, repositories: [{ projectId: "project", remote: "https://example.test/repo.git", path: "/tmp/repository" }],
  } });
});

test("isolates Worker state and preserves it for restart without touching the CLI cache", async () => {
  const base = path.resolve(import.meta.dirname, "../../../.tmp/e2e-worker-config-test");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  try {
    const cliDirectory = path.join(root, "cli"), fixtureRoot = path.join(root, "fixture");
    await mkdir(path.join(cliDirectory, "worker"), { recursive: true });
    await mkdir(fixtureRoot);
    const cliConfig = path.join(cliDirectory, "config.yml"), oldCache = path.join(cliDirectory, "worker", "configuration.json");
    await writeFile(cliConfig, `serverUrl: https://daynight.example\nserverToken: ${token}\nworkerId: old-worker\n`, { mode: 0o600 });
    await writeFile(oldCache, "old worker cache", { mode: 0o600 });
    const original = await readFile(cliConfig, "utf8");
    const input = { serverUrl: "https://daynight.example", serverToken: token, workerId: "new-worker",
      repositoryRoot: "/tmp/repositories", peer: "/tmp/codex.mjs", projectId: "project",
      remote: "https://example.test/repo.git", repository: "/tmp/repository" };
    const directory = await prepareWorkerFixtureConfiguration(fixtureRoot, input);
    assert.equal(directory, path.join(fixtureRoot, "worker-config"));
    assert.notEqual(directory, cliDirectory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "config.yml"))).mode & 0o777, 0o600);
    assert.equal((JSON.parse(await readFile(path.join(directory, "config.yml"), "utf8")) as { workerId: string }).workerId, "new-worker");
    await mkdir(path.join(directory, "worker"));
    await writeFile(path.join(directory, "worker", "configuration.json"), "new worker cache");
    await assert.rejects(prepareWorkerFixtureConfiguration(fixtureRoot, input), { code: "EEXIST" });
    assert.equal(await readFile(path.join(directory, "worker", "configuration.json"), "utf8"), "new worker cache");
    assert.equal(await readFile(oldCache, "utf8"), "old worker cache");
    assert.equal(await readFile(cliConfig, "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
