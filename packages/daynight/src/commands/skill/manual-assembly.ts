import path from "node:path/posix";
import { manualTopicFiles, validateManualContents } from "./manual.js";

type Heading = { readonly level: number; readonly title: string; readonly slug: string };
type Topic = { readonly filename: string; readonly lines: readonly string[]; readonly headings: ReadonlyMap<number, Heading>; readonly anchors: ReadonlySet<string>; readonly title: string; readonly root: string };
type Fence = { readonly marker: string; readonly length: number };

const headingSlug = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replaceAll(" ", "-");
const namespace = (filename: string): string => path.basename(filename, ".md");
const anchor = (filename: string, slug: string): string => `${namespace(filename)}--${slug}`;

const proseLines = (lines: readonly string[], filename: string): ReadonlySet<number> => {
  let fence: Fence | undefined;
  const prose = new Set<number>();
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (fence === undefined) prose.add(index);
  }
  if (fence !== undefined) throw new Error(`Unclosed code fence in manual topic: ${filename}`);
  return prose;
};

const parseTopic = (filename: string, contents: Uint8Array): Topic => {
  validateManualContents(contents);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(contents).replaceAll("\r\n", "\n");
  const lines = text.trimEnd().split("\n");
  const prose = proseLines(lines, filename);
  const headings = new Map<number, Heading>();
  const anchors = new Set<string>();
  for (const index of prose) {
    const matched = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]!);
    if (matched === null) continue;
    const level = matched[1]!.length;
    const title = matched[2]!;
    const slug = headingSlug(title);
    if (level === 6 || slug === "" || anchors.has(slug)) throw new Error(`Invalid or duplicate heading in manual topic ${filename}: ${title}`);
    anchors.add(slug);
    headings.set(index, { level, title, slug });
  }
  const roots = [...headings.values()].filter(({ level }) => level === 1);
  if (roots.length !== 1 || headings.get(0)?.level !== 1) throw new Error(`Manual topic must start with exactly one top-level heading: ${filename}`);
  return { filename, lines, headings, anchors, title: roots[0]!.title, root: roots[0]!.slug };
};

const linkTarget = (source: Topic, href: string, topics: ReadonlyMap<string, Topic>): string => {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href)) return href;
  const separator = href.indexOf("#");
  const filename = separator === -1 ? href : href.slice(0, separator);
  const fragment = separator === -1 ? undefined : href.slice(separator + 1);
  const targetPath = filename === "" ? source.filename : path.normalize(path.join(path.dirname(source.filename), filename));
  const target = topics.get(targetPath);
  if (target === undefined || filename.includes("\\")) throw new Error(`Unknown manual topic link in ${source.filename}: ${href}`);
  const slug = fragment === undefined || fragment === "" ? target.root : decodeURIComponent(fragment);
  if (!target.anchors.has(slug)) throw new Error(`Unknown manual heading link in ${source.filename}: ${href}`);
  return `#${anchor(target.filename, slug)}`;
};

const renderTopic = (topic: Topic, topics: ReadonlyMap<string, Topic>): string => {
  const prose = proseLines(topic.lines, topic.filename);
  return topic.lines.map((line, index) => {
    if (!prose.has(index)) return line;
    const rewritten = line.replace(/(\[[^\]]*\]\()([^)]*)(\))/gu, (_match, opening: string, href: string, closing: string) => `${opening}${linkTarget(topic, href, topics)}${closing}`);
    const heading = topic.headings.get(index);
    return heading === undefined ? rewritten : `<a id="${anchor(topic.filename, heading.slug)}"></a>\n${"#".repeat(heading.level + 1)} ${heading.title}`;
  }).join("\n");
};

export const assembleManual = (sources: ReadonlyMap<string, Uint8Array>): Uint8Array => {
  const topics = new Map(manualTopicFiles.map((filename) => {
    const contents = sources.get(filename);
    if (contents === undefined) throw new Error(`Missing manual topic: ${filename}`);
    return [filename, parseTopic(filename, contents)] as const;
  }));
  const metadata = "---\nname: daynight\ndescription: Use the Daynight CLI to operate projects, tasks, materials, Sessions, Webhooks and Workers with explicit authorization and write outcomes.\n---\n\n# Daynight CLI Usage";
  const index = [...topics.values()].map((topic) => `- [${topic.title}](#${anchor(topic.filename, topic.root)})`).join("\n");
  const body = [...topics.values()].map((topic) => renderTopic(topic, topics)).join("\n\n");
  return new TextEncoder().encode(`${metadata}\n\n${index}\n\n${body}\n`);
};
