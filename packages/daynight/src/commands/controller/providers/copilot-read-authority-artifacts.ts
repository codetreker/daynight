import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const profile = {
  executable: "5fd7d15ff02deb08a58593b1b488015bb52c1686014b80b5509e28263cb3ad70",
  files: {
    "index.js": "19f4cb854302397bdd880f5cde12ed069d373a630dce3f09a60e62b8ac8fcc4c",
    "cli-main.js": "8b6ce892c34775028d9f8c31e39a346e24becdd94f660a6985f8ecb53e8b3fde",
    "prebuilds/darwin-arm64/runtime.node": "423ba722d1fa544ba352fd6e702d5b67f78419995a0247580185aa030bcbc1fb",
  },
};
export type CopilotAuthorityArtifacts = { entry: string; cleanup(): Promise<void> };
async function digest(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 209_715_200) throw new Error("Unsupported Copilot artifact.");
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(path, { signal: AbortSignal.timeout(15_000) })) {
    size += (chunk as Buffer).length;
    if (size > 209_715_200) throw new Error("Unsupported Copilot artifact.");
    hash.update(chunk);
  }
  if (size !== info.size) throw new Error("Copilot artifact changed.");
  return hash.digest("hex");
}
async function boundTree(root: string): Promise<void> {
  const pending = [{ path: root, depth: 0 }]; let files = 0, bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++files > 10_000 || item.depth > 32) throw new Error("Copilot extraction exceeds its limit.");
    const info = await lstat(item.path);
    if (info.isDirectory()) for (const name of await readdir(item.path)) pending.push({ path: join(item.path, name), depth: item.depth + 1 });
    else if (!info.isFile() || (bytes += info.size) > 536_870_912) throw new Error("Unsupported Copilot extraction.");
  }
}

/** Unknown builds retain the ordinary provider; internal ABI is opt-in by bytes. */
export async function prepareCopilotAuthorityArtifacts(executable: string, env: NodeJS.ProcessEnv, diagnostic?: (message: string) => void): Promise<CopilotAuthorityArtifacts | undefined> {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  let owned: string | undefined;
  try {
    const require = createRequire(import.meta.url);
    // 1.0.11's public require entry is dist/cjs/index.js; package.json is private.
    const sdk = JSON.parse(await readFile(join(dirname(require.resolve("@github/copilot-sdk")), "../../package.json"), "utf8")) as { version?: unknown };
    if (sdk.version !== "1.0.11" || await digest(executable) !== profile.executable) return;
    owned = await mkdtemp(join(tmpdir(), "daynight-copilot-read-"));
    // The pinned SEA extracts its own distribution. Never touch the user's cache.
    await new Promise<void>((resolve, reject) => execFile(executable, ["--binary-version"], {
      env: { ...env, COPILOT_PKG_CACHE_HOME: owned, COPILOT_SEA_EXTRACT_ONLY: "1" },
      timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 65_536, windowsHide: true,
    }, error => error ? reject(error) : resolve()));
    const root = join(owned, "pkg", "darwin-arm64", "1.0.105");
    await boundTree(root);
    for (const [file, expected] of Object.entries(profile.files)) if (await digest(join(root, file)) !== expected) throw new Error("Copilot extraction identity mismatch.");
    const directory = owned;
    return { entry: join(root, "index.js"), cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch {
    if (owned) await rm(owned, { recursive: true, force: true });
    diagnostic?.("Copilot local image authority is unavailable for this runtime; text operations remain available.");
    return;
  }
}
