import { canonicalId, ProtocolError } from "./validation.js";
import type { Task } from "./types.js";

// Snapshot the submitted set before transport or receipt validation.
export const normalizeTaskTagIds = (ids: readonly string[]): string[] => {
  const normalized = ids.map((value) => {
    const id = canonicalId(value);
    if (id === null) throw new Error("Tag IDs must be hyphenated UUIDs.");
    return id;
  });
  return [...new Set(normalized)].toSorted();
};

export const confirmTaskTagIds = (task: Task, expected: readonly string[]): void => {
  const actual = task.tags.map(tag => tag.id).toSorted();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new ProtocolError("Task does not confirm the requested tag set.");
  }
};
