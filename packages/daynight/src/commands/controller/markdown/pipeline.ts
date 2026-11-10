import type { ImageCaptureReceipt, ImageCaptureRequest, ImageError, ImageOccurrence, ImagePart, ImageUnavailablePart } from "../../../session/image-values.js";
import { parseSourceEvent } from "../../../session/controller-protocol.js";
import type { MarkdownTimelineMetadata, ProviderEntry } from "../providers/types.js";
import type { MarkdownSourceStoreKind } from "./store.js";
import { createMarkdownImageProjector, type MarkdownProjectedOccurrence, type MarkdownProjectionMetadata, type MarkdownProjectionPartInput, type MarkdownProjectionState } from "./projection.js";

type ProjectionStore = {
  get<T>(kind: MarkdownSourceStoreKind, id: string): T | null;
  put(kind: MarkdownSourceStoreKind, id: string, value: unknown): void;
  listIds(kind: MarkdownSourceStoreKind, page: { after?: string; limit: number }): string[];
};
type Journal = { markdownStore: ProjectionStore; projectTimeline(entry: ProviderEntry): unknown; markProjectionGap?(reason: string): void };
type CaptureHooks<Context> = {
  contextKey(): string;
  contextFor(occurrence: ImageOccurrence): Context;
  enqueue(occurrence: ImageOccurrence, destination: string, context: Context): void;
  get(imageId: string): unknown;
};
export type MarkdownPipelineMetadata = MarkdownTimelineMetadata & { readonly parts?: readonly Omit<MarkdownProjectionPartInput, "contextKey">[] };
const imageFailure = (code: string): ImageError => ({ code, message: "The original image source could not be captured." });
const sources = (state: MarkdownProjectionState): readonly MarkdownProjectedOccurrence[] => state.parts.flatMap(part => [...part.current, ...part.retained]);

/** Entry/state publication is synchronous; one separately bounded parser owns asynchronous work. */
export function createMarkdownTimelinePipeline<Context>(options: {
  journal: Journal;
  captures: CaptureHooks<Context>;
  onError(error: Error): void;
  projector?: ReturnType<typeof createMarkdownImageProjector>;
}) {
  const { journal, captures } = options, store = journal.markdownStore, projector = options.projector ?? createMarkdownImageProjector();
  let stopped = false, broken = false, scanComplete = false, cursor: string | undefined, active: Promise<void> | null = null;
  const get = (entryId: string) => store.get<MarkdownProjectionState>("projection", entryId);
  const report = (): void => {
    broken = true;
    try { journal.markProjectionGap?.("Markdown timeline persistence is incomplete."); } catch { /* The owning runtime also receives the durable failure. */ }
    options.onError(new Error("Markdown timeline persistence is incomplete."));
  };
  const publish = (state: MarkdownProjectionState, entry: ProviderEntry): void => {
    store.put("projection", state.entryId, state);
    journal.projectTimeline(entry);
  };
  const update = (occurrence: ImageOccurrence, part: ImagePart | ImageUnavailablePart): void => {
    const state = get(occurrence.entryId); if (!state) return;
    const source = sources(state).find(value => value.occurrence.imageId === occurrence.imageId);
    if (!source || JSON.stringify(source.part) === JSON.stringify(part)) return;
    const result = projector.updateImagePart(state, occurrence.imageId, part);
    publish(result.state, result.entry);
    if (result.state.pending) { scanComplete = false; cursor = undefined; }
  };
  const failure = (occurrence: ImageOccurrence, error: ImageError): void => {
    try {
      const state = get(occurrence.entryId), source = state && sources(state).find(value => value.occurrence.imageId === occurrence.imageId);
      if (!source) return;
      update(occurrence, { type: "image_unavailable", imageId: occurrence.imageId, label: source.part.label, error });
    } catch { report(); }
  };
  const replay = (state: MarkdownProjectionState): void => {
    if (stopped) return;
    for (const source of sources(state)) {
      if (captures.get(source.occurrence.imageId) || source.part.type === "image") continue;
      if (["context_unavailable", "policy_restricted", "source_forbidden"].includes(source.part.error.code)) continue;
      try {
        if (source.contextKey !== captures.contextKey()) { failure(source.occurrence, imageFailure("context_unavailable")); continue; }
        const context = captures.contextFor(source.occurrence);
        captures.enqueue(source.occurrence, source.destination, context);
      } catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "source_unavailable";
        failure(source.occurrence, imageFailure(["context_unavailable", "policy_restricted", "source_forbidden"].includes(code) ? code : "source_unavailable"));
      }
    }
  };
  const accept = (entry: ProviderEntry, metadata?: MarkdownPipelineMetadata): boolean => {
    if (stopped || broken) return false;
    // Authoritative identities and interactions keep the existing fatal protocol
    // failure; they are not Markdown parse failures or private cache identities.
    parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload: entry });
    try {
      const previous = get(entry.entryId);
      if (!previous && (!metadata || metadata.format !== "markdown")) { journal.projectTimeline(entry); return true; }
      const body = entry.kind === "user_message" || entry.kind === "assistant_message" ? entry.content : entry.kind === "tool_call" ? entry.output : entry.kind === "reasoning" ? [{ type: "text" as const, text: entry.text }] : [];
      const texts = body.flatMap((part, inputIndex) => part.type === "text" ? [{ inputIndex }] : []), contextKey = captures.contextKey();
      let meta: MarkdownProjectionMetadata, ambiguous = false;
      if (metadata?.parts) meta = { parts: metadata.parts.map(part => ({ ...part, contextKey })) };
      else if (texts.length === 1) meta = { parts: [{ inputIndex: texts[0]!.inputIndex, sourceKey: `${entry.entryId}:body`, complete: metadata?.complete ?? false, truncated: metadata?.truncated ?? false, format: metadata?.format ?? "markdown", contextKey }] };
      else if (texts.length === 0) meta = { parts: [] };
      else if (metadata?.format === "plain") meta = { parts: [] };
      else {
        ambiguous = true;
        // This stable entry-owned failure container never authorizes a source or guesses block identities.
        meta = { parts: [{ inputIndex: texts[0]!.inputIndex, sourceKey: `${entry.entryId}:projection-unavailable`, complete: true, truncated: false, format: "markdown", contextKey }] };
      }
      const prepared = projector.prepare(entry, meta, previous), ready = ambiguous ? projector.markFailed(prepared.state) : prepared;
      publish(ready.state, ready.entry); scanComplete = false; cursor = undefined;
      return true;
    } catch { report(); return false; }
  };
  const tick = async (): Promise<void> => {
    if (stopped || broken || scanComplete) return;
    if (active) return active;
    try {
      const ids = store.listIds("projection", { ...(cursor ? { after: cursor } : {}), limit: 32 });
      for (const id of ids) {
        cursor = id; const state = get(id); if (!state) continue;
        if (!state.pending) { journal.projectTimeline(projector.view(state).entry); replay(state); continue; }
        active = Promise.resolve().then(async () => {
          const parsed = await projector.complete(state), latest = get(id);
          if (!latest || latest.token !== parsed.token) return;
          publish(parsed.state, parsed.entry);
          if (!stopped) replay(parsed.state);
        }).catch(() => { report(); }).finally(() => { active = null; });
        await active; return;
      }
      if (ids.length < 32) { cursor = undefined; scanComplete = true; }
    } catch { report(); }
  };
  const hasPending = (): boolean => active !== null || !scanComplete;
  const drain = async (): Promise<void> => {
    while (!stopped && hasPending()) { if (broken) throw new Error("Markdown timeline persistence is incomplete."); await tick(); }
    if (active) await active;
    if (broken) throw new Error("Markdown timeline persistence is incomplete.");
  };
  const receipt = (request: ImageCaptureRequest, value: ImageCaptureReceipt): void => {
    if (request.occurrence.imageId !== value.occurrence.imageId || request.captureId !== value.captureId) { report(); return; }
    try {
      const state = get(request.occurrence.entryId), source = state && sources(state).find(item => item.occurrence.imageId === request.occurrence.imageId);
      if (!source) return;
      if (value.state === "committed" && value.resource?.status === "available") update(request.occurrence, { type: "image", imageId: request.occurrence.imageId, resourceId: value.resource.resourceId, label: source.part.label });
      else if (value.state === "failed") failure(request.occurrence, value.error ?? imageFailure("source_unavailable"));
      // Reserved/copying/unknown do not invent an available resource or a descriptor.
    } catch { report(); }
  };
  return { accept, tick, drain, hasPending, receipt, failure,
    async stop(): Promise<void> {
      stopped = true; if (active) await active;
      if (broken) throw new Error("Markdown timeline persistence is incomplete.");
      let after: string | undefined;
      for (;;) {
        const ids = store.listIds("projection", { ...(after ? { after } : {}), limit: 32 });
        for (const id of ids) {
          const state = get(id); if (!state) continue;
          let finished = state.pending ? await projector.complete(state) : null;
          const current = finished?.state ?? state;
          if (current.parts.some(part => part.status === "streaming" || part.status === "pending")) {
            const failed = projector.markFailed(current); finished = { ...failed, token: state.token };
          }
          if (finished && get(id)?.token === state.token) publish(finished.state, finished.entry);
        }
        if (ids.length < 32) break;
        after = ids.at(-1);
      }
      scanComplete = true;
    },
  };
}
