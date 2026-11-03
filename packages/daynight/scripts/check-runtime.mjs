import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const installed = path.resolve(process.argv[2]);
const manifestPath = path.join(installed, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.name, "@codetreker/daynight");
assert.equal(manifest.engines.node, ">=22");
const entry = path.join(installed, "dist/main.js");
for (const alias of ["daynight", "dn"]) {
  assert.equal(manifest.bin[alias], "dist/main.js");
  const launcher = path.resolve(installed, "../../.bin", alias);
  assert.equal(execFileSync(launcher, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(), manifest.version);
}
for (const args of [["--help"], ["task", "--help"], ["skill", "--help"], ["update", "--help"]]) {
  assert.match(execFileSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 10_000 }), /Usage:/);
}

const load = (relative) => import(pathToFileURL(path.join(installed, relative)).href);
const { parseApiJson, stringifyApiJson } = await load("dist/api/json.js");
const versionJson = '{"version":9223372036854775807}';
assert.equal(parseApiJson(versionJson).version, 9_223_372_036_854_775_807n);
assert.equal(stringifyApiJson(parseApiJson(versionJson)), versionJson);
const { detectSkillAgents } = await load("dist/commands/skill/agents.js");
assert.ok(Array.isArray(await detectSkillAgents()));
await load("dist/commands/update/updater.js");

const { openStore, readReviewListingSnapshot } = await load("dist/commands/review/store.js");
const temporary = await mkdtemp(path.join(path.dirname(installed), "runtime-"));
try {
  const databaseFile = path.join(temporary, "state.sqlite");
  const store = openStore(databaseFile);
  try {
    store.registerRepository({ host: "github.com", githubId: "42", remote: "https://github.com/owner/repo.git", localPath: path.join(temporary, "repo") });
  } finally {
    store.close();
  }
  const listingPaths = { databaseFile, lockFile: path.join(temporary, "instance.lock") };
  assert.equal(readReviewListingSnapshot(listingPaths).repositories.length, 1);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

execFileSync(process.execPath, ["--input-type=module", "--eval", String.raw`
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { select, checkbox } from "@inquirer/prompts";
for (const [prompt, config, expected] of [
  [select, { message: "Select runtime", choices: [{ name: "Node.js", value: "node" }] }, "node"],
  [checkbox, { message: "Select runtimes", choices: [{ name: "Node.js", value: "node", checked: true }], validate: (values) => values.length > 0 }, ["node"]],
]) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  output.once("data", () => setImmediate(() => input.write("\n")));
  try {
    assert.deepEqual(await prompt(config, { input, output, signal: AbortSignal.timeout(5_000) }), expected);
  } finally {
    input.destroy();
    output.destroy();
  }
}
`], { cwd: installed, stdio: "inherit", timeout: 15_000 });
console.log(`Node.js ${process.version}: CLI ${manifest.version}, launchers, command loading, lossless JSON, SQLite and prompts passed.`);
