import { describe, expect, it } from "vitest";
import type { Task } from "../../../src/api/index.js";
import { renderTaskList } from "../../../src/commands/task/rendering.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

const projectId = "abcdefab-1111-4222-8333-123456789abc";
const time = "2026-10-20T00:00:00.123456789Z";
const task: Task = { type: "task", parentId: null, id: "abcdefab-2222-4222-8333-123456789abc", projectId, title: "Task title", description: "Description", tags: [], properties: { pullRequests: [] }, status: "todo", allowAgents: false, assignedTo: null, requiredPlatform: null, version: 9_007_199_254_740_993n, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time };

describe("task rendering stress", () => {
  it("renders full values in linear space despite an outlier title or description", () => {
    const tasks = Array.from({ length: 1_000 }, (_, index) => ({ ...task, id: `${index.toString(16).padStart(8, "0")}-2222-4222-8333-123456789abc`, title: index === 0 ? "T".repeat(4_096) : `Task ${index}` }));
    const output = renderTaskList(tasks);
    let contentLength = 0;
    for (const current of tasks) {
      expect(output).toContain(`ID: ${current.id}\nProject: ${projectId}\nTitle: ${current.title}\n`);
      contentLength += current.id.length + current.projectId.length + current.title.length + current.description.length + current.status.length + current.version.toString().length + current.createdAt.length + current.updatedAt.length + `Automatic execution: ${current.allowAgents}\nRequired platform: ${current.requiredPlatform === null ? "any" : current.requiredPlatform}\nAssigned to: ${current.assignedTo === null ? "unassigned" : current.assignedTo}\n`.length;
    }
    expect(output.length).toBeLessThanOrEqual(contentLength + 190 * tasks.length);
  });
});
