export const validateServerToken = (value: unknown): string => {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error("serverToken must be a nonempty header-safe ASCII value without whitespace or control characters.");
  }
  return value;
};

export const validateTokenTransport = (serverUrl: string): void => {
  const url = new URL(serverUrl);
  if (url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)))) return;
  throw new Error("serverToken requires an HTTPS server origin or loopback HTTP for development.");
};
