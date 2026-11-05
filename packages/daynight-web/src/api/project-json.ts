import { projectAccessSource } from "./auth-parse";
import { parseApiJson } from "./json";
import { jsonContainerSources, jsonObjectSources } from "./json-source";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const projectSource = (text: string): unknown => {
  const parsed: unknown = JSON.parse(text);
  if (object(parsed)) {
    const fields = jsonObjectSources(text);
    if (Object.hasOwn(parsed, "settings")) parsed.settings = parseApiJson(fields.get("settings")!);
    if (Object.hasOwn(parsed, "ownership")) parsed.ownership = parseApiJson(fields.get("ownership")!);
    if (Object.hasOwn(parsed, "access")) parsed.access = projectAccessSource(fields.get("access")!);
  }
  return parsed;
};

export const decodeProjectJson = async (response: Response): Promise<unknown> => projectSource(await response.text());

export const decodeProjectPageJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  const parsed: unknown = JSON.parse(text);
  if (object(parsed) && Array.isArray(parsed.items)) {
    parsed.items = jsonContainerSources(jsonObjectSources(text).get("items")!).map(projectSource);
  }
  return parsed;
};

export const decodeTaskGraphJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  const parsed: unknown = JSON.parse(text);
  if (object(parsed)) {
    const fields = jsonObjectSources(text);
    if (Object.hasOwn(parsed, "project")) parsed.project = projectSource(fields.get("project")!);
    if (Object.hasOwn(parsed, "actorAccess")) parsed.actorAccess = projectAccessSource(fields.get("actorAccess")!);
  }
  return parsed;
};
