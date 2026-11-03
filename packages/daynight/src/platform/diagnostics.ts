import { formatSqliteError, SqliteAccessError } from "./sqlite-error.js";

export const formatError = (error: unknown): string => {
  if (error instanceof SqliteAccessError) return formatSqliteError(error);
  if (!(error instanceof Error)) {
    return String(error);
  }
  const details: string[] = [error.message];
  if (error instanceof AggregateError) {
    for (const child of error.errors) {
      details.push(formatError(child));
    }
  }
  if (error.cause !== undefined) {
    details.push(`Caused by: ${formatError(error.cause)}`);
  }
  return details.join("\n");
};
