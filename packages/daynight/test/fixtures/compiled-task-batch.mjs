import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runCli } from "../../dist/cli/application.js";
import { createCliContext } from "../../dist/cli/context.js";

const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
const { version } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const argumentSets = JSON.parse(process.argv[2]);
const results = [];

for (const args of argumentSets) {
  const output = [];
  let stderr = "";
  const code = await runCli(["task", ...args], {
    ...createCliContext(version, packageDirectory),
    stdout: text => output.push(Buffer.from(text)),
    stdoutBytes: async bytes => { output.push(Buffer.from(bytes)); },
    stderr: text => { stderr += text; },
  });
  results.push({ code, stdout: Buffer.concat(output).toString("utf8"), stderr });
}

process.stdout.write(JSON.stringify(results));
