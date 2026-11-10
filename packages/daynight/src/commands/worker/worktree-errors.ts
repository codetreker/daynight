// Only stable, resource-local metadata failures can be isolated. Conflicting
// observations, read failures and native-query failures retain unknown coverage.
export class WorktreeValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorktreeValidationError";
  }
}
