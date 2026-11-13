import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { promisify } from "node:util";
import { appendFile, chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

assert.equal(process.versions.node.split(".")[0], "24", "Official platform assets must be prepared with Node24.");
const root = path.resolve(import.meta.dirname, "../../../.tmp/herdr-tools/research-platform/official-tools");
const target = `${process.platform}-${process.arch}`;
const matrix = {
  "darwin-arm64": [
    ["herdr", "herdrdev/herdr", "v0.9.5", "herdr-macos-aarch64", "fb77c2232a05a8035421382c894392f4174e4e38a18e48af3dd0290157c3a7e2", "herdr"],
    ["codex", "openai/codex", "rust-v0.167.1", "codex-aarch64-apple-darwin.tar.gz", "4c97fbdafba21e172254107939489691195f34712cf0cb31293e5e21be8f5bfa", "codex-aarch64-apple-darwin"],
    ["copilot", "github/copilot-cli", "v1.0.105", "copilot-darwin-arm64.tar.gz", "34aacd03fb478d47e4b3cfc5ca045c37278c5d8d86239466521a16ea54ac84aa", "copilot"],
  ],
  "linux-x64": [
    ["herdr", "herdrdev/herdr", "v0.9.5", "herdr-linux-x86_64", "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d", "herdr"],
    ["codex", "openai/codex", "rust-v0.167.1", "codex-x86_64-unknown-linux-musl.tar.gz", "64bcc99c32e434b4bcb0508a97df9b7aeecdb97e956d976fb13661096ec4e3e2", "codex-x86_64-unknown-linux-musl"],
    ["copilot", "github/copilot-cli", "v1.0.105", "copilot-linux-x64.tar.gz", "aba1f06f27bc0447656647f76e0a4cf58b4b2a341c75ff04a750982b6aeb6bd2", "copilot"],
  ],
  "win32-x64": [
    ["herdr", "herdrdev/herdr", "v0.9.5", "herdr-windows-x86_64.zip", "d2c6c9c971c43a0bfdde8c692a9a1a7a45c3e4807cd01ae45662b4734fac1cbf", "herdr.exe"],
    ["codex", "openai/codex", "rust-v0.167.1", "codex-x86_64-pc-windows-msvc.exe", "c12aca02de615a9fcb76f955bf005a33f4b10b577f8a1730161953f57a1155b3", "codex.exe"],
    ["copilot", "github/copilot-cli", "v1.0.105", "copilot-win32-x64.zip", "34e16e9cf47de0e1534920171d6f39fa246638bddbb6ece820870b382bcc061a", "copilot.exe"],
  ],
};
const entries = matrix[target];
if (!entries) throw new Error(`Unsupported real Herdr validation target: ${target}.`);
await mkdir(root, { recursive: true });
const evidence = { target, node: process.version, sourceRevisions: { herdr: "2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01", codex: "0a94398fa60c4fac0e7659e4213a0a36e613dd46" }, assets: [], environment: { DAYNIGHT_HERDR_PLATFORM_TEST: "1" } };
for (const [tool, repository, version, asset, expectedHash, executableName] of entries) {
  const directory = path.join(root, tool), download = path.join(root, `${tool}.download`), url = `https://github.com/${repository}/releases/download/${version}/${asset}`;
  await rm(directory, { recursive: true, force: true }); await mkdir(directory);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Cannot download ${url}: ${response.status}.`);
  const hash = createHash("sha256");
  await pipeline(Readable.fromWeb(response.body), async function* (chunks) { for await (const chunk of chunks) { hash.update(chunk); yield chunk; } }, createWriteStream(download, { mode: 0o600 }));
  const actualHash = hash.digest("hex");
  if (actualHash !== expectedHash) throw new Error(`Official ${tool} asset digest differs: ${actualHash}.`);
  let executable;
  if (/\.(?:tar\.gz|zip)$/.test(asset)) {
    await promisify(execFile)(process.platform === "win32" ? path.join(process.env.SystemRoot, "System32/tar.exe") : "/usr/bin/tar", ["-xf", download, "-C", directory], { timeout: 30_000 });
    const files = await readdir(directory, { recursive: true });
    const matches = files.filter(file => path.basename(file) === executableName);
    if (matches.length !== 1) throw new Error(`Expected one ${executableName} in ${asset}.`);
    executable = path.join(directory, matches[0]); await rm(download);
  } else { executable = path.join(directory, executableName); await rename(download, executable); }
  // Codex release archives include the target in the filename; its documented install entry is codex.
  // https://github.com/openai/codex/blob/0a94398fa60c4fac0e7659e4213a0a36e613dd46/README.md#installing-and-running-codex-cli
  const installed = path.join(directory, process.platform === "win32" ? `${tool}.exe` : tool);
  if (executable !== installed) { await rename(executable, installed); executable = installed; }
  if (process.platform !== "win32") await chmod(executable, 0o700);
  evidence.assets.push({ tool, repository, version, asset, url, sha256: actualHash, executable });
  evidence.environment[`DAYNIGHT_TEST_${tool.toUpperCase()}`] = executable;
}
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
await writeFile(path.join(root, "receipt.json"), serialized);
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, Object.entries(evidence.environment).map(([key, value]) => `${key}=${value}\n`).join(""));
process.stdout.write(serialized);
