import { createHash } from "node:crypto";
import { canonicalSessionIntent } from "../../../session/image-values.js";
import { parseSessionCommand, type SessionCommand } from "../../../session/protocol.js";

/** Restore only the transport field omitted from the immutable operation intent. */
export const restoreCanonicalInputIntent = (intent: { canonical: string; sha256: string }, operationId: string): SessionCommand => {
  const command = parseSessionCommand({ ...JSON.parse(intent.canonical), requestId: operationId });
  // The local request ID satisfies the wire parser; it is never dispatched and
  // cannot change the operation's canonical bytes or its original identity.
  if (command.operationId !== operationId || canonicalSessionIntent(command) !== intent.canonical || createHash("sha256").update(intent.canonical).digest("hex") !== intent.sha256) throw new Error("Stored input intent differs from its original operation.");
  return command;
};
