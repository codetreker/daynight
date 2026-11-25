import type Database from "better-sqlite3";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { controllerPayloadHash, isBotHistoryTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { parseNativeInitialization } from "./native-initialization.js";

export type BotInitializationRetryEvidence = {
  readonly version: 1;
  readonly kind: "native_initialization_not_dispatched" | "legacy_codex_version_gate";
  readonly ticketHash: string;
  readonly snapshotHash: string;
};

export const LEGACY_CODEX_INITIALIZATION_GATE = "recovery_version_unsupported: Codex recovery requires the verified 0.169.0 runtime.";

const emptyRecoveryDirectory = (directory: string): boolean => {
  let current = directory;
  for (;;) {
    try {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(current) !== current
        || process.platform !== "win32" && (metadata.mode & 0o077) !== 0 && current === directory) return false;
      return current !== directory || readdirSync(directory).length === 0;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
};

/** Reads the caller's existing journal transaction; missing material never creates evidence. */
export const inspectBotInitializationRetryEvidence = (db: Database.Database, ticket: ControllerLaunchTicket, stopped: ControllerSnapshot): BotInitializationRetryEvidence | null => {
  if (!isBotHistoryTicket(ticket) || ticket.provider !== "codex" || ticket.initialInput !== "none" || ticket.resumeNativeSessionId !== null
    || stopped.lifecycle !== "stopped" || !stopped.nativeStopped || stopped.stoppedAt === null || stopped.controllerProcess === null
    || stopped.nativeSessionId !== null || stopped.initialInputState !== "not_required") return null;
  const evidence = (kind: BotInitializationRetryEvidence["kind"]): BotInitializationRetryEvidence => ({ version: 1, kind, ticketHash: controllerPayloadHash(ticket), snapshotHash: controllerPayloadHash(stopped) });
  if (stopped.nativeInitialization !== undefined) return parseNativeInitialization(stopped.nativeInitialization).state === "not_dispatched" ? evidence("native_initialization_not_dispatched") : null;
  // In this shipped profile, the same immutable runtime version passes prepare
  // before every protect call. Its exact local gate cannot first fail in protect.
  // RPC rejection carries native_rejected, while native error notifications own
  // timeline entries. The complete journal below excludes an earlier error or
  // projection failure that could otherwise retain a different startup category.
  if (ticket.executionGeneration !== "1" || ticket.codexBotRecovery === undefined
    || ticket.codexBotRecovery.botId !== (ticket.botId ?? ticket.codexBotRecovery.botId)
    || stopped.startup?.state !== "unknown" || stopped.startup.reasonCode !== "native_transport_unknown"
    || stopped.error !== LEGACY_CODEX_INITIALIZATION_GATE || stopped.nativeProcesses.length !== 1
    || stopped.currentTurnId !== null || Object.values(stopped.capabilities).some(Boolean)) return null;
  const history = db.prepare("SELECT history_content_policy,projection_gap,archive_incomplete,last_sequence,last_acknowledged FROM execution WHERE id=1").get() as {
    history_content_policy: string; projection_gap: string | null; archive_incomplete: number; last_sequence: number; last_acknowledged: number;
  } | undefined;
  if (history === undefined || history.history_content_policy !== "legacy" || history.projection_gap !== null || history.archive_incomplete !== 0
    || history.last_sequence !== history.last_acknowledged) return null;
  for (const table of ["operations", "input_intents", "input_observations", "input_message_origins", "native_input_publications", "timeline_entries", "online_entries", "image_occurrences", "image_captures", "usage_sources", "outbox"]) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined) return null;
  }
  for (const row of db.prepare("SELECT ticket_hash,snapshot FROM stopped_generations").all() as { ticket_hash: string; snapshot: string }[]) {
    if (row.ticket_hash !== controllerPayloadHash(ticket) || controllerPayloadHash(JSON.parse(row.snapshot)) !== controllerPayloadHash(stopped)) return null;
  }
  if (!emptyRecoveryDirectory(ticket.codexBotRecovery.directory)) return null;
  return evidence("legacy_codex_version_gate");
};
