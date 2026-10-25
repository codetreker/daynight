import { Document } from "yaml";
import type { CliContext } from "../cli/context.js";
import { CliCancelledError, withCliCancellation } from "../cli/cancellation.js";
import { parseConfigurationDocument } from "./document.js";
import { MissingConfigurationFileError, isMissingConfiguration } from "./errors.js";
import { readConfigurationSource, updateConfigurationFile } from "./files.js";
import { resolveConfigurationPaths } from "./paths.js";
import { configuredServerUrl, normalizeServerUrl } from "./server.js";
import { parseServerTokenInput, validateServerToken, validateTokenTransport } from "./server-token.js";
import type { AddRepositoryInput } from "../commands/review/repositories.js";

export type SetupInput = { serverUrl?: string; serverTokenStdin?: boolean; reviewRepository?: AddRepositoryInput };

const optionalSource = async (context: CliContext, signal: AbortSignal): Promise<string | undefined> => {
  try { return await readConfigurationSource(resolveConfigurationPaths(context.homeDirectory()), signal); }
  catch (cause) { if (cause instanceof MissingConfigurationFileError) return undefined; throw cause; }
};

export const configure = async (
  context: CliContext,
  input?: SetupInput,
  suppliedSignal?: AbortSignal,
): Promise<void> => withCliCancellation(context, async (signal) => {
  if (input?.serverUrl !== undefined) normalizeServerUrl(input.serverUrl);
  const paths = resolveConfigurationPaths(context.homeDirectory());
  const source = await optionalSource(context, signal);
  const baseline = source === undefined ? {} : parseConfigurationDocument(source, paths).mapping;
  const ask = async (question: string): Promise<string> => {
    if (context.prompt?.isInteractive !== true) throw new Error("Interactive review setup requires terminal input and stderr. Use daynight setup --review-repo <remote>.");
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
  try {
    const server = input?.serverUrl !== undefined || input?.serverTokenStdin === true;
    const review = input === undefined || input.reviewRepository !== undefined;
    const serverUrl = server ? input?.serverUrl === undefined ? configuredServerUrl(baseline) : normalizeServerUrl(input.serverUrl) : undefined;
    const sameOrigin = server && serverUrl === configuredServerUrl(baseline);
    let serverToken: string | undefined;
    if (input?.serverTokenStdin === true) {
      validateTokenTransport(serverUrl!);
      if (context.readStdin === undefined) throw new Error("serverToken stdin input is unavailable in this context.");
      serverToken = parseServerTokenInput(await context.readStdin(signal));
      signal.throwIfAborted();
    }
    if (server && serverToken === undefined && sameOrigin && Object.hasOwn(baseline, "serverToken")) {
      validateServerToken(baseline.serverToken);
      validateTokenTransport(serverUrl!);
    }
    let reviewRepository = input?.reviewRepository;
    let reviewTools: typeof import("../commands/review/repositories.js") | undefined;
    let reviewPaths: ReturnType<typeof import("../commands/review/paths.js")["resolveReviewPaths"]> | undefined;
    let reviewOptions: { homeDirectory: string; workingDirectory: string } | undefined;
    if (review) {
      const { validateRegistrationConfigurationSource, remoteIdentity } = await import("../commands/review/config.js");
      reviewTools = await import("../commands/review/repositories.js");
      reviewPaths = (await import("../commands/review/paths.js")).resolveReviewPaths(context.homeDirectory());
      reviewOptions = { homeDirectory: context.homeDirectory(), workingDirectory: context.workingDirectory() };
      if (source !== undefined) await validateRegistrationConfigurationSource(source, reviewPaths);
      if (reviewRepository === undefined) {
        const remote = await retry("Review repository (HTTPS or SSH GitHub address): ", (answer) => { remoteIdentity(answer, "remote"); return answer; });
        reviewRepository = await retry("Review clone path (blank for configured default): ", async (answer) => {
          const candidate = answer === "" ? { remote } : { remote, path: answer };
          await reviewTools!.updateRepositoryConfiguration(source, candidate, reviewPaths!, reviewOptions!);
          return candidate;
        });
      }
      await reviewTools.updateRepositoryConfiguration(source, reviewRepository, reviewPaths, reviewOptions);
    }
    const selectedFields = [...(server ? ["serverUrl", "serverToken"] : []), ...(review ? ["repositoryRoot", "repositories"] : [])];
    const fingerprint = (mapping: Record<string, unknown>): string => JSON.stringify(selectedFields.map((field) => [field, Object.hasOwn(mapping, field), mapping[field]]));
    signal.throwIfAborted();
    await updateConfigurationFile(paths, async (currentSource) => {
      const current = currentSource === undefined ? undefined : parseConfigurationDocument(currentSource, paths);
      if (fingerprint(current?.mapping ?? {}) !== fingerprint(baseline)) throw new Error("Configuration changed during setup. Run setup again to review the current values.");
      const document = current?.document ?? new Document({});
      if (server) {
        if (input?.serverUrl !== undefined) document.set("serverUrl", serverUrl);
        if (serverToken !== undefined) document.set("serverToken", serverToken);
        else if (!sameOrigin) document.delete("serverToken");
      }
      let updatedSource = document.toString();
      if (reviewRepository !== undefined) {
        const result = await reviewTools!.updateRepositoryConfiguration(updatedSource, reviewRepository, reviewPaths!, reviewOptions!);
        if (result.source !== undefined) updatedSource = result.source;
      }
      return { result: undefined, source: updatedSource };
    }, signal);
    context.stderr(`Configuration saved to ${paths.configFile}.\n`);
  } catch (cause) {
    if (signal.aborted || cause instanceof CliCancelledError) throw new CliCancelledError("Setup cancelled.", { cause: signal.aborted ? signal.reason : cause });
    throw cause;
  }
}, suppliedSignal, () => new CliCancelledError("Setup cancelled."));

export const guideReviewConfiguration = async <Result>(
  context: CliContext,
  load: () => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> => {
  try { return await load(); }
  catch (cause) {
    if (!isMissingConfiguration(cause, "repositories")) throw cause;
    if (context.prompt?.isInteractive !== true) {
      const command = "daynight setup --review-repo <remote>";
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)} Run ${command} to configure it.`, { cause: cause instanceof MissingConfigurationFileError ? cause.cause : cause });
    }
    await configure(context, undefined, signal);
    return load();
  }
};
