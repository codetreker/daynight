#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: node validate-finding.mjs [--forbid <text>]... <package/finding.json>\nValidates local files and prints their byte counts and SHA256 hashes. Each --forbid value fails validation when it occurs, case-insensitively, in a text file; binary files are listed as unscanned. Does not publish or approve a finding.";
const fields = new Set(["format", "title", "description", "prototype", "evidence", "supportingFiles"]);
// The UI-only format predates topic skills and keeps its mandatory prototype.
const formats = new Map([
  ["daynight-finding-v1", { prototypeRequired: false }],
  ["daynight-ui-finding-v1", { prototypeRequired: true }],
]);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function relativeFile(value) {
  check(typeof value === "string" && value.length > 0, "A file path must be a nonempty relative string.");
  check(!path.posix.isAbsolute(value) && !/[\\\p{Cc}\p{Cs}]/u.test(value) && !/^[a-z][a-z0-9+.-]*:/i.test(value), `Not a portable relative path: ${value}`);
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

// Text is valid UTF-8 without NUL bytes; screenshots, PDFs and other binary files
// cannot be scanned for private strings and need visual review instead.
function decodeText(bytes) {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return undefined; }
}

// Package descriptions use inline links or single-line reference definitions.
// This is deliberately not a general Markdown renderer.
export function descriptionLinks(markdown) {
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
    try {
      const segments = link.split(/[?#]/, 1)[0].split("/").map((encoded) => {
        const decoded = decodeURIComponent(encoded);
        check(!decoded.includes("/"), "Encoded path separators are not attachment segments.");
        return decoded;
      });
      return relativeFile(segments.join("/"));
    }
    catch (error) { throw new Error(`Invalid attachment link ${link}: ${error.message}`); }
  });
}

export async function validateFinding(manifestPath, { forbid = [] } = {}) {
  check(Array.isArray(forbid) && forbid.every((value) => typeof value === "string" && value.trim().length > 0), "Each forbidden value must be a nonempty string.");
  const absolute = path.resolve(manifestPath);
  const root = path.dirname(absolute);
  const rootStat = await lstat(root);
  check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Package root must be a real directory.");
  const manifestName = path.basename(absolute);
  const raw = await regularFile(root, manifestName);
  const manifest = parseJson(raw, manifestName);
  check(manifest !== null && typeof manifest === "object" && !Array.isArray(manifest), "finding.json must describe one package.");
  const format = formats.get(manifest.format);
  check(format, "Unsupported finding format.");
  for (const field of Object.keys(manifest)) check(fields.has(field), `Unknown finding field: ${field}`);
  check(typeof manifest.title === "string" && manifest.title.trim().length > 0 && !/[\r\n]/.test(manifest.title), "title must be one nonempty line.");
  check(typeof manifest.description === "string" && manifest.description.length > 0, "description is required.");
  if (format.prototypeRequired || manifest.prototype !== undefined) check(typeof manifest.prototype === "string" && manifest.prototype.length > 0, "prototype is required.");
  check(Array.isArray(manifest.evidence) && manifest.evidence.length > 0, "evidence must list at least one file.");
  check(manifest.supportingFiles === undefined || Array.isArray(manifest.supportingFiles), "supportingFiles must be a file list.");

  const contents = new Map([[manifestName, raw]]);
  const requested = [manifest.description, ...(manifest.prototype === undefined ? [] : [manifest.prototype]), ...manifest.evidence, ...(manifest.supportingFiles ?? [])];
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

  for (const link of descriptionLinks(contents.get(manifest.description).toString("utf8"))) {
    // The file supplies an inline task description; its links use the task attachment root.
    check(contents.has(link), `Description attachment link is not in the file inventory: ${link}`);
  }

  let privacyScan = null;
  if (forbid.length > 0) {
    const needles = forbid.map((value) => value.toLowerCase());
    const matches = [], unscanned = [];
    for (const [relative, bytes] of contents) {
      const text = decodeText(bytes);
      if (text === undefined) { unscanned.push(relative); continue; }
      const haystack = text.toLowerCase();
      needles.forEach((needle, index) => { if (haystack.includes(needle)) matches.push(`${relative}: ${forbid[index]}`); });
    }
    check(matches.length === 0, `Forbidden text found:\n${matches.sort().join("\n")}`);
    privacyScan = { values: forbid.length, unscanned: unscanned.sort((a, b) => a.localeCompare(b, "en")) };
  }

  return {
    valid: true,
    format: manifest.format,
    title: manifest.title,
    directory: root,
    privacyScan,
    limits: "Checks package structure, current bytes and supplied forbidden strings in text files only; does not judge issue independence, reproduction, images, prototype behavior, or permission to publish.",
    files: [...contents.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([relative, bytes]) => ({
      path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const forbid = [];
  let manifest;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--forbid") {
      const next = args[++index];
      check(next !== undefined && next.trim().length > 0, "--forbid needs a nonempty value.");
      forbid.push(next);
    } else {
      check(!value.startsWith("-") && manifest === undefined, usage);
      manifest = value;
    }
  }
  check(manifest !== undefined, usage);
  return { manifest, forbid };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(usage);
    else console.log(JSON.stringify(await validateFinding(options.manifest, { forbid: options.forbid }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
