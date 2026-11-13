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
