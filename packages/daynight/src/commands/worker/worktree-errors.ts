// Only failures established from observed worktree metadata can be isolated.
// Read, native-query and other observation failures must retain unknown coverage.
export class WorktreeValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorktreeValidationError";
  }
}
