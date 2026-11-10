import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination) || existsSync(destination)) throw new Error("An unused absolute image validator output directory is required.");
mkdirSync(destination, { recursive: true });
writeFileSync(path.join(destination, "package.json"), '{"type":"module"}\n');
for (const name of ["image-validation.js", "image-validation-helper.js", "image-validation-manifest.json"]) {
  cpSync(path.join(root, "dist/commands/controller/media", name), path.join(destination, name), { errorOnExist: true, force: false });
}

// Copy only the installed, lockfile-selected decoder dependency closure. Keep each
// package's own resolution scope; native optional packages belong to this platform.
const copyPackage = (name: string, parent: string, output: string, optional = false, ancestors: readonly string[] = []): void => {
  const search = createRequire(parent).resolve.paths(name) ?? [];
  const metadata = search.map(directory => path.join(directory, name, "package.json")).find(existsSync);
  if (!metadata) { if (optional) return; throw new Error(`Missing image validator dependency: ${name}`); }
  const source = path.dirname(realpathSync(metadata));
  if (ancestors.includes(source)) throw new Error(`Image validator dependency cycle: ${name}`);
  const info = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  if (info.name !== name) throw new Error(`Image validator dependency identity differs: ${name}`);
  const target = path.join(output, "node_modules", name);
  cpSync(source, target, { recursive: true, dereference: true, errorOnExist: true, force: false, filter: sourcePath => !sourcePath.split(path.sep).slice(source.split(path.sep).length).includes("node_modules") });
  for (const dependency of Object.keys(info.dependencies ?? {})) copyPackage(dependency, path.join(source, "package.json"), target, false, [...ancestors, source]);
  for (const dependency of Object.keys(info.optionalDependencies ?? {})) copyPackage(dependency, path.join(source, "package.json"), target, true, [...ancestors, source]);
};
copyPackage("sharp", path.join(root, "package.json"), destination);
