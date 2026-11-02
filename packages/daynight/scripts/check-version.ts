import { execFileSync } from "node:child_process";
import semver from "semver";

const packageManifest = "packages/daynight/package.json";
const zeroSha = "0".repeat(40);
const releaseFiles = new Set([
  packageManifest,
  "packages/daynight/tsconfig.json",
  "packages/daynight/tsconfig.build.json",
  "packages/daynight/scripts/clean-dist.ts",
  "packages/daynight/scripts/copy-skills.ts",
  "packages/daynight/scripts/copy-resources.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
]);

export const checkVersion = (event: string, base: string, head: string, cwd: string): string => {
  if (event !== "pull_request" && event !== "push") throw new Error(`Unsupported version-check event: ${event}. Expected pull_request or push.`);
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) throw new Error("Version checking requires full 40-character Git BASE_SHA and HEAD_SHA values.");
  if (head === zeroSha || (event === "pull_request" && base === zeroSha)) throw new Error("Version checking requires existing commits; only an initial push may have an all-zero BASE_SHA.");

  const git = (...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const verifyCommit = (sha: string): void => {
    if (git("cat-file", "-t", sha).trim() !== "commit") throw new Error(`Expected a Git commit: ${sha}.`);
  };
  const readVersion = (sha: string): string => {
    const manifest: unknown = JSON.parse(git("show", `${sha}:${packageManifest}`));
    if (typeof manifest !== "object" || manifest === null || !("version" in manifest) || typeof manifest.version !== "string" || semver.valid(manifest.version) === null) {
      throw new Error(`${packageManifest} at ${sha} must contain a valid semantic version string.`);
    }
    return manifest.version;
  };

  verifyCommit(head);
  const headVersion = readVersion(head);
  if (base === zeroSha) return `Initialized ${packageManifest} version baseline at ${headVersion}.`;
  verifyCommit(base);
  const baseVersion = readVersion(base);
  const comparisonBase = event === "pull_request" ? git("merge-base", base, head).trim() : base;
  const changedPaths = git("diff", "--name-only", "-z", "--no-renames", comparisonBase, head, "--").split("\0");
  const releaseInputChanged = changedPaths.some((file) => file.startsWith("packages/daynight/src/") || releaseFiles.has(file));
  if (!releaseInputChanged) return "No release inputs changed; no package version increase required.";
  if (!semver.gt(headVersion, baseVersion)) {
    throw new Error(`Release inputs changed: increase ${packageManifest} version above ${baseVersion}; HEAD version is ${headVersion}.`);
  }
  return `${packageManifest} version increased: ${baseVersion} -> ${headVersion}.`;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw new Error("Usage: node packages/daynight/scripts/check-version.ts <pull_request|push> <BASE_SHA> <HEAD_SHA>");
  console.log(checkVersion(args[0]!, args[1]!, args[2]!, process.cwd()));
}
