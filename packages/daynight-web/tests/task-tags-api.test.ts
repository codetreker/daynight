import { afterEach, describe, expect, it, vi } from "vitest";
import { getTask, getTaskSync } from "../src/api/client";
import { searchTasks } from "../src/api/task-search";
import { parseTaskTags, sameTaskTags } from "../src/api/task-tags";
import { directAccessFixture } from "./helpers/taskSync";
import { wireResponse } from "./helpers/wireJson";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const userId = "30000000-0000-4000-8000-000000000001";
const tagId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "40000000-0000-4000-8000-000000000001";
const time = "2026-10-20T12:34:56Z";
const common = { id: taskId, type: "task", parentId: null, status: "todo", assignedTo: null, requiredPlatform: null,
  allowAgents: false, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time };
const detail = { ...common, projectId, title: "Task", description: "", properties: {}, version: 1n,
  dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true };
const summary = { ...common, titlePreview: "Task", titleTruncated: false, properties: {}, version: "1", dependsOn: [], externalDependsOn: [] };
const project = { id: projectId, name: "Project", repoUrl: "git@example.test/project", settings: { version: 1n, executionWarningMinutes: 60 },
  ownership: { teamId: "00000000-0000-4000-8000-000000000701", version: 1n }, createdAt: time, updatedAt: time };
const searchItem = { ...common, projectId, title: "Task", context: null, match: { fields: ["title"], descriptionSnippet: null } };
const admission = { userId, onPrincipalMismatch: vi.fn() };
const signal = () => new AbortController().signal;
const reads = [
  { body: (tags: unknown) => ({ ...detail, tags }), read: () => getTask(projectId, taskId, signal(), admission).then((value) => value.tags) },
  { body: (tags: unknown) => ({ mode: "snapshot", epoch, project, observedAt: time, tasks: [{ ...summary, tags }],
    dependencyStates: { [taskId]: { taskVersion: "1", blockedBy: [], ready: true } }, sessions: {}, actorAccess: directAccessFixture(projectId, userId), assigneeVersions: [] }),
  read: () => getTaskSync(projectId, {}, userId, signal()).then((value) => value.sync.tasks[0]!.tags) },
  { body: (tags: unknown) => ({ projectId, total: 1, items: [{ ...searchItem, tags }], nextCursor: null }),
    read: () => searchTasks(projectId, "Task", { status: "", assignedTo: "", type: "task", parentId: null, tagIds: [], tagMatch: "all", untagged: false }, null, signal(), admission).then((value) => value.items[0]!.tags) },
];
afterEach(() => vi.unstubAllGlobals());

describe("Task tag read contract", () => {
  it.each(reads)("retains canonical references at each API entry", async ({ body, read }) => {
    const tags = [{ id: tagId.toUpperCase(), name: "标签 😀" }, { id: otherId, name: "\ufeff" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wireResponse(body(tags), { headers: { "Daynight-User-ID": userId } })));
    await expect(read()).resolves.toEqual([{ id: tagId, name: "标签 😀" }, { id: otherId, name: "\ufeff" }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wireResponse(body([]), { headers: { "Daynight-User-ID": userId } })));
    await expect(read()).resolves.toEqual([]);
  });

  it.each(reads)("rejects absent and malformed tags at each API entry", async ({ body, read }) => {
    for (const tags of [undefined, null, {}, [null], [{ id: tagId }], [{ name: "name" }], [{ id: "bad", name: "name" }],
      [{ id: tagId, name: "" }], [{ id: tagId, name: " name" }], [{ id: tagId, name: "name\n" }],
      [{ id: tagId, name: "\ud800" }], [{ id: tagId, name: "a".repeat(65) }],
      [{ id: tagId, name: "a" }, { id: tagId.toUpperCase(), name: "a" }]]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wireResponse(body(tags), { headers: { "Daynight-User-ID": userId } })));
      await expect(read()).rejects.toMatchObject({ kind: "protocol" });
    }
  });

  it("compares identities and names independently of collection order", () => {
    const a = parseTaskTags([{ id: tagId, name: "First" }, { id: otherId, name: "Second" }]);
    expect(sameTaskTags(a, [...a].reverse())).toBe(true);
    expect(sameTaskTags(a, [{ id: tagId, name: "Renamed" }, a[1]!])).toBe(false);
    expect(sameTaskTags(a, [a[0]!])).toBe(false);
    expect(sameTaskTags(a, [a[0]!, { id: epoch, name: "Second" }])).toBe(false);
  });
});
