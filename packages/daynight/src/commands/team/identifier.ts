import { canonicalId } from "../../api/validation.js";
import { UsageError } from "../../cli/context.js";

const help = "daynight project transfer --help";

/** Parse a Team UUID or an exact Team page URL for the configured service. */
export const parseTeamIdentifier = (value: string, serverUrl?: string): string => {
  const uuid = canonicalId(value);
  if (uuid === value) return uuid;
  const invalid = (): never => { throw new UsageError("--to-team must be a canonical Team UUID or a same-service Team link.", help); };
  // Check the original spelling before URL parsing, which normalizes paths and empty query/fragment markers.
  const match = /^(https?:\/\/[^\s\\/?#@]+)(\/teams\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$/i.exec(value);
  if (match === null) return invalid();
  let parsed: URL;
  try { parsed = new URL(value); } catch { return invalid(); }
  if (parsed.username !== "" || parsed.password !== "" || parsed.pathname !== match[2] || !match[2]!.startsWith("/teams/") || parsed.search !== "" || parsed.hash !== "" || canonicalId(match[3]!) !== match[3] || serverUrl !== undefined && parsed.origin !== serverUrl) return invalid();
  return match[3]!;
};
