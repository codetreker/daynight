import { withCliCancellation } from "../../cli/cancellation.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { captureInstalledSkill } from "./bundle.js";

const validateResource = (resource: string): void => {
  if (!resource.endsWith(".md") || resource.startsWith("/") || /[:\\\u0000-\u001f\u007f]/u.test(resource)
    || resource.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new UsageError("Skill resource must be a relative Markdown path with slash-separated names, such as references/handbook.md.");
  }
};

export const runSkillRead = async (resource: string | undefined, context: CliContext): Promise<void> => {
  const filename = resource === undefined ? "SKILL.md" : resource;
  validateResource(filename);
  await withCliCancellation({}, async (signal) => {
    const bundle = await captureInstalledSkill(context.packageDirectory);
    signal.throwIfAborted();
    const entry = bundle.find((candidate) => candidate.relativePath === filename);
    if (entry?.type !== "file") throw new UsageError(`Unknown using-daynight skill resource ${JSON.stringify(filename)}. Read daynight --skill for the available references.`);
    try { new TextDecoder("utf-8", { fatal: true }).decode(entry.contents); }
    catch (cause) { throw new Error(`The using-daynight skill resource ${filename} must be valid UTF-8. Reinstall the npm package and try again.`, { cause }); }
    let failure: unknown;
    try { await context.stdoutBytes(entry.contents, signal); }
    catch (cause) { failure = cause; throw cause; }
    finally {
      try { await context.closeStdoutBytes?.(); }
      catch (cause) {
        if (failure !== undefined) throw new AggregateError([failure, cause], "Skill output and stdout cleanup failed.", { cause: failure });
        throw cause;
      }
    }
  });
};
