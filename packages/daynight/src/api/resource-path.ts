export const resourcePath = (...segments: readonly string[]): string => {
  const pathname = `/${segments.map(encodeURIComponent).join("/")}`;
  // Fetch normalizes encoded dot segments; a property mutation must keep its exact resource target.
  if (new URL(pathname, "https://request.invalid").pathname !== pathname) throw new Error("Property name cannot be represented without changing the request route.");
  return pathname;
};
