import path from "node:path";
import { captureSkillBundle, validateSkillEntrypoint } from "../../platform/skill-bundle.js";
import type { BundleEntry } from "../../platform/skill-bundle.js";

export type SkillBundle = readonly BundleEntry[];

export const captureInstalledSkill = async (packageDirectory: string): Promise<SkillBundle> => {
  const source = path.join(packageDirectory, "dist", "commands", "skill", "skills", "using-daynight");
  try {
    const bundle = await captureSkillBundle(source, "using-daynight skill");
    validateSkillEntrypoint(bundle, "using-daynight", "using-daynight skill");
    return bundle;
  } catch (cause) { throw new Error(`Cannot capture installed using-daynight skill bundle ${source}. Reinstall the npm package and try again.`, { cause }); }
};

