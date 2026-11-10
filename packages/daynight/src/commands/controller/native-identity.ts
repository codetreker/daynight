import { createHash } from "node:crypto";

// Native item IDs survive reconnects; transport IDs must never create new timeline rows.
export const nativeEntryId = (session: string, item: string): string => {
  const h = createHash("sha256").update(session).update("\0").update(item).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
