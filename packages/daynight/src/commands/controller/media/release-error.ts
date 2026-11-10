export class ImageReleaseStorageError extends Error {
  constructor(cause: unknown) {
    super("Controller image release storage is temporarily unavailable.", { cause });
    this.name = "ImageReleaseStorageError";
  }
}
