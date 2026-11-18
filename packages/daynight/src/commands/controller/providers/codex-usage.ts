/** The connected App Server supplies its version; PATH probes cannot replace it. */
export const codexUsageProviderVersion = (initialized: unknown): string | null => {
  if (!initialized || typeof initialized !== "object") return null;
  const userAgent = (initialized as Record<string, unknown>).userAgent;
  if (typeof userAgent !== "string") return null;
  const version = /^daynight\/(0\.169\.[01]) \(/.exec(userAgent)?.[1];
  return version ?? null;
};
