import { writeFile } from "node:fs/promises";
import path from "node:path";
import { manualTopicFiles } from "../../src/commands/skill/manual.js";

export const manualTopicSources = (): Map<string, Uint8Array> => new Map(manualTopicFiles.map((filename, index) => [filename, new TextEncoder().encode(`# Topic ${index + 1}\n\nTopic content.\n`)]));

export const writeManualTopics = async (directory: string): Promise<void> => {
  for (const [filename, contents] of manualTopicSources()) await writeFile(path.join(directory, filename), contents);
};
