#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: node validate-ui-finding.mjs <package/finding.json>\nValidates local files and prints their byte counts and SHA256 hashes. Does not publish or approve a finding.";
const fields = new Set(["format", "title", "description", "prototype", "evidence", "supportingFiles"]);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function relativeFile(value) {
  check(typeof value === "string" && value.length > 0, "A file path must be a nonempty relative string.");
  check(!path.posix.isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && !/^[a-z][a-z0-9+.-]*:/i.test(value), `Not a portable relative path: ${value}`);
  check(value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), `Invalid path component: ${value}`);
  return value;
}

async function regularFile(root, relative) {
  const parts = relativeFile(relative).split("/");
  let filename = root;
  for (let index = 0; index < parts.length; index++) {
    filename = path.join(filename, parts[index]);
    const stat = await lstat(filename);
    check(!stat.isSymbolicLink(), `Symbolic links are not package files: ${relative}`);
    check(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(), `Not a regular file path: ${relative}`);
  }
  const bytes = await readFile(filename);
  check(bytes.length > 0, `Empty package file: ${relative}`);
  return bytes;
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`Invalid JSON in ${label}`); }
}

// Package descriptions use inline links or single-line reference definitions.
// This is deliberately not a general Markdown renderer.
function localLinks(markdown) {
  let fence;
  const prose = markdown.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return "";
    }
    if (marker) { fence = marker; return ""; }
    return line;
  }).join("\n");
  const links = [];
  for (let index = 0; index < prose.length; index++) {
    if (prose[index] === "\\") { index++; continue; }
    if (prose[index] === "`") {
      const run = /^`+/.exec(prose.slice(index))[0];
      let end = index + run.length;
      while ((end = prose.indexOf(run, end)) !== -1) {
        if (prose[end - 1] !== "`" && prose[end + run.length] !== "`") break;
        end += run.length;
      }
      if (end !== -1) index = end + run.length - 1;
      else index += run.length - 1;
      continue;
    }
    if (prose[index] !== "[") continue;
    let end = index + 1, depth = 1;
    for (; end < prose.length && depth > 0; end++) {
      if (prose[end] === "\\") { end++; continue; }
      if (prose[end] === "[") depth++;
      else if (prose[end] === "]") depth--;
    }
    if (depth !== 0 || prose[end] !== "(") continue;
    check(!prose.slice(index + 1, end - 1).includes("!["), "Nested images in link labels are unsupported; use a separate image and link.");
    let start = end + 1;
    while (/\s/.test(prose[start] ?? "") && start < prose.length) start++;
    let targetEnd = start;
    if (prose[start] === "<") {
      start++; targetEnd = prose.indexOf(">", start);
      check(targetEnd !== -1, "Unclosed angle-bracket attachment link.");
    } else {
      depth = 0;
      for (; targetEnd < prose.length; targetEnd++) {
        const character = prose[targetEnd];
        if (character === "\\") { targetEnd++; continue; }
        if (character === "(") depth++;
        else if (character === ")") { if (depth === 0) break; depth--; }
        else if (/\s/.test(character) && depth === 0) break;
      }
    }
    check(targetEnd > start, "Empty attachment link destination.");
    links.push(prose.slice(start, targetEnd).replace(/\\([\\()[\]<>])/g, "$1"));
    let close = targetEnd + (prose[targetEnd] === ">" ? 1 : 0);
    while (close < prose.length && /\s/.test(prose[close])) close++;
    if (["\"", "'", "("].includes(prose[close])) {
      const delimiter = prose[close] === "(" ? ")" : prose[close];
      for (close++; close < prose.length; close++) {
        if (prose[close] === "\\") { close++; continue; }
        if (prose[close] === delimiter) break;
      }
      check(close < prose.length, "Unclosed attachment link title.");
      close++;
      while (close < prose.length && /\s/.test(prose[close])) close++;
    }
    check(prose[close] === ")", "Unsupported or malformed inline attachment link.");
    index = close;
  }
  for (const match of prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) links.push(match[1] ?? match[2]);
  return links.filter((link) => !link.startsWith("#") && !/^https?:\/\//i.test(link)).map((link) => {
    try { return relativeFile(decodeURIComponent(link.split(/[?#]/, 1)[0])); }
    catch (error) { throw new Error(`Invalid attachment link ${link}: ${error.message}`); }
  });
}

export async function validateUiFinding(manifestPath) {
  const absolute = path.resolve(manifestPath);
  const root = path.dirname(absolute);
  const rootStat = await lstat(root);
  check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Package root must be a real directory.");
  const manifestName = path.basename(absolute);
  const raw = await regularFile(root, manifestName);
  const manifest = parseJson(raw, manifestName);
  check(manifest !== null && typeof manifest === "object" && !Array.isArray(manifest), "finding.json must describe one package.");
  check(manifest.format === "daynight-ui-finding-v1", "Unsupported finding format.");
  for (const field of Object.keys(manifest)) check(fields.has(field), `Unknown finding field: ${field}`);
  check(typeof manifest.title === "string" && manifest.title.trim().length > 0 && !/[\r\n]/.test(manifest.title), "title must be one nonempty line.");
  for (const field of ["description", "prototype"]) check(typeof manifest[field] === "string" && manifest[field].length > 0, `${field} is required.`);
  check(Array.isArray(manifest.evidence) && manifest.evidence.length > 0, "evidence must list at least one file.");
  check(manifest.supportingFiles === undefined || Array.isArray(manifest.supportingFiles), "supportingFiles must be a file list.");

  const contents = new Map([[manifestName, raw]]);
  const requested = [manifest.description, manifest.prototype, ...manifest.evidence, ...(manifest.supportingFiles ?? [])];
  for (const relative of requested) {
    relativeFile(relative);
    check(!contents.has(relative), `Duplicate package file: ${relative}`);
    contents.set(relative, await regularFile(root, relative));
  }

  for (const relative of manifest.evidence) {
    if (!relative.endsWith(".json")) continue;
    const evidence = parseJson(contents.get(relative), relative);
    if (evidence?.format !== "daynight-ui-evidence-v1") continue;
    check(evidence.status === "consistent", `Capture ${relative} must be consistent; observed ${evidence.status ?? "missing status"}. Keep failed evidence outside the handoff package.`);
    check(["geometry", "screenshot", "screen-pdf"].includes(evidence.mode), `Unknown capture mode in ${relative}`);
    if (evidence.mode === "geometry") {
      check(evidence.artifact === null, `Geometry capture has an unexpected artifact: ${relative}`);
      continue;
    }
    const kind = evidence.mode === "screenshot" ? "screenshot" : "screen-media-pdf";
    check(evidence.artifact?.kind === kind, `Capture artifact kind does not match mode: ${relative}`);
    const artifact = path.posix.join(path.posix.dirname(relative), relativeFile(evidence.artifact.path));
    if (!contents.has(artifact)) contents.set(artifact, await regularFile(root, artifact));
  }

  for (const link of localLinks(contents.get(manifest.description).toString("utf8"))) {
    const relative = path.posix.join(path.posix.dirname(manifest.description), link);
    check(contents.has(relative), `Description attachment link is not in the file inventory: ${relative}`);
  }
  return {
    valid: true,
    title: manifest.title,
    directory: root,
    limits: "Checks package structure and current bytes only; does not judge issue independence, reproduction, privacy, prototype behavior, or permission to publish.",
    files: [...contents.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([relative, bytes]) => ({
      path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") console.log(usage);
    else {
      check(args.length === 1 && !args[0].startsWith("-"), usage);
      console.log(JSON.stringify(await validateUiFinding(args[0]), null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
