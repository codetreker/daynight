import type Database from "better-sqlite3";
import { sessionArchiveReferences } from "../../../session/archive.js";
import { openResourceFiles, type ResourceFiles } from "./resource-files.js";
import { openTimelineStore, type TimelineWriteContext } from "./timeline-store.js";

export type SessionContentContext = TimelineWriteContext & { readonly read: <T>(action: () => T) => T };

/** SQL owns current bodies; resource files retain their original Session-bound locations. */
export const openSessionContent = (journal: string, sessionId: string, db: Database.Database, context: SessionContentContext) => {
  const timeline = openTimelineStore(db, context), files = openResourceFiles(journal, sessionId);
  const assertReferences = (id: string): void => {
    if (!db.inTransaction) throw new Error("Resource reference validation requires the original journal read transaction.");
    files.assertResourceReleasable(id);
    if (db.prepare("SELECT 1 FROM native_input_publication_images WHERE resource_id=? LIMIT 1").get(id) !== undefined) throw new Error("Resource is referenced by session history.");
    let referenced = false;
    timeline.iterate(entry => { if (sessionArchiveReferences([entry], false).resources.has(id)) referenced = true; });
    if (referenced) throw new Error("Resource is referenced by session history.");
  };
  const assertResourceReleasable = (id: string): void => context.read(() => assertReferences(id));
  const releaseResource = (id: string): void => context.read(() => {
    assertReferences(id);
    files.releaseResource(id);
  });
  const resourceFiles: ResourceFiles = { ...files, get resources() { return files.resources; }, assertResourceReleasable, releaseResource };
  return {
    timeline,
    resourceFiles,
    metadataBytes: (): number => timeline.totals().timelineBytes + files.descriptorBytes(),
  };
};
export type SessionContent = ReturnType<typeof openSessionContent>;
