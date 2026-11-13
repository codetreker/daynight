import type { TaskTag } from "./types";
import { array, id, malformed, record, string } from "./validation";

export const parseTaskTags = (value: unknown): readonly TaskTag[] => {
  const tags = array(value, (item): TaskTag => {
    const data = record(item), name = string(data.name);
    if (!name.isWellFormed() || name !== name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "") ||
      name.length === 0 || Array.from(name).length > 64 || /[\p{Cc}\u2028\u2029]/u.test(name)) return malformed();
    return { id: id(data.id), name };
  });
  if (new Set(tags.map((tag) => tag.id)).size !== tags.length) return malformed();
  return tags;
};

export const sameTaskTags = (left: readonly TaskTag[], right: readonly TaskTag[]): boolean => {
  if (left.length !== right.length) return false;
  const names = new Map(left.map((tag) => [tag.id, tag.name]));
  return right.every((tag) => names.get(tag.id) === tag.name);
};
