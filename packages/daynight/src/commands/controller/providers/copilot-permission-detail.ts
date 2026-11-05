import { record, string } from "./native-rpc.js";
import { readable } from "./projection.js";

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

type Detail = { field: string; text: string };
const format = (value: unknown, title: string): Detail[] => {
  const request = record(value), lines: Detail[] = [];
  const add = (label: string, value: unknown, field = label || "target"): void => { if (typeof value === "string" && value.length) lines.push({ field, text: label + value }); };
  switch (request.kind) {
    case "shell":
    case "commands": {
      add("", request.fullCommandText);
      if (!lines.length) break;
      const directories = unique([string(request.workingDirectory), ...(Array.isArray(request.commandSegments) ? request.commandSegments.map(segment => string(record(segment).workingDirectory)) : [])]);
      for (const directory of directories) add("Working directory: ", directory);
      const paths = strings(request.possiblePaths);
      if (paths.length) add("Possible paths: ", unique(paths).join("\n"));
      const urls = Array.isArray(request.possibleUrls) ? request.possibleUrls.map(url => typeof url === "string" ? url : string(record(url).url)) : [];
      if (unique(urls).length) add("URLs: ", unique(urls).join("\n"));
      break;
    }
    case "write":
      add("", request.fileName);
      if (lines.length) {
        if (string(request.diff)) add("", request.diff, "changes");
        else if (typeof request.newFileContents === "string") add("", request.newFileContents || "New contents: (empty)", "changes");
      }
      break;
    case "read":
      add("", request.path);
      break;
    case "path":
      add("", unique(strings(request.paths)).join("\n"));
      if (lines.length) add("Access: ", request.accessKind);
      break;
    case "url":
      add("", request.url);
      if (lines.length) add("Redirected from: ", request.redirectedFrom);
      break;
    case "mcp":
      if (string(request.serverName) && string(request.toolName)) {
        add("", `${string(request.serverName)} / ${string(request.toolName)}`);
        add("Tool: ", request.toolTitle);
        if (typeof request.readOnly === "boolean") add("Read only: ", String(request.readOnly));
        if (request.args !== undefined) add("Arguments:\n", readable(request.args));
      }
      break;
  }
  if (!lines.length) {
    // Unknown request content is kept intact; only envelope metadata is omitted.
    // Do not filter inside opaque tool arguments or other native business data.
    const fallback = Object.fromEntries(Object.entries(request).filter(([key]) => !["toolCallId", "canOfferSessionApproval"].includes(key) && !(key === "intention" && request[key] === title)));
    return [{ field: "fallback", text: Object.keys(fallback).length ? readable(fallback) : readable(value) }];
  }
  add("Warning: ", request.warning);
  if (request.requestSandboxBypass === true) {
    add("", "Sandbox bypass requested", "sandbox");
    add("Reason: ", request.requestSandboxBypassReason);
  }
  return lines;
};

/** Preserve native decision content; the interaction codec enforces its existing size limit. */
export const copilotPermissionDetail = (permission: unknown, prompt: unknown): string => {
  const title = string(record(prompt).intention) || "Copilot permission";
  const blocks = [...(permission === undefined ? [] : format(permission, title)), ...(prompt === undefined ? [] : format(prompt, title))];
  const seen = new Set<string>();
  const detail = blocks.filter(block => {
    const key = JSON.stringify([block.field, block.text]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(block => block.text).join("\n");
  // JSON envelopes previously escaped these characters; preserve that readable
  // representation while keeping ordinary newlines and Unicode text intact.
  return detail.replace(/[\u0000\uD800-\uDFFF]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
};
