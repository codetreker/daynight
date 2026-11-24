import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { parseSourceEvent, type SourceEvent } from "../../session/controller-protocol.js";
import { sessionDisplayEntry } from "./wire-display.js";

export class UnprovenSourceWireError extends Error {}
const prefix = "source_wire:";
const key = (sequence: string): string => `${prefix}${sequence}`;
const hash = (event: SourceEvent): string => createHash("sha256").update(JSON.stringify(event)).digest("hex");

/** Freeze a differing live projection before it can be sent. */
export const sourceWireEvent = (db: Database.Database, source: SourceEvent, live: boolean | null): SourceEvent => {
  const projected = source.kind === "timeline_upsert" ? { ...source, payload: sessionDisplayEntry(source.payload) } : source;
  parseSourceEvent(projected);
  const saved = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key(source.sourceSeq)) as { value: string } | undefined;
  if (saved) {
    const record = JSON.parse(saved.value) as { sourceHash: string; event: SourceEvent };
    if (record.sourceHash !== hash(source) || JSON.stringify(record.event) !== JSON.stringify(source) && JSON.stringify(record.event) !== JSON.stringify(projected)) throw new Error("Durable source wire representation differs from its original event.");
    parseSourceEvent(record.event);
    return record.event;
  }
  if (JSON.stringify(projected) === JSON.stringify(source)) { parseSourceEvent(source); return source; }
  const tracking = db.prepare("SELECT value FROM image_runtime_state WHERE key='source_wire_tracking'").get() as { value: string } | undefined;
  if (!tracking || !/^(0|[1-9][0-9]{0,18})$/.test(tracking.value) || BigInt(tracking.value) > 9223372036854775807n || BigInt(tracking.value) >= BigInt(source.sourceSeq)) throw new UnprovenSourceWireError("The original source wire projection cannot be proven.");
  if (live === null) { parseSourceEvent(source); return source; }
  const event = live ? projected : source;
  parseSourceEvent(event);
  const value = JSON.stringify({ sourceHash: hash(source), event });
  if (Buffer.byteLength(value) > 2_097_152) throw new Error("The source wire record exceeds its storage budget.");
  db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(key(source.sourceSeq), value);
  return event;
};

export const clearSourceWireThrough = (db: Database.Database, sequence: bigint): void => {
  db.prepare("DELETE FROM image_runtime_state WHERE key GLOB 'source_wire:[0-9]*' AND CAST(substr(key,13) AS INTEGER)<=?").run(sequence);
};
export const clearSourceWire = (db: Database.Database): void => { db.prepare("DELETE FROM image_runtime_state WHERE key GLOB 'source_wire:[0-9]*'").run(); };
