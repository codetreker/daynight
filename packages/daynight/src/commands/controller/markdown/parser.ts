import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export type MarkdownSourceNode = { start: number; end: number; destination: string; label: string; linkHref: string | null };
type Node = { type: string; children?: Node[]; identifier?: string; url?: string; alt?: string | null; position?: { start: { offset?: number }; end: { offset?: number } } };
const identifier = (value: string) => value.replace(/[\t\n\r ]+/g, " ").trim().toLowerCase().toUpperCase();
const safeHref = (value: string): string | null => {
  try { const url = new URL(value, "https://daynight.invalid"); return ["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password && !/[\p{Cc}]/u.test(value) && Buffer.byteLength(value) <= 8192 ? value : null; }
  catch { return null; }
};
const label = (value: string): string => {
  let result = "";
  for (const point of value.replace(/[\p{Cc}]/gu, " ")) { if (Buffer.byteLength(result + point) > 1024) break; result += point; }
  return result.trim() || "Image";
};

// The worker owns parser CPU and heap. A failed parse never publishes a prefix
// of the node collection or authorizes any source IO.
const parse = (text: string): MarkdownSourceNode[] => {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text) as Node;
  const definitions = new Map<string, string>(), pending = [tree]; let count = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++count > 100_000) throw new Error("source_unavailable");
    if (node.type === "definition" && node.identifier && node.url !== undefined) {
      const key = identifier(node.identifier); if (!definitions.has(key)) definitions.set(key, node.url);
    }
    if (node.children) pending.push(...node.children.toReversed());
  }
  const result: MarkdownSourceNode[] = [], stack: { node: Node; link: string | null }[] = [{ node: tree, link: null }];
  while (stack.length) {
    const { node, link } = stack.pop()!;
    const destination = node.type === "image" ? node.url : node.type === "imageReference" && node.identifier ? definitions.get(identifier(node.identifier)) : undefined;
    if (destination !== undefined) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start === undefined || end === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) throw new Error("source_unavailable");
      result.push({ start, end, destination, label: label(node.alt ?? ""), linkHref: link });
      if (result.length > 1000) throw new Error("source_unavailable");
    }
    const nextLink = node.type === "link" ? safeHref(node.url ?? "") : node.type === "linkReference" && node.identifier ? safeHref(definitions.get(identifier(node.identifier)) ?? "") : link;
    if (node.children) for (const child of node.children.toReversed()) stack.push({ node: child, link: nextLink });
  }
  return result;
};

if (!isMainThread && workerData?.kind === "daynight-markdown-images") {
  try { parentPort!.postMessage({ nodes: parse(workerData.text) }); }
  catch { parentPort!.postMessage({ error: "source_unavailable" }); }
}

export const parseMarkdownImages = async (text: string): Promise<MarkdownSourceNode[]> => {
  if (!text.isWellFormed() || text.includes("\0") || Buffer.byteLength(text) > 67_108_864) throw new Error("source_unavailable");
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: "daynight-markdown-images", text }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("source_unavailable")), 2000);
      const finish = (error?: Error, nodes?: MarkdownSourceNode[]) => { clearTimeout(timer); error ? reject(new Error("source_unavailable")) : resolve(nodes!); };
      worker.once("message", (value: { error?: string; nodes?: MarkdownSourceNode[] }) => finish(value.error || !value.nodes ? new Error("source_unavailable") : undefined, value.nodes));
      worker.once("error", error => finish(error));
      worker.once("exit", code => { if (code !== 0) finish(new Error("source_unavailable")); });
    });
  } finally { await worker.terminate(); }
};
