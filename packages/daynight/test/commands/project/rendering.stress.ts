import { describe, expect, it } from "vitest";
import type { Project } from "../../../src/api/index.js";
import { renderProjectList } from "../../../src/commands/project/rendering.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

const project: Project = { id: "abcdefab-1234-5678-90ab-abcdefabcdef", name: "Project 名称", repoUrl: "git@Git.Example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: "2026-10-20T01:02:03.123456789Z", updatedAt: "2026-10-20T02:03:04.987654321Z" };

describe("project rendering stress", () => {
  it("renders a large complete list without argument-stack limits", () => {
    const projects = Array.from({ length: 140_000 }, (_, index) => ({ ...project, id: `${index.toString(16).padStart(8, "0")}-1234-5678-90ab-abcdefabcdef` }));
    const output = renderProjectList(projects);
    let count = 0;
    for (const _ of output.matchAll(/^ID: /gm)) count++;
    expect(count).toBe(projects.length);
    expect(output).toContain(projects.at(-1)!.id);
  });

  it("keeps full human list output linear when one project has a long name", () => {
    const projects = Array.from({ length: 1_000 }, (_, index) => ({ ...project, id: `${index.toString(16).padStart(8, "0")}-1234-5678-90ab-abcdefabcdef`, name: index === 0 ? "N".repeat(4_096) : `Project ${index}` }));
    const output = renderProjectList(projects);
    let contentLength = 0;
    for (const current of projects) {
      expect(output).toContain(`ID: ${current.id}\nName: ${current.name}\nRepository: ${current.repoUrl}\n`);
      contentLength += current.id.length + current.name.length + current.repoUrl.length + current.createdAt.length + current.updatedAt.length;
    }
    expect(output.length).toBeLessThanOrEqual(contentLength + 80 * projects.length);
  });

});
