import type { CliContext } from "../../cli/context.js";
import { CliCancelledError, withCliCancellation } from "../../cli/cancellation.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { MissingConfigurationFileError, isMissingConfiguration } from "../../config/errors.js";
import { readConfigurationSource, updateConfigurationFile } from "../../config/files.js";
import { remoteIdentity, validateRegistrationConfigurationSource } from "./config.js";
import { resolveReviewPaths } from "./paths.js";
import { updateRepositoryConfiguration } from "./repositories.js";

export const configureReview = async (
  context: CliContext,
  suppliedSignal?: AbortSignal,
): Promise<void> => withCliCancellation(context, async (signal) => {
  try {
    const paths = resolveReviewPaths(context.homeDirectory());
    let source: string | undefined;
    try { source = await readConfigurationSource(paths, signal); }
    catch (cause) { if (!(cause instanceof MissingConfigurationFileError)) throw cause; }
    const baseline = source === undefined ? {} : parseConfigurationDocument(source, paths).mapping;
    const options = { homeDirectory: context.homeDirectory(), workingDirectory: context.workingDirectory() };
    if (source !== undefined) await validateRegistrationConfigurationSource(source, paths);
    const ask = async (question: string): Promise<string> => {
      if (context.prompt?.isInteractive !== true) throw new Error("Interactive review configuration requires terminal input and stderr. Use daynight review add-repo <remote>.");
      signal.throwIfAborted();
      const answer = await context.prompt.ask(question, signal);
      signal.throwIfAborted();
      return answer;
    };
    const retry = async <Value>(question: string, validate: (answer: string) => Value | Promise<Value>): Promise<Value> => {
      for (;;) {
        const answer = await ask(question);
        try { return await validate(answer); }
        catch (cause) {
          signal.throwIfAborted();
          if (cause instanceof CliCancelledError) throw cause;
          context.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        }
      }
    };
    const remote = await retry("Review repository (HTTPS or SSH GitHub address): ", (answer) => { remoteIdentity(answer, "remote"); return answer; });
    const repository = await retry("Review clone path (blank for configured default): ", async (answer) => {
      const candidate = answer === "" ? { remote } : { remote, path: answer };
      await updateRepositoryConfiguration(source, candidate, paths, options);
      return candidate;
    });
    const fingerprint = (mapping: Record<string, unknown>): string => JSON.stringify(
      ["repositoryRoot", "repositories"].map((field) => [field, Object.hasOwn(mapping, field), mapping[field]]),
    );
    signal.throwIfAborted();
    await updateConfigurationFile(paths, async (currentSource) => {
      const current = currentSource === undefined ? {} : parseConfigurationDocument(currentSource, paths).mapping;
      if (fingerprint(current) !== fingerprint(baseline)) {
        throw new Error("Review configuration changed while prompting. Run the review command again to review the current values.");
      }
      return updateRepositoryConfiguration(currentSource, repository, paths, options);
    }, signal);
    context.stderr(`Configuration saved to ${paths.configFile}.\n`);
  } catch (cause) {
    if (signal.aborted || cause instanceof CliCancelledError) {
      throw new CliCancelledError("Review configuration cancelled.", { cause: signal.aborted ? signal.reason : cause });
    }
    throw cause;
  }
}, suppliedSignal, () => new CliCancelledError("Review configuration cancelled."));

export const guideReviewConfiguration = async <Result>(
  context: CliContext,
  load: () => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> => {
  try { return await load(); }
  catch (cause) {
    if (!isMissingConfiguration(cause, "repositories")) throw cause;
    if (context.prompt?.isInteractive !== true) {
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)} Run daynight review add-repo <remote> to configure it.`, { cause: cause instanceof MissingConfigurationFileError ? cause.cause : cause });
    }
    await configureReview(context, signal);
    return load();
  }
};
