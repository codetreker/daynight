import { describe, expect, it } from "vitest";
import { parseTask, parseTaskSearchPage } from "../../src/api/parse.js";
import { projectId, task } from "../fixtures/task-observation.js";

const tags = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "backend" },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "中文 & 😀" },
];
const searchItem = {
  id: task.id, type: "task", parentId: null, projectId, title: "Task", status: "in_progress",
  cancelledAt: null, assignedTo: null, updatedAt: task.updatedAt, context: null,
  match: { fields: ["title"], descriptionSnippet: null }, tags,
};
const search = (value: unknown) => parseTaskSearchPage({ projectId, total: 1, items: [value], nextCursor: null }, projectId).items[0]!;

describe("required Task tag references", () => {
  it("retains empty and multiple references in full and lean search results", () => {
    expect(parseTask({ ...task, tags: [] }, projectId).tags).toEqual([]);
    expect(parseTask({ ...task, tags }, projectId).tags).toEqual(tags);
    const item = search(searchItem);
    expect(item.tags).toEqual(tags);
    expect(item).not.toHaveProperty("assignedTo");
    expect(item).not.toHaveProperty("updatedAt");
  });

  it("uses each resource's own references and preserves identity across a rename", () => {
    const goalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const goal = { ...task, id: goalId, type: "goal", parentId: null, allowAgents: false, tags: [tags[0]], progress: { total: 1, done: 0, cancelled: 0, unfinished: 1 } };
    const child = { ...task, parentId: goalId, tags: [tags[1]] };
    expect(parseTask(goal, projectId).tags).toEqual([tags[0]]);
    expect(parseTask(child, projectId).tags).toEqual([tags[1]]);
    const renamed = [{ ...tags[0]!, name: "platform" }];
    expect(parseTask({ ...goal, tags: renamed }, projectId).tags).toEqual(renamed);
    expect(search({ ...searchItem, tags: renamed }).tags).toEqual(renamed);
  });

  it.each([
    ["missing", undefined], ["null", null], ["non-array", {}], ["bad ID", [{ id: "bad", name: "valid" }]],
    ["missing name", [{ id: tags[0]!.id }]], ["empty name", [{ id: tags[0]!.id, name: "" }]],
    ["untrimmed name", [{ id: tags[0]!.id, name: " valid " }]], ["control name", [{ id: tags[0]!.id, name: "a\nb" }]],
    ["too long name", [{ id: tags[0]!.id, name: "😀".repeat(65) }]],
    ["duplicate identity", [tags[0], tags[0]]],
  ])("rejects %s references in both response shapes", (_label, invalid) => {
    expect(() => parseTask({ ...task, tags: invalid }, projectId)).toThrow();
    expect(() => search({ ...searchItem, tags: invalid })).toThrow();
  });
});
