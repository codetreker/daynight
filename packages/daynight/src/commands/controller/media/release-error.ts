import { ControllerMetadataBudgetError } from "./metadata-budget.js";

export class ImageReleaseStorageError extends Error {
  constructor(cause: unknown) {
    super("Controller image release storage is temporarily unavailable.", { cause });
    this.name = "ImageReleaseStorageError";
  }
}

export const isImageReleaseStorageFailure = (error: unknown, depth = 0): boolean => {
  if (depth > 6) return false;
  if (error instanceof ControllerMetadataBudgetError) return true;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every((cause: unknown) => isImageReleaseStorageFailure(cause, depth + 1));
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return false;
  return /^(SQLITE_(BUSY|LOCKED|FULL|IOERR|CANTOPEN|PROTOCOL)(_|$)|EPERM$|EACCES$|EROFS$|EINTR$|EBUSY$|EAGAIN$|ENOSPC$|EDQUOT$|EIO$|ENFILE$|EMFILE$|ETIMEDOUT$|ESTALE$|ENOENT$)/.test(error.code);
};
