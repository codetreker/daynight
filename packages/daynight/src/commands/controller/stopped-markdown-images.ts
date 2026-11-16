import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyLocalImage, createLocalImageContext, LocalImageSourceError, parseLocalImagePath } from "./markdown/local-source.js";
import type { MarkdownProjectedOccurrence } from "./markdown/projection.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import { bundledImageDecoder } from "./media/image-decoder.js";
import { parseSessionResource, type SessionResource } from "../../session/protocol.js";
import type { ImagePart } from "../../session/image-values.js";

/** The explicit stopped-repair command grants local reads; it never restores a native Agent Read grant. */
export const resolveStoppedMarkdownImage = async (source: MarkdownProjectedOccurrence, context: {
  ticket: ControllerLaunchTicket; root: { dev: string; ino: string } | null; journalPath: string; signal?: AbortSignal;
}): Promise<{ part: ImagePart; resource: SessionResource; bytes: Uint8Array }> => {
  const { ticket, root, signal } = context;
  signal?.throwIfAborted();
  if (!root) throw new LocalImageSourceError("context_unavailable");
  const checkRoot = async (): Promise<void> => {
    signal?.throwIfAborted();
    const current = await stat(ticket.cwd, { bigint: true });
    if (!current.isDirectory() || String(current.dev) !== root.dev || String(current.ino) !== root.ino) throw new LocalImageSourceError("source_changed");
  };
  await checkRoot();
  const locator = parseLocalImagePath(source.destination, process.platform);
  const relative = path.relative(ticket.cwd, path.resolve(ticket.cwd, locator));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new LocalImageSourceError("source_forbidden");
  const directory = await mkdtemp(path.join(path.dirname(context.journalPath), "markdown-repair-image-"));
  let local: Awaited<ReturnType<typeof createLocalImageContext>> | undefined;
  try {
    await writeFile(path.join(directory, "original"), "", { flag: "wx", mode: 0o600 });
    local = await createLocalImageContext({ cwd: ticket.cwd, policyRevision: `stopped-repair:${ticket.executionId}`, nativeReadAllowed: undefined, stoppedRepairAuthorized: true, expectedRoot: root });
    const original = await copyLocalImage({ path: source.destination, context: local, outputPath: path.join(directory, "original"), ...(signal ? { signal } : {}), checkPolicy: async checkpoint => {
      await checkRoot();
      // Repair does not inherit authority through symlink or reparse targets.
      if (checkpoint.proof.traversal.some(step => step.kind === "link")) throw new LocalImageSourceError("source_forbidden");
    } });
    const validated = await bundledImageDecoder()({ version: 1, policy: "image-validation-v1", inputPath: original.inputPath, expectedByteLength: String(original.byteLength), expectedSha256: original.sha256 }, signal);
    await checkRoot();
    const bytes = await readFile(original.inputPath);
    if (String(bytes.length) !== validated.byteLength || createHash("sha256").update(bytes).digest("hex") !== validated.sha256) throw new LocalImageSourceError("source_changed");
    const resource = parseSessionResource({ resourceId: source.occurrence.imageId, status: "available", name: "Recovered Markdown image", mediaType: validated.mediaType, byteLength: validated.byteLength, sha256: validated.sha256, error: null });
    return { part: { type: "image", imageId: source.occurrence.imageId, resourceId: resource.resourceId, label: source.part.label }, resource, bytes };
  } finally {
    try { await local?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
};
