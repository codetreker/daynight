import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.ts";

const digest = async (filename: string): Promise<string> => createHash("sha256").update(await readFile(filename)).digest("hex");

export const publishCandidateArtifact = async (source: string, destination: string, expected: string): Promise<void> => {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Candidate artifact hash is invalid.");
  const parent = await lstat(path.dirname(destination));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Candidate handoff directory is not an ordinary directory.");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (await digest(temporary) !== expected) throw new Error("Candidate handoff artifact does not match the built Server.");
    const file = await open(temporary, "r"); try { await file.sync(); } finally { await file.close(); }
    await link(temporary, destination);
    await unlink(temporary);
    const directory = await open(path.dirname(destination), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
};

export const verifyCandidateArtifact = async (filename: string, expected: string, revision: string, cwd: string): Promise<boolean> => {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{40}$/.test(revision)) return false;
  try {
    const file = await lstat(filename);
    if (!file.isFile() || file.isSymbolicLink() || await digest(filename) !== expected) return false;
    const build = await runCommand("go", ["version", "-m", filename], { cwd, timeoutMs: 30_000, onOutput: () => {} });
    return build.stdout.includes("\tpath\tgithub.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server\n") &&
      build.stdout.includes(`\tbuild\tvcs.revision=${revision}\n`) && /\tbuild\tvcs\.modified=(?:true|false)\n/.test(build.stdout) && await digest(filename) === expected;
  } catch { return false; }
};
