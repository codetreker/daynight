// The MCP SDK consumed by Claude uses the standard fetch initializer name;
// Node exposes Headers at runtime but does not declare this global alias.
type HeadersInit = Headers | Record<string, string> | [string, string][];
