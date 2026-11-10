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
  const assignment = JSON.parse(prompt.split("Assignment:\n\n")[1]);
  assert.deepEqual(assignment, { serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, worktreePath: task.worktree.worktreePath, branch: task.worktree.branch, platform, nativeSessionId: sessionId, configuration: task.configuration });
  assert.ok(prompt.includes(sessionId === null ? "new native conversation" : "original native conversation"));
  assert.ok(prompt.includes("--claim-id <original-claim-id>"));
  assert.ok(prompt.includes("do not automatically replay it"));
  assert.equal(prompt.includes("development-workflow"), false);
}
`, installedDist, cwd], { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (result.error !== undefined) throw result.error;
    expect(result.status, result.stderr).toBe(0);
  } finally { await fixture.cleanup(); }
});
