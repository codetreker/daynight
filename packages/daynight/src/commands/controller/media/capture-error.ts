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

export const isRetryableCaptureRefusal = (error: unknown): boolean =>
  error instanceof ImageCaptureNotDispatchedError || error instanceof ImageCaptureRequestError && error.code === "rate_limited";
