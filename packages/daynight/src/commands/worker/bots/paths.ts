import path from "node:path";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import { controllerExecutionDirectory, controllerTicketPath } from "../../controller/launch-ticket.js";
import { botUUID, type BotRecord } from "./types.js";

export const resolveBotPaths = (stateDirectory: string, botId: string) => {
  botUUID(botId, "Bot ID");
  if (botId === "00000000-0000-0000-0000-000000000000") throw new Error("Bot ID must be a nonzero canonical UUID.");
  if (!path.isAbsolute(stateDirectory) || path.resolve(stateDirectory) !== stateDirectory || /[\0\r\n]/.test(stateDirectory)) {
    throw new Error("Bot storage requires a canonical absolute configuration directory.");
  }
  const directory = path.join(stateDirectory, "bots", botId);
  return {
    directory,
    databaseFile: path.join(directory, "store.sqlite"),
    lockFile: path.join(directory, "instance.lock"),
    ownershipGateFile: path.join(directory, "ownership.sqlite"),
    stateDirectory: path.join(directory, "state"),
    controllerStateDirectory: directory,
    codexRecoveryDirectory: path.join(directory, "native", "codex"),
    claudeRecoveryDirectory: path.join(directory, "native", "claude"),
    copilotRecoveryDirectory: path.join(directory, "native", "copilot"),
  };
};

/** Old launch intents retain their original location until explicit migration. */
export const resolveBotControllerStateDirectory = (home: string, record: BotRecord): string | undefined => {
  const intent = record.intent;
  if (intent === null) throw new Error("Bot Controller location requires its durable launch intent.");
  const root = resolveBotPaths(resolveConfigurationPaths(home).stateDirectory, record.botId).controllerStateDirectory;
  const storage = intent.ticketPath === controllerTicketPath(home, intent.launchId, root) ? root : undefined;
  const directory = controllerExecutionDirectory(home, intent.executionId, storage);
  if (intent.ticketPath !== controllerTicketPath(home, intent.launchId, storage)
    || intent.journalPath !== path.join(directory, "journal.sqlite") || intent.credentialFile !== path.join(directory, "credential.json")) {
    throw new Error("Bot private paths differ from its original derived storage location.");
  }
  return storage;
};
