import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { createImageDecoder, type ImageDecoder } from "../../src/commands/controller/media/image-decoder.js";
import { IMAGE_VALIDATION_BUILD_ID } from "../../src/commands/controller/media/image-validation.js";

/** Execute the current helper and engine in a child without replacing packaged artifacts. */
export const sourceImageDecoder = async (directory: string): Promise<ImageDecoder> => {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const artifacts: Record<string, string> = {};
  for (const name of ["image-validation", "image-validation-helper"]) {
    const source = await readFile(new URL(`../../src/commands/controller/media/${name}.ts`, import.meta.url), "utf8");
    // The isolated helper resolves the installed pinned decoder dependency.
    const compiled = stripTypeScriptTypes(source, { mode: "transform" }).replace('from "sharp"', `from ${JSON.stringify(import.meta.resolve("sharp"))}`);
    await writeFile(path.join(root, `${name}.js`), compiled);
    artifacts[name] = createHash("sha256").update(compiled).digest("hex");
  }
  return createImageDecoder({ runtimePath: await realpath(process.execPath), helperPath: path.join(root, "image-validation-helper.js"), enginePath: path.join(root, "image-validation.js"), helperSha256: artifacts["image-validation-helper"]!, engineSha256: artifacts["image-validation"]!, buildId: IMAGE_VALIDATION_BUILD_ID });
};
