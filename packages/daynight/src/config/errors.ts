export class MissingConfigurationFileError extends Error {
  constructor(readonly configFile: string, cause: unknown) {
    super(`Cannot read configuration file ${configFile}.`, { cause });
    this.name = "MissingConfigurationFileError";
  }
}

export class MissingConfigurationFieldError extends Error {
  constructor(readonly field: "repositories", message: string) {
    super(message);
    this.name = "MissingConfigurationFieldError";
  }
}

export const isMissingConfiguration = (error: unknown, field: MissingConfigurationFieldError["field"]): boolean => {
  if (error instanceof MissingConfigurationFileError) return true;
  if (error instanceof MissingConfigurationFieldError) return error.field === field;
  return error instanceof Error && error.cause !== undefined && isMissingConfiguration(error.cause, field);
};
