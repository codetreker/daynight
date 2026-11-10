import { readFile } from "node:fs/promises";
import path from "node:path";
import { withCliCancellation } from "../../cli/cancellation.js";
import { validateManualContents } from "./manual.js";
import type { CliContext } from "../../cli/context.js";

export const runSkillRead = async (context: CliContext): Promise<void> => {
  const filename = path.join(context.packageDirectory, "dist/commands/skill/usage.md");
  await withCliCancellation({}, async (signal) => {
    let contents: Buffer;
    try {
      contents = await readFile(filename);
      validateManualContents(contents);
    } catch (cause) { throw new Error(`Cannot read the installed Daynight CLI usage manual ${filename}. Reinstall the npm package and try again.`, { cause }); }
    signal.throwIfAborted();
    let failure: unknown;
    try { await context.stdoutBytes(contents, signal); }
    catch (cause) { failure = cause; throw cause; }
    finally {
      try { await context.closeStdoutBytes?.(); }
      catch (cause) {
        if (failure !== undefined) throw new AggregateError([failure, cause], "CLI usage output and stdout cleanup failed.", { cause: failure });
        throw cause;
      }
    }
  });
};
