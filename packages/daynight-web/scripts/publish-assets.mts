import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PublicationPaths = { source: string; destination: string; temporaryRoot: string };

const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const directory = async (path: string): Promise<void> => {
  if (!(await lstat(path)).isDirectory()) throw new Error(`Expected an ordinary directory: ${path}`);
};

const filesIn = async (root: string, prefix = ''): Promise<Set<string>> => {
  await directory(root);
  const files = new Set<string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      for (const child of await filesIn(path, `${name}/`)) files.add(child);
    } else if (entry.isFile()) files.add(name);
    else throw new Error(`Build output contains a symbolic link or nonregular entry: ${path}`);
  }
  return files;
};

export const validateAssets = async (root: string): Promise<number> => {
  const files = await filesIn(root);
  if (!files.has('index.html')) throw new Error('Build output is missing index.html.');
  if (![...files].some((path) => path.startsWith('assets/'))) throw new Error('Build output is missing generated assets.');
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const references = [...html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
  if (references.length === 0) throw new Error('Build index does not reference generated assets.');
  for (const match of references) {
    const reference = match[1] ?? match[2] ?? match[3]!;
    let decoded: string;
    try { decoded = decodeURIComponent(reference); }
    catch (error) { throw new Error(`Invalid build asset reference: ${reference}`, { cause: error }); }
    if (!decoded.startsWith('/assets/') || /[\\?#\u0000]/.test(decoded)
      || decoded.split('/').some((part) => part === '.' || part === '..') || !files.has(decoded.slice(1))) {
      throw new Error(`Build index references an invalid or missing asset: ${reference}`);
    }
  }
  return files.size;
};

const contains = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

export const publishAssets = async (paths: PublicationPaths): Promise<number> => {
  const source = resolve(paths.source);
  const destination = resolve(paths.destination);
  const temporaryRoot = resolve(paths.temporaryRoot);
  if (contains(source, destination) || contains(destination, source)
    || contains(source, temporaryRoot) || contains(destination, temporaryRoot)) {
    throw new Error('Build source, destination, and staging directory must not overlap.');
  }
  await validateAssets(source);
  if (await exists(destination)) await directory(destination);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await directory(temporaryRoot);
  const temporary = await mkdtemp(join(temporaryRoot, 'publish-assets-'));
  const staged = join(temporary, 'dist');
  const previous = join(temporary, 'previous');
  let failure: unknown;
  let retainPrevious = false;
  try {
    await cp(source, staged, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    const count = await validateAssets(staged);
    const hadPrevious = await exists(destination);
    if (hadPrevious) await rename(destination, previous);
    try { await rename(staged, destination); }
    catch (error) {
      if (hadPrevious) {
        try { await rename(previous, destination); }
        catch (rollbackError) {
          retainPrevious = true;
          throw new AggregateError([error, rollbackError], `Asset publication and rollback failed; previous assets retained at ${previous}`);
        }
      }
      throw error;
    }
    return count;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (!retainPrevious) {
      try { await rm(temporary, { recursive: true, force: true }); }
      catch (error) {
        if (failure !== undefined) throw new AggregateError([failure, error], 'Asset publication and staging cleanup failed.');
        throw error;
      }
    }
  }
};

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/publish-assets.mts');
    const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
    const count = await publishAssets({
      source: join(packageDirectory, 'dist'),
      destination: resolve(packageDirectory, '../daynight-server/internal/service/webui/dist'),
      temporaryRoot: resolve(packageDirectory, '../../.tmp'),
    });
    console.log(`Published ${count} frontend files for the Go server.`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
