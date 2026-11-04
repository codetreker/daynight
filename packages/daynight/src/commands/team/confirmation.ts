import type { CliContext } from "../../cli/context.js";
import { CliCancelledError } from "../../cli/cancellation.js";
import { terminalText } from "../../platform/terminal.js";

export const requireTeamConfirmation = (context: CliContext, confirmed: boolean): void => {
  if (!confirmed && context.prompt?.isInteractive !== true) throw new Error("This Team change requires interactive confirmation or --confirm.");
};

export const confirmTeamChange = async (context: CliContext, confirmed: boolean, description: string, signal: AbortSignal, deleteName?: string): Promise<void> => {
  if (confirmed) return;
  const prompt = context.prompt!;
  const question = deleteName === undefined
    ? `${description} [y/N]: `
    : `${description}\nEnter this JSON string literal exactly: ${terminalText(JSON.stringify(deleteName))}\n> `;
  let answer: string;
  try { answer = await prompt.ask(question, signal); }
  finally { prompt.close(); }
  signal.throwIfAborted();
  if (deleteName === undefined) {
    if (!/^(?:y|yes)$/i.test(answer)) throw new CliCancelledError("Team change cancelled.");
    return;
  }
  let decoded: unknown;
  try { decoded = JSON.parse(answer); } catch { throw new CliCancelledError("Team deletion cancelled: name did not match."); }
  if (typeof decoded !== "string" || decoded !== deleteName) throw new CliCancelledError("Team deletion cancelled: name did not match.");
};
