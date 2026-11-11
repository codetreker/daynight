/** Parse the completion page's single return target without changing its query or fragment. */
export function parseLoginCompletionTarget(search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  const entries = [...params.entries()];
  if (hash !== "" || entries.length !== 1 || entries[0]![0] !== "returnPath") return null;
  const target = entries[0]![1];
  if (new TextEncoder().encode(target).length > 4096 || !target.startsWith("/") || target.startsWith("//") || /[\\\r\n\0]/.test(target)) return null;
  try {
    const path = target.split(/[?#]/, 1)[0]!;
    const decoded = decodeURIComponent(path);
    if (/[\\\r\n\0]/.test(decoded) || decoded.startsWith("//")) return null;
    const url = new URL(target, "https://daynight.invalid");
    if (url.origin !== "https://daynight.invalid") return null;
    // Check both the decoded path and the browser-normalized path. The server
    // also cleans repeated separators, while the browser resolves dot segments.
    const loops = (path: string) => {
      const segments: string[] = [];
      for (const segment of path.slice(1).split("/")) {
        if (segment === "..") segments.pop();
        else if (segment !== "" && segment !== ".") segments.push(segment);
      }
      const normalized = `/${segments.join("/")}`;
      return normalized === "/auth/complete" || normalized.startsWith("/auth/complete/");
    };
    if (loops(decoded) || loops(decodeURIComponent(url.pathname))) return null;
    return target;
  } catch {
    return null;
  }
}
