import { stringifyApiJson } from "../../api/json.js";
import type { Tag, TagPage } from "../../api/tags.js";
import { terminalText } from "../../platform/terminal.js";

export const renderTag = (tag: Tag): string => [
  `ID: ${tag.id}`,
  `Project: ${tag.projectId}`,
  `Name: ${terminalText(tag.name)}`,
  `Version: ${tag.version}`,
  `Visible usage: ${tag.usage.tasks} Tasks, ${tag.usage.goals} Goals`,
  `Created: ${terminalText(tag.createdAt)}`,
  `Updated: ${terminalText(tag.updatedAt)}`,
  "",
].join("\n");

export const renderTagList = (page: TagPage, filtered: boolean, afterCursor: boolean): string => {
  const heading = `Catalog epoch: ${terminalText(page.catalogEpoch)}\n`;
  if (page.items.length === 0) return `${heading}${afterCursor ? "No more Tags after the cursor." : filtered ? "No matching Tags." : "No Tags."}\n`;
  return `${heading}${page.items.map(renderTag).join("\n")}`;
};

export const renderTagJson = (value: unknown): string => `${stringifyApiJson(value)}\n`;
