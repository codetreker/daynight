import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { workerFixtureConfiguration } from "../src/worker-config.ts";

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
