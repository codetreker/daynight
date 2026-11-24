import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { publishCandidateArtifact, verifyCandidateArtifact } from "../src/subtask-compat-artifact.ts";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..", ".tmp");

test("the recovery handoff binds Server bytes and Git revision across checkout states", { timeout: 120_000 }, async () => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "subtask-compat-artifact-"));
  const source = path.join(directory, "source"), output = path.join(directory, "server"), handoff = path.join(directory, "handoff"), destination = path.join(handoff, "candidate-server");
  try {
    await mkdir(path.join(source, "cmd/daynight-server"), { recursive: true });
    await mkdir(handoff, { mode: 0o700 });
    await writeFile(path.join(source, "go.mod"), "module github.com/codetreker/daynight/packages/daynight-server\n\ngo 1.24.0\n");
    await writeFile(path.join(source, "cmd/daynight-server/main.go"), "package main\nfunc main() {}\n");
    await writeFile(path.join(source, "README.md"), "fixture\n");
    const git = async (...args: string[]) => await execute("git", args, { cwd: source, timeout: 30_000 });
    await git("init"); await git("config", "user.name", "E2E fixture"); await git("config", "user.email", "e2e@example.test");
    await git("add", "go.mod", "cmd/daynight-server/main.go", "README.md"); await git("commit", "-m", "Initialize fixture");
    const revision = (await git("rev-parse", "HEAD")).stdout.trim();
    await execute("go", ["build", "-trimpath", "-o", output, "./cmd/daynight-server"], { cwd: source, timeout: 90_000, env: { ...process.env, GOENV: "off", GOWORK: "off", GOTOOLCHAIN: "local" } });
    const hash = createHash("sha256").update(await readFile(output)).digest("hex");
    await publishCandidateArtifact(output, destination, hash);
    assert.equal(await verifyCandidateArtifact(destination, hash, revision, source), true);
    assert.equal(await verifyCandidateArtifact(destination, hash, "0".repeat(40), source), false);
    await assert.rejects(publishCandidateArtifact(output, destination, hash), { code: "EEXIST" });
    const linked = path.join(handoff, "link"); await symlink(destination, linked);
    assert.equal(await verifyCandidateArtifact(linked, hash, revision, source), false);
    await writeFile(destination, "changed");
    assert.equal(await verifyCandidateArtifact(destination, hash, revision, source), false);
    const mismatch = path.join(handoff, "mismatch");
    await assert.rejects(publishCandidateArtifact(output, mismatch, "0".repeat(64)), /does not match/);
    await writeFile(path.join(source, "README.md"), "unrelated fixture edit\n");
    const dirtyOutput = path.join(directory, "dirty-server"), dirtyHandoff = path.join(handoff, "dirty-server");
    await execute("go", ["build", "-trimpath", "-o", dirtyOutput, "./cmd/daynight-server"], { cwd: source, timeout: 90_000, env: { ...process.env, GOENV: "off", GOWORK: "off", GOTOOLCHAIN: "local" } });
    const dirtyHash = createHash("sha256").update(await readFile(dirtyOutput)).digest("hex");
    await publishCandidateArtifact(dirtyOutput, dirtyHandoff, dirtyHash);
    assert.equal(await verifyCandidateArtifact(dirtyHandoff, dirtyHash, revision, source), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
