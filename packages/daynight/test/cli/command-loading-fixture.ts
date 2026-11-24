import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const reviewRuntime = ["better-sqlite3", "/commands/review/store.js", "/commands/review/runtime.js", "/commands/review/instance-lock.js", "/commands/review/listing.js"];

export async function createCommandLoadingFixture() {
  const executable = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
  const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "command-loading 中文-"));
  const home = path.join(directory, "home");
  const hook = path.join(directory, "imports.mjs");
  await writeFile(hook, `import { registerHooks } from 'node:module';
const blocked = JSON.parse(process.env.DAYNIGHT_TEST_BLOCK_IMPORTS);
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  const commandMetadata = /\\/commands\\/[^/]+\\/definition\\.js$/.test(resolved.url) || resolved.url.endsWith('/commands/task/session/read-definition.js') || resolved.url.endsWith('/commands/task/session/send-definition.js');
  if (!commandMetadata && blocked.some(value => specifier.includes(value) || resolved.url.includes(value))) throw new Error('Unexpected module import: ' + specifier);
  return resolved;
} });
`);
  const invoke = (args: string[], blocked: string[]) => spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, executable, ...args], {
    cwd: directory, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, DAYNIGHT_TEST_BLOCK_IMPORTS: JSON.stringify(blocked) },
  });
  return { home, invoke, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
