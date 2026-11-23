import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";

it("builds fresh and resumed Worker prompts from an installed package without repository workflows", async () => {
  const fixture = await createAcceptanceCli();
  try {
    const cwd = path.join(fixture.receipt.root, "independent project 中文");
    await mkdir(cwd);
    const installedDist = path.dirname(fixture.receipt.entryPath);
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", String.raw`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [dist, repositoryPath] = process.argv.slice(1);
assert.equal(existsSync(path.join(repositoryPath, ".agents", "skills")), false);
assert.equal(existsSync(path.join(dist, "commands/skill/skills/using-daynight/references/autopilot-managed-task.md")), false);
const { buildWorkerPrompt } = await import(pathToFileURL(path.join(dist, "commands/worker/prompts.js")).href);
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const task = {
  projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), workerId: uuid(4), worktreeId: uuid(5),
  serverOrigin: "https://daynight.example", status: "active", agent: "codex", sessionId: null,
  configuration: { agent: "codex", model: null, args: [], recoveryLimit: 3 },
  worktree: { repositoryPath, commonDirectory: path.join(repositoryPath, ".git"), worktreePath: path.join(repositoryPath, ".worktrees", "daynight", uuid(2)), branch: "daynight/" + uuid(2) },
};
const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
for (const sessionId of [null, uuid(6)]) {
  const prompt = buildWorkerPrompt({ ...task, sessionId }, platform);
  const instruction = sessionId === null ? "This is a new native conversation for this execution." : "Continue this execution in its original native conversation and worktree. Reconcile interrupted business work before proceeding.";
  const [body] = prompt.split("Assignment:\n\n");
  const restored = body.replace(instruction, "{{Instructions for starting a new native conversation or resuming in the original native conversation and worktree}}") + "Assignment:\n\n{{The complete Assignment JSON injected at runtime}}\n";
  assert.equal(createHash("sha256").update(restored).digest("hex"), "da3d148d2f6b5a42995835b0d82fab405f39d4d50a81ff8c809f11d911368e28");
  const assignment = JSON.parse(prompt.split("Assignment:\n\n")[1]);
  assert.deepEqual(assignment, { serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, worktreePath: task.worktree.worktreePath, branch: task.worktree.branch, platform, nativeSessionId: sessionId, configuration: task.configuration });
  assert.ok(prompt.includes(sessionId === null ? "new native conversation" : "original native conversation"));
  assert.ok(prompt.includes("use the original claim and exact observed version"));
  assert.ok(prompt.includes("Do not blindly replay writes"));
  assert.equal(prompt.includes("development-workflow"), false);
}
`, installedDist, cwd], { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (result.error !== undefined) throw result.error;
    expect(result.status, result.stderr).toBe(0);
  } finally { await fixture.cleanup(); }
});
