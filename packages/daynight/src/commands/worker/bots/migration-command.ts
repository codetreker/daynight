import type { CliContext } from "../../../cli/context.js";
import { UsageError } from "../../../cli/context.js";
import { parseConfigurationDocument } from "../../../config/document.js";
import { readConfigurationSource } from "../../../config/files.js";
import { acquireInstanceLockSync } from "../../../platform/instance-lock.js";
import { runServerCommand } from "../../server/runtime.js";
import { resolveWorkerPaths } from "../paths.js";
import { botUUID, parseBotOwner } from "./types.js";
import { migrateLegacyBot, readMigratedBotHistory } from "./migration.js";

export const runWorkerBotMigration = async (request: { botId: string; kind: "migrate" | "history"; confirmed: boolean }, context: CliContext): Promise<void> => {
  if (request.kind === "migrate" && !request.confirmed) throw new UsageError("Stop the original Worker and Bot execution, then supply --confirm to migrate this Bot's local storage.", "daynight worker migrate-bot --help");
  await runServerCommand(context, async ({ api, operation, serverUrl }) => {
    const user = await api.getCurrentUser(), paths = resolveWorkerPaths(context.homeDirectory());
    const configuration = parseConfigurationDocument(await readConfigurationSource(paths, operation.signal), paths);
    const owner = parseBotOwner({ serverOrigin: serverUrl, ownerUserId: user.id, workerId: botUUID(configuration.mapping.workerId, "Original local Worker ID") });
    const options = { homeDirectory: context.homeDirectory(), stateDirectory: paths.stateDirectory, legacyDatabaseFile: paths.databaseFile, owner, botId: request.botId, signal: operation.signal };
    if (request.kind === "history") {
      const { manifest, snapshot, entries } = readMigratedBotHistory(options);
      return JSON.stringify({ botId: manifest.botId, registration: manifest.registration, nativeRecovery: manifest.nativeRecovery,
        sessionId: snapshot?.sessionId ?? null, nativeSessionId: snapshot?.nativeSessionId ?? null, entries });
    }
    const lock = acquireInstanceLockSync(paths.lockFile, paths.databaseFile, undefined, { fileMustExist: true });
    let committed = false;
    try {
      const result = await migrateLegacyBot(options); committed = true;
      return { kind: "confirmed-mutation" as const, output: `${JSON.stringify({ botId: result.botId, phase: result.phase, registration: result.registration, nativeRecovery: result.nativeRecovery })}\n`,
        failureText: () => "Bot storage migration committed. Local output failed; inspect this original Bot's migration before taking another action." };
    } finally {
      try { lock.release(); }
      catch (cause) { throw new Error(committed ? "Bot storage migration committed, but releasing the original Worker lock failed. Preserve the lock and inspect the original migration receipt." : "Bot migration Worker lock release failed; inspect the original migration before continuing.", { cause }); }
    }
  }, { operationLimits: { totalMs: 120_000 } });
};
