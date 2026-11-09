import {
  assertSessionFence,
  sessionFence,
  parseSessionResource,
  type SessionFence,
  type SessionResource,
} from "./protocol.js";
import {
  IMAGE_LIMITS,
  imageId,
  imageObject,
  imageDecimal,
  imageSha,
  parseImageUploadSpec,
  parseImageUploadReceipt,
  parseImageReadChunk,
  parseImageCapabilities,
  parseImageBudget,
  parseImageOccurrenceStatus,
  parseImageCaptureReceipt,
  type ImageUploadSpec,
  type ImageUploadReceipt,
  type ImageCapabilities,
  type ImageBudget,
} from "./image-values.js";
import { decodeStrictSessionJson } from "./v2/values.js";

export const SESSION_CONTENT_HEADER = "Daynight-Session-Content-Revision";
export type ResourceReadScope = {
  readonly serverOrigin: string;
  readonly actorUserId: string;
  readonly fence: SessionFence;
  readonly authorizationGeneration: string;
};
type Options = {
  readonly scope: ResourceReadScope;
  readonly baseUrl: string;
  readonly isCurrent: () => boolean;
  readonly transport: (
    url: string,
    signal: AbortSignal,
    init: RequestInit,
  ) => Promise<Response>;
  readonly onPrincipalMismatch?: () => void;
};
/** One authorized Session transport; caching and draft ownership belong to its consumers. */
export const createSessionResourceClient = (options: Options) => {
  const scope = Object.freeze({ ...options.scope, fence: Object.freeze(sessionFence(options.scope.fence)) });
  options = { ...options, scope };
  const base = new URL(options.baseUrl);
  if (
    base.origin !== options.scope.serverOrigin ||
    base.search ||
    base.hash ||
    base.username ||
    base.password ||
    base.pathname.endsWith("/")
  )
    throw new Error("Invalid Session resource owner.");
  imageId(options.scope.actorUserId);
  imageId(options.scope.fence.sessionId);
  imageDecimal(options.scope.authorizationGeneration, true);
  const lifetime = new AbortController(),
    flights = new Set<Promise<unknown>>();
  const live = (signal: AbortSignal) => {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (!options.isCurrent())
      throw new Error("Session resource authorization has changed.");
  };
  const run = <T>(
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const combined = AbortSignal.any([signal, lifetime.signal]);
    const pending = (async () => {
      live(combined);
      const value = await action(combined);
      live(combined);
      return value;
    })();
    flights.add(pending);
    void pending.finally(() => flights.delete(pending)).catch(() => {});
    return pending;
  };
  const response = async (
    path: string,
    signal: AbortSignal,
    init: RequestInit = {},
  ): Promise<Response> => {
    live(signal);
    const r = await options.transport(base.href + path, signal, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
      headers: {
        Accept: "application/json",
        [SESSION_CONTENT_HEADER]: "2",
        ...init.headers,
      },
    });
    live(signal);
    if (r.headers.get("Daynight-User-ID") !== options.scope.actorUserId) {
      lifetime.abort();
      options.onPrincipalMismatch?.();
      await r.body?.cancel();
      throw new Error("Session resource principal mismatch.");
    }
    return r;
  };
  const json = async <T>(
    path: string,
    signal: AbortSignal,
    parse: (v: unknown) => T,
    init: RequestInit = {},
    statuses: readonly number[] = [200],
  ): Promise<T> => {
    const r = await response(path, signal, init);
    const reader = r.body?.getReader();
    if (!reader) throw new Error("Session resource response is missing.");
    let length = 0;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        live(signal);
        if (done) break;
        length += value.byteLength;
        if (length > 1_048_576)
          throw new Error("Session resource response exceeds its limit.");
        chunks.push(new Uint8Array(value));
      }
      if (!statuses.includes(r.status))
        throw new Error(
          `Session resource request returned HTTP ${r.status}; observe its original identity before another write.`,
        );
      const bytes = new Uint8Array(length);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.length;
      }
      return parse(decodeStrictSessionJson(bytes, 1_048_576));
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  };
  const receipt = (uploadId: string, v: unknown): ImageUploadReceipt => {
    const r = parseImageUploadReceipt(v, parseSessionResource);
    if (
      r.uploadId !== uploadId ||
      r.target.actorUserId !== options.scope.actorUserId ||
      r.target.serverOrigin !== options.scope.serverOrigin
    )
      throw new Error("Session upload identity mismatch.");
    assertSessionFence(r.target.fence, options.scope.fence);
    return r;
  };
  const api = {
    scope: options.scope,
    getOccurrence: (id: string, signal: AbortSignal) => run(signal, s =>
      json(`/image-occurrences/${imageId(id)}`, s, value => {
        const status = parseImageOccurrenceStatus(value);
        if (status.imageId !== id) throw new Error("Session image occurrence mismatch.");
        return status;
      })),
    retryOccurrence: (id: string, signal: AbortSignal) => run(signal, s =>
      json(`/image-occurrences/${imageId(id)}/retry`, s, value => {
        const envelope = imageObject(value, ["capture"]);
        const capture = parseImageCaptureReceipt(envelope.capture, parseSessionResource);
        if (capture.occurrence.imageId !== id) throw new Error("Session image occurrence mismatch.");
        return capture;
      }, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
    capabilities: (signal: AbortSignal) =>
      run(signal, (s) =>
        json("/image-capabilities", s, (v) => {
          const o = imageObject(v, [
            "contentRevision",
            "capabilities",
            "budget",
          ]);
          if (o.contentRevision !== 2)
            throw new Error("Upgrade the Worker to use Session images.");
          return {
            contentRevision: 2 as const,
            capabilities: parseImageCapabilities(o.capabilities),
            budget: parseImageBudget(o.budget),
          };
        }),
      ),
    prepareUpload: (spec: ImageUploadSpec, signal: AbortSignal) =>
      run(signal, (s) => {
        parseImageUploadSpec(spec);
        assertSessionFence(spec.target.fence, options.scope.fence);
        if (
          spec.target.actorUserId !== options.scope.actorUserId ||
          spec.target.serverOrigin !== options.scope.serverOrigin
        )
          throw new Error("Session upload target mismatch.");
        return json(
          `/image-uploads/${imageId(spec.uploadId)}`,
          s,
          (v) => receipt(spec.uploadId, v),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(spec),
          },
          [200, 201],
        );
      }),
    writeUploadChunk: (
      uploadId: string,
      offset: string,
      bytes: Uint8Array<ArrayBuffer>,
      sha256: string,
      signal: AbortSignal,
    ) =>
      run(signal, async (s) => {
        if (bytes.length < 1 || bytes.length > IMAGE_LIMITS.chunkBytes)
          throw new Error("Invalid upload chunk size.");
        imageDecimal(offset, true);
        const actual = hex(await crypto.subtle.digest("SHA-256", bytes));
        if (actual !== sha256) throw new Error("Upload chunk digest mismatch.");
        return json(
          `/image-uploads/${imageId(uploadId)}/chunks?offset=${offset}`,
          s,
          (v) => receipt(uploadId, v),
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "Daynight-Chunk-SHA256": sha256,
            },
            body: bytes,
          },
        );
      }),
    completeUpload: (
      uploadId: string,
      sha256: string,
      byteLength: string,
      signal: AbortSignal,
    ) =>
      run(signal, (s) => {
        imageSha(sha256);
        imageDecimal(byteLength);
        if (BigInt(byteLength) > BigInt(IMAGE_LIMITS.imageBytes)) throw new Error("Invalid image original length.");
        return json(
          `/image-uploads/${imageId(uploadId)}/complete`,
          s,
          (v) => receipt(uploadId, v),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sha256, byteLength }),
          },
          [200, 202],
        );
      }),
    getUpload: (uploadId: string, signal: AbortSignal) =>
      run(signal, (s) =>
        json(`/image-uploads/${imageId(uploadId)}`, s, (v) =>
          receipt(uploadId, v),
        ),
      ),
    releaseUpload: (uploadId: string, signal: AbortSignal) =>
      run(signal, (s) =>
        json(
          `/image-uploads/${imageId(uploadId)}`,
          s,
          (v) => receipt(uploadId, v),
          { method: "DELETE" },
        ),
      ),
    readResource: (
      descriptor: SessionResource,
      signal: AbortSignal,
    ): Promise<Uint8Array<ArrayBuffer>> =>
      run(signal, async (s) => {
        const resource = parseSessionResource(descriptor);
        if (
          resource.status !== "available" ||
          resource.byteLength === null ||
          resource.sha256 === null ||
          BigInt(resource.byteLength) > BigInt(IMAGE_LIMITS.imageBytes) ||
          BigInt(resource.byteLength) < 1n
        )
          throw new Error("Session resource is unavailable.");
        const bytes = new Uint8Array(Number(resource.byteLength));
        let offset = 0;
        while (offset < bytes.length) {
          const chunk = await json(
            `/resources/${imageId(resource.resourceId)}/content?offset=${offset}&limit=${IMAGE_LIMITS.chunkBytes}`,
            s,
            parseImageReadChunk,
          );
          if (
            chunk.resourceId !== resource.resourceId ||
            chunk.sha256 !== resource.sha256 ||
            chunk.byteLength !== resource.byteLength ||
            chunk.offset !== String(offset)
          )
            throw new Error("Session resource chunk identity mismatch.");
          const raw = atob(chunk.data);
          bytes.set(
            Uint8Array.from(raw, (c) => c.charCodeAt(0)),
            offset,
          );
          offset += raw.length;
        }
        live(s);
        if (
          hex(await crypto.subtle.digest("SHA-256", bytes)) !== resource.sha256
        )
          throw new Error("Saved Session resource is corrupt.");
        live(s);
        return bytes;
      }),
    async close(): Promise<void> {
      lifetime.abort();
      await Promise.allSettled([...flights]);
    },
  };
  return api;
};
const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export type SessionResourceClient = ReturnType<
  typeof createSessionResourceClient
>;
export type SessionResourceCapabilities = {
  readonly contentRevision: 2;
  readonly capabilities: ImageCapabilities;
  readonly budget: ImageBudget;
};
