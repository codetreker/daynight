import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand, startCommand } from "./command.ts";

export const preparePinnedSource = async (options: {
  checkout: string;
  revision: string;
  upstream: string;
  localSource?: string;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
}): Promise<string> => {
  const { checkout, revision, signal } = options;
  const command = async (args: string[], cwd: string) => await runCommand("git", args, {
    cwd, env: options.environment, signal, timeoutMs: 120_000,
  });
  let exists = false;
  try { exists = (await stat(checkout)).isDirectory(); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  if (exists) {
    const head = await startCommand("git", ["--git-dir", path.join(checkout, ".git"), "--work-tree", checkout, "rev-parse", "--verify", "HEAD"], {
      cwd: checkout, env: options.environment, signal, timeoutMs: 15_000, onOutput: () => {},
    }).finished;
    if (head.exitCode === 0) {
      if (head.stdout.trim() !== revision) throw new Error("Cached auth source does not match the pinned revision.");
      await command(["diff", "--exit-code", "--stat", "HEAD", "--"], checkout);
      return checkout;
    }
    // An interrupted first preparation can leave an initialized repository
    // without a checked-out commit; only complete sources enter the cache.
    await rm(checkout, { recursive: true });
  }
  const preparing = `${checkout}.preparing-${randomUUID()}`;
  await mkdir(path.dirname(checkout), { recursive: true });
  try {
    if (options.localSource !== undefined) {
      await command(["clone", "--no-hardlinks", "--no-checkout", path.resolve(options.localSource), preparing], path.dirname(checkout));
    } else {
      await mkdir(preparing);
      await command(["init"], preparing);
      await command(["remote", "add", "origin", options.upstream], preparing);
    }
    await command(["fetch", "--depth=1", "origin", revision], preparing);
    await command(["checkout", "--detach", revision], preparing);
    const head = await command(["rev-parse", "HEAD"], preparing);
    if (head.stdout.trim() !== revision) throw new Error("Fetched auth source does not match the pinned revision.");
    await command(["diff", "--exit-code", "--stat", "HEAD", "--"], preparing);
    await rename(preparing, checkout);
    return checkout;
  } finally { await rm(preparing, { recursive: true, force: true }); }
};
