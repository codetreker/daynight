// The server checks decoded path bytes, which need not form valid UTF-8. Decode
// percent escapes as bytes so validation preserves every accepted local target.
function decodePathBytes(path: string): string {
  if (/%(?![0-9a-f]{2})/i.test(path)) throw new URIError("Invalid path escape");
  return path.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// Match Go's path.Clean on the raw redirect path, before browser URL parsing.
function cleanPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function callbackBase(path: string): boolean {
  if (path === "/" || !path.startsWith("/") || path.startsWith("//") || /[?#\\{}\s\x00-\x1f\x7f]/u.test(path) || cleanPath(path) !== path) return false;
  // Escaped aliases are possible in the incoming request. Their decoded bytes
  // must still describe a local path without controls or dot-segment aliases.
  const decoded = decodeURIComponent(path);
  return decoded.startsWith("/") && !decoded.startsWith("//") && !/[\\\s\p{Cc}]/u.test(decoded) && cleanPath(decoded) === decoded;
}

function isCompletionPath(path: string): boolean {
  const normalized = cleanPath(path);
  return normalized === "/auth/complete" || normalized.startsWith("/auth/complete/");
}

// The callback preserves the original target and its request path separately.
// Reconstruct the old server redirect before checking the browser's final URL.
export function parseLoginCompletionTarget(search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  const entries = [...params.entries()];
  if (hash !== "" || entries.length !== 2 || params.getAll("returnPath").length !== 1 || params.getAll("callbackPath").length !== 1) return null;
  const target = params.get("returnPath")!;
  const callback = params.get("callbackPath")!;
  if (new TextEncoder().encode(target).length > 4096 || target.startsWith("//") || /[\\\r\n\0]/.test(target)) return null;
  try {
    if (!callbackBase(callback)) return null;
    const path = target.split(/[?#]/, 1)[0]!;
    const decoded = decodePathBytes(path);
    const twiceDecoded = decodePathBytes(decoded);
    if (!decoded.startsWith("/") || /[\\\r\n\0]/.test(decoded) || decoded.startsWith("//") || /[\\\r\n\0]/.test(twiceDecoded) || twiceDecoded.startsWith("//")) return null;

    const withBase = target.startsWith("/") ? target : callback.slice(0, callback.lastIndexOf("/") + 1) + target;
    const queryIndex = withBase.indexOf("?");
    const pathPart = queryIndex === -1 ? withBase : withBase.slice(0, queryIndex);
    const suffix = queryIndex === -1 ? "" : withBase.slice(queryIndex);
    let destination = cleanPath(pathPart);
    if (pathPart.endsWith("/") && !destination.endsWith("/")) destination += "/";
    destination += suffix;

    const url = new URL(destination, "https://daynight.invalid/auth/complete");
    if (url.origin !== "https://daynight.invalid") return null;
    const browserPath = decodePathBytes(url.pathname);
    if (isCompletionPath(decoded) || isCompletionPath(twiceDecoded) || isCompletionPath(browserPath) || isCompletionPath(decodePathBytes(browserPath))) return null;
    return destination;
  } catch {
    return null;
  }
}
