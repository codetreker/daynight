export type SqliteErrorKind = "unsupported-version" | "invalid-format" | "upgrade-blocked" | "migration-failed" | "cleanup-failed";
export type SqliteOutcome = "not-started" | "committed" | "rolled-back" | "unknown";
export type SqliteErrorContext = {
  database: string;
  phase: string;
  file?: string;
  fromVersion?: number;
  toVersion?: number;
  stepVersion?: number;
};

export class SqliteAccessError extends Error {
  readonly kind: SqliteErrorKind;
  readonly context: SqliteErrorContext;
  readonly outcome: SqliteOutcome;
  readonly connectionClosed: boolean;
  constructor(kind: SqliteErrorKind, context: SqliteErrorContext, options: { cause?: unknown; outcome?: SqliteOutcome; connectionClosed?: boolean } = {}) {
    const versions = context.fromVersion === undefined ? "" : ` from version ${context.fromVersion}${context.toVersion === undefined ? "" : ` to ${context.toVersion}`}`;
    super(`SQLite ${context.database} ${context.phase}${versions}: ${kind}.`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SqliteAccessError";
    this.kind = kind;
    this.context = context;
    this.outcome = options.outcome === undefined ? "not-started" : options.outcome;
    this.connectionClosed = options.connectionClosed === true;
  }
}

const safeCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return undefined;
  return /^(SQLITE_[A-Z_]+|E[A-Z0-9]+)$/.test(error.code) ? error.code : undefined;
};

export type SafeSqliteError = {
  name: string;
  kind?: SqliteErrorKind;
  message?: string;
  database?: string;
  file?: string;
  phase?: string;
  fromVersion?: number;
  toVersion?: number;
  stepVersion?: number;
  outcome?: SqliteOutcome;
  sqliteCode?: string;
  cause?: SafeSqliteError;
  errors?: SafeSqliteError[];
};

/** Raw parser and SQLite messages can contain stored values; retain them only in memory. */
export const serializeSqliteError = (error: unknown, depth = 0): SafeSqliteError => {
  const code = safeCode(error);
  const base: SafeSqliteError = { name: error instanceof Error ? error.name : "UnknownError", ...(code === undefined ? {} : { sqliteCode: code }) };
  if (error instanceof SqliteAccessError) Object.assign(base, { kind: error.kind, message: error.message, ...error.context, outcome: error.outcome });
  if (depth < 6 && error instanceof Error) {
    if (error.cause !== undefined) base.cause = serializeSqliteError(error.cause, depth + 1);
    if (error instanceof AggregateError) base.errors = error.errors.map((item: unknown) => serializeSqliteError(item, depth + 1));
  }
  return base;
};

export const formatSqliteError = (error: SqliteAccessError): string => JSON.stringify(serializeSqliteError(error));
