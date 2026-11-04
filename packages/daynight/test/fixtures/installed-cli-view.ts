import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInstalledCliRoot } from "./installed-cli.js";
import type { InstalledCliOptions, InstalledCliReceipt } from "./installed-cli.js";

const digest = (contents: Uint8Array): string => createHash("sha256").update(contents).digest("hex");
const linkDirectory = async (target: string, destination: string): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
};

const copyWritablePackage = async (canonical: InstalledCliReceipt, root: string): Promise<{ entryPath: string; launcherPath: string }> => {
  const sourceConsumer = path.dirname(path.dirname(path.dirname(canonical.launcherPath)));
  const consumer = path.join(root, "consumer install");
  const sourcePackage = await realpath(path.dirname(path.dirname(canonical.entryPath)));
  const relativePackage = path.relative(sourceConsumer, sourcePackage);
  if (relativePackage.startsWith(`..${path.sep}`) || path.isAbsolute(relativePackage)) throw new Error("Installed CLI package is outside its consumer installation.");
  const installedPackage = path.join(consumer, relativePackage);
  await cp(sourcePackage, installedPackage, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  const sourceDependencies = path.dirname(path.dirname(sourcePackage));
  const dependencies = path.dirname(path.dirname(installedPackage));
  for (const entry of await readdir(sourceDependencies, { withFileTypes: true })) {
    if (entry.name.startsWith("@")) {
      for (const dependency of await readdir(path.join(sourceDependencies, entry.name))) {
        const source = path.join(sourceDependencies, entry.name, dependency);
        if (source === sourcePackage) continue;
        await linkDirectory(await realpath(source), path.join(dependencies, entry.name, dependency));
      }
    } else await linkDirectory(await realpath(path.join(sourceDependencies, entry.name)), path.join(dependencies, entry.name));
  }
  await linkDirectory(installedPackage, path.join(consumer, "node_modules/@codetreker/daynight"));
  await linkDirectory(path.join(sourceConsumer, "node_modules/.pnpm/node_modules"), path.join(consumer, "node_modules/.pnpm/node_modules"));
  const sourceBins = path.join(sourceConsumer, "node_modules/.bin");
  const bins = path.join(consumer, "node_modules/.bin");
  await mkdir(bins);
  for (const name of await readdir(sourceBins)) {
    const source = path.join(sourceBins, name);
    const destination = path.join(bins, name);
    const contents = (await readFile(source, "utf8"))
      .replaceAll(sourceConsumer, consumer)
      .replaceAll(sourceConsumer.replaceAll("\\", "/"), consumer.replaceAll("\\", "/"));
    await writeFile(destination, contents, { mode: (await stat(source)).mode });
    await chmod(destination, (await stat(source)).mode);
  }
  await copyFile(path.join(sourceConsumer, "package.json"), path.join(consumer, "package.json"));
  return { entryPath: path.join(installedPackage, "dist/main.js"), launcherPath: path.join(bins, path.basename(canonical.launcherPath)) };
};

export const createInstalledCliView = async (
  canonical: InstalledCliReceipt,
  options: InstalledCliOptions & { readonly writablePackage?: boolean } = {},
): Promise<{ readonly receipt: InstalledCliReceipt; readonly receiptPath: string; cleanup(): Promise<void> }> => {
  options.signal?.throwIfAborted();
  const root = await createInstalledCliRoot(options);
  try {
    await chmod(root, 0o700);
    options.signal?.throwIfAborted();
    const paths = options.writablePackage === true ? await copyWritablePackage(canonical, root) : { entryPath: canonical.entryPath, launcherPath: canonical.launcherPath };
    options.signal?.throwIfAborted();
    const receipt: InstalledCliReceipt = { ...canonical, root, ...paths, entrySha256: digest(await readFile(paths.entryPath)) };
    const receiptPath = path.join(root, "installed-cli.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return { receipt, receiptPath, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
  } catch (cause) {
    try { await rm(root, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], "Installed CLI view preparation and cleanup failed."); }
    throw cause;
  }
};
