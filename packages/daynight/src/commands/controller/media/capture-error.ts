import type { ImageError } from "../../../session/image-values.js";

/** A correlated service refusal, distinct from a lost or uncertain response. */
export class ImageCaptureRequestError extends Error {
  readonly code: string;

  constructor(error: ImageError) {
    super(error.message);
    this.name = "ImageCaptureRequestError";
    this.code = error.code;
  }
}

/** Local admission refused a request before any frame was sent. */
export class ImageCaptureNotDispatchedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageCaptureNotDispatchedError";
  }
}

/** A prerequisite definitively failed before the capture request was sent. */
export class ImageCapturePrerequisiteError extends Error {
  readonly code: string;

  constructor(error: ImageError) {
    super(error.message);
    this.name = "ImageCapturePrerequisiteError";
    this.code = error.code;
  }
}

/** The retry attempt already has this exact durable service failure. */
export class ImageCaptureRetrySettledError extends Error {
  constructor(readonly imageError: ImageError) { super(imageError.message); this.name = "ImageCaptureRetrySettledError"; }
}

/** A retry submission may have committed; only the original receipt can resolve it. */
export class ImageCaptureRetryUnknownError extends Error {
  constructor(cause: unknown) {
    const raw = cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    const classification = typeof raw === "string" && /^(?:SQLITE_[A-Z_]+|EIO|ENOSPC|EACCES|EPERM)$/.test(raw) ? raw : cause instanceof SyntaxError ? "invalid_json" : "unclassified";
    super(`Image capture retry result is unknown (${classification}).`, { cause }); this.name = "ImageCaptureRetryUnknownError";
  }
}

export const isRetryableCaptureRefusal = (error: unknown): boolean =>
  error instanceof ImageCaptureNotDispatchedError || error instanceof ImageCaptureRequestError && error.code === "rate_limited";
