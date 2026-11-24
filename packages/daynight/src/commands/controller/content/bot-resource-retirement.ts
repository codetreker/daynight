import type Database from "better-sqlite3";
import { ResourceRetainedError } from "./resource-files.js";
import type { SessionContent } from "./session-content.js";

/** Record display references released by the same transaction that changes the window. */
export const queueBotResourceRetirement = (db: Database.Database, ids: Iterable<string>): void => {
  if (!db.inTransaction) throw new Error("Bot resource retirement requires the original window transaction.");
  const queue = db.prepare("INSERT INTO bot_resource_retirement(resource_id) VALUES(?) ON CONFLICT(resource_id) DO NOTHING");
  for (const id of ids) queue.run(id);
};

/** Retry filesystem cleanup from committed candidates under the original journal writer. */
export const retireBotResources = (db: Database.Database, content: SessionContent, write: <T>(action: () => T) => T, verifiedReferences?: ReadonlySet<string>): void => {
  if (db.inTransaction) throw new Error("Bot resource retirement requires a committed window transaction.");
  const candidates = db.prepare("SELECT resource_id FROM bot_resource_retirement ORDER BY resource_id").all() as { resource_id: string }[];
  if (candidates.length === 0) return;
  const activeMedia = db.prepare(`
    SELECT 1 FROM image_pins WHERE resource_id=? AND released=0
    UNION ALL
    SELECT 1 FROM image_runtime_state
      WHERE key GLOB 'capture:*' AND json_extract(value,'$.request.locator.kind')='resource'
        AND json_extract(value,'$.request.locator.resourceId')=?
        AND COALESCE(json_extract(value,'$.receipt.state'), 'reserved') NOT IN ('committed','failed')
    LIMIT 1
  `);
  const settled: string[] = [], failures: unknown[] = [];
  for (const { resource_id: id } of candidates) {
    try {
      if (verifiedReferences?.has(id) || activeMedia.get(id, id) !== undefined) continue;
      const files = content.resourceFiles;
      if (files.resources.has(id)) files.releaseResource(id);
      settled.push(id);
    } catch (error) {
      if (!(error instanceof ResourceRetainedError)) failures.push(error);
    }
  }
  if (settled.length !== 0) {
    try {
      // The filesystem inventory retains committed backup ownership across a
      // crash between release and settlement. Confirm cleanup before forgetting it.
      content.resourceFiles.retryCleanup();
      write(() => {
        const forget = db.prepare("DELETE FROM bot_resource_retirement WHERE resource_id=?");
        for (const id of settled) forget.run(id);
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Bot resource retirement could not finish.");
};
