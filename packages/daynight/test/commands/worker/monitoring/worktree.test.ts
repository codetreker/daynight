import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSelectedWorktrees } from "../../../../src/commands/worker/monitoring/selected-worktrees.js";
import { encodeWorktree, validWorktreePath } from "../../../../src/commands/worker/monitoring/worktree.js";

describe("failure worktree encoding", () => {
  it("uses the supplied checkout and target without filesystem access", () => {
    expect(encodeWorktree("/projects/项目", "/projects/项目/.worktrees/a b", path.posix)).toEqual({ kind: "project-relative", path: ".worktrees/a b" });
    expect(encodeWorktree("/projects/项目", "/projects/retained", path.posix)).toEqual({ kind: "project-relative", path: "../retained" });
    expect(encodeWorktree("/projects/项目", "/projects/项目", path.posix)).toEqual({ kind: "project-relative", path: "." });
    expect(encodeWorktree("C:\\repo", "c:\\repo\\工作 tree", path.win32)).toEqual({ kind: "project-relative", path: "工作 tree" });
    expect(encodeWorktree("C:\\repo", "D:\\tree", path.win32)).toEqual({ kind: "unavailable", reason: "different-volume" });
    expect(encodeWorktree("\\\\s\\one\\repo", "\\\\s\\two\\tree", path.win32)).toEqual({ kind: "unavailable", reason: "different-volume" });
  });
  it("rejects unsafe inputs and distinguishes byte limits", () => {
    for (const input of ["relative", "/root/\u0000x", "/root/\ud800"]) expect(encodeWorktree("/root", input, path.posix)).toEqual({ kind: "unavailable", reason: "invalid-path" });
    expect(encodeWorktree("/root", "/root/" + "é".repeat(2048), path.posix)).toEqual({ kind: "project-relative", path: "é".repeat(2048) });
    expect(encodeWorktree("/root", "/root/" + "é".repeat(2049), path.posix)).toEqual({ kind: "unavailable", reason: "limit-exceeded" });
    for (const input of ["", "/absolute", "C:relative", "a\\b", "a//b", "a/../b", "./a", "a/", "a/\u0085", "\ud800"]) expect(validWorktreePath(input)).toBe(false);
    for (const input of [".", "../outside", "../../outside", "é/😄"]) expect(validWorktreePath(input)).toBe(true);
  });
});


describe("selected worktree responsibility", () => {
  it("retains the original binding until matching cleanup releases it", () => {
    const selected = createSelectedWorktrees();
    const owner = { projectId: "project", taskId: "task", claimId: "claim", worktreeId: "original" };
    const otherOwner = { ...owner, worktreeId: "replacement" };
    const root = path.resolve("selected-root"), worktree = path.join(root, "selected");
    selected.select(owner, root, worktree);
    expect(selected.get(owner)).toEqual({ kind: "project-relative", path: "selected" });
    expect(selected.get(otherOwner)).toBeUndefined();
    selected.select(otherOwner, root, path.join(root, "replacement"));
    expect(selected.get(owner)).toEqual({ kind: "project-relative", path: "selected" });
    selected.release(otherOwner);
    expect(selected.get(owner)).toEqual({ kind: "project-relative", path: "selected" });
    selected.release(owner);
    expect(selected.get(owner)).toBeUndefined();
  });
});
