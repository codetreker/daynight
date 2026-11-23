import path from "node:path";

// /proc/self/cwd resolves independently in each child to its run-private directory.
// This keeps Chromium's Unix socket path short without moving private data out of the run.
export const browserCommandOptions = (runDirectory: string): { cwd: string; env: NodeJS.ProcessEnv } => ({
  cwd: path.join(runDirectory, "private"),
  env: { ...process.env, TMPDIR: "/proc/self/cwd" },
});
