import { describe, expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import { parsePage, parseProject, parseTaskGraph } from "../../src/api/parse.js";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const teamId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const time = "2026-11-04T00:00:00Z";
const project = {
  id: projectId, name: " Project ", repoUrl: "https://example.test/repo.git",
  settings: { version: 9_007_199_254_740_993n, executionWarningMinutes: 60 },
  ownership: { teamId, version: 9_223_372_036_854_775_807n }, createdAt: time, updatedAt: time,
};

describe("intrinsic Project ownership", () => {
  it("preserves independent exact versions in Project, page and graph projections", () => {
    const body = parseApiJson(stringifyApiJson(project));
    expect(parseProject(body, projectId)).toEqual(project);
    const page = parseApiJson(stringifyApiJson({ items: [project], nextCursor: null }));
    expect(parsePage(page, parseProject, ({ id }) => id).items).toEqual([project]);
    const graph = parseApiJson(stringifyApiJson({
      observedAt: time, project, summary: { total: 1, todo: 1, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 0 },
      tasks: [{ id: teamId, titlePreview: "Task", titleTruncated: false, status: "todo", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, allowAgents: false, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time }],
    }));
    expect(parseTaskGraph(graph, projectId, teamId).project).toEqual(project);
  });

  it.each([
    undefined, null, {}, { teamId }, { teamId, version: 0 }, { teamId, version: -1 },
    { teamId, version: 1.5 }, { teamId, version: "9007199254740993" },
    { teamId, version: 9_223_372_036_854_776_000 }, { teamId: "invalid", version: 1 },
    { teamId: teamId.toUpperCase(), version: 1 }, { teamId, version: 1, owner: true },
  ])("rejects missing, obsolete or malformed ownership case %#", (ownership) => {
    const body = parseApiJson(stringifyApiJson({ ...project, ownership }));
    expect(() => parseProject(body)).toThrow("invalid response");
  });

  it("leaves opaque properties versions untouched while decoding resource ownership", () => {
    const body = parseApiJson('{"ownership":{"teamId":"' + teamId + '","version":9007199254740993},"properties":{"ownership":{"version":9007199254740993}}}') as {
      ownership: { version: bigint }; properties: { ownership: { version: number } };
    };
    expect(body.ownership.version).toBe(9_007_199_254_740_993n);
    expect(typeof body.properties.ownership.version).toBe("number");
  });
});
