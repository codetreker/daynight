import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// Node's source runner does not apply TypeScript's .js-to-.ts resolution. Keep
// this bridge in the process fixture so the crash proof runs production source.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(source)) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { openSessionContent } = await import("../../src/commands/controller/content/session-content.ts");
const { acquireControllerStoragePermit, assertControllerStoragePermit } = await import("../../src/commands/controller/storage-lock.ts");
const { controllerMetadataBudget } = await import("../../src/commands/controller/media/metadata-budget.ts");
const [file, sessionId, encoded, phase] = process.argv.slice(2);
const permit = acquireControllerStoragePermit(file, undefined, { fileMustExist: true });
const db = new Database(file);
db.pragma("synchronous=FULL");
const budget = controllerMetadataBudget(file, db);
const content = openSessionContent(file, sessionId, db, {
  assertWrite(additional) { if (!db.inTransaction) throw new Error("Publication requires the original write transaction."); assertControllerStoragePermit(permit, file); budget.assert(additional, true); },
  read: action => db.inTransaction ? action() : db.transaction(action).deferred(),
});
db.exec("BEGIN IMMEDIATE");
content.timeline.save(JSON.parse(encoded));
db.prepare("UPDATE image_runtime_state SET value='new' WHERE key='publication'").run();
if (phase === "after") db.exec("COMMIT");
process.send(phase);
setInterval(() => {}, 1000);
