import { inspect } from "node:util";

// Playwright serializes Error messages and causes, but not AggregateError.errors.
export const aggregateFailures = (message: string, failures: unknown[]): AggregateError =>
  new AggregateError(failures, `${message}\n${inspect(failures, { depth: 8, maxStringLength: 1024 * 1024 })}`, { cause: failures[0] });
