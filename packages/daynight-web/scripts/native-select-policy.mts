import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { inspectSelectCss } from './native-select-policy-css.mts';
import { inspectSelectTypeScript } from './native-select-policy-typescript.mts';

type Cleanup = () => void | Promise<void>;

export const withPolicyCleanup = async <T,>(run: (register: (cleanup: Cleanup) => void) => Promise<T>): Promise<T> => {
  const cleanups: Cleanup[] = [];
  const failures: unknown[] = [];
  let result: T | undefined;
  try { result = await run(cleanup => cleanups.push(cleanup)); }
  catch (error) { failures.push(error); }
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Native-select inspection and resource cleanup failed.');
  return result as T;
};

const sourceFiles = async (directory: string, label: (path: string) => string): Promise<string[]> => {
  const paths: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    throw new Error(`${label(directory)}:1: cannot enumerate product sources.`, { cause: error });
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${label(path)}:1: source symlinks are unsupported.`);
    if (entry.isDirectory()) paths.push(...await sourceFiles(path, label));
    else if (entry.isFile() && /\.(?:tsx?|css)$/.test(entry.name)) paths.push(path);
    else if (!entry.isFile()) throw new Error(`${label(path)}:1: unsupported source filesystem entry.`);
  }
  return paths.sort();
};

export type NativeSelectPolicyResult = { files: number; wrappers: string[]; diagnostics: string[] };

export const checkNativeSelectPolicy = async (packageDirectory: string): Promise<NativeSelectPolicyResult> => {
  const root = resolve(packageDirectory);
  const label = (path: string): string => relative(root, path).split(sep).join('/');
  const paths = await sourceFiles(join(root, 'src'), label);
  const typescript = paths.filter(path => /\.tsx?$/.test(path));
  if (typescript.length === 0) throw new Error('src:1: native-select policy requires TypeScript product sources.');
  return withPolicyCleanup(async register => {
    const temporaryRoot = join(root, '.tmp');
    await mkdir(temporaryRoot, { recursive: true });
    const temporary = await mkdtemp(join(temporaryRoot, 'native-select-policy-'));
    register(() => rm(temporary, { recursive: true, force: true }));
    const config = join(temporary, 'tsconfig.json');
    await writeFile(config, JSON.stringify({
      compilerOptions: { noEmit: true, noResolve: true, noLib: true, types: [], jsx: 'react-jsx', target: 'ESNext', module: 'ESNext' },
      files: typescript,
    }));
    const api = new API({ cwd: root });
    register(() => api.close());
    const parsed = api.parseConfigFile(config);
    if (JSON.stringify(parsed.fileNames.map(path => resolve(path)).sort()) !== JSON.stringify([...typescript].sort())) {
      throw new Error('src:1: TypeScript configuration does not include every enumerated product source.');
    }
    const snapshot = api.updateSnapshot({ openProject: config });
    register(() => snapshot.dispose());
    const project = snapshot.getProject(config);
    if (project === undefined) throw new Error('src:1: TypeScript project AST is unavailable.');
    const diagnostics: string[] = [], wrappers = new Set<string>();
    for (const path of typescript) {
      const source = project.program.getSourceFile(path);
      if (source === undefined) throw new Error(`${label(path)}:1: TypeScript source AST is unavailable.`);
      const errors = project.program.getSyntacticDiagnostics(path);
      if (errors.length > 0) {
        for (const error of errors) {
          const { line, character } = source.getLineAndCharacterOfPosition(error.pos);
          diagnostics.push(`${label(path)}:${line + 1}:${character + 1}: TypeScript parse failed: ${error.text}`);
        }
        continue;
      }
      const result = inspectSelectTypeScript(source, label(path), join(root, 'src/ui/native-select/NativeSelect.tsx'), project.checker);
      diagnostics.push(...result.diagnostics);
      result.wrappers.forEach(token => wrappers.add(token));
    }
    for (const path of paths.filter(path => path.endsWith('.css'))) {
      const text = await readFile(path, 'utf8').catch(error => {
        throw new Error(`${label(path)}:1: cannot read product CSS.`, { cause: error });
      });
      const violations = inspectSelectCss(text, label(path), wrappers);
      if (path !== join(root, 'src/ui/native-select/native-select.css')) diagnostics.push(...violations);
    }
    return { files: paths.length, wrappers: [...wrappers].sort(), diagnostics };
  });
};

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/native-select-policy.mts');
    const result = await checkNativeSelectPolicy(fileURLToPath(new URL('../', import.meta.url)));
    if (result.diagnostics.length > 0) throw new Error(result.diagnostics.join('\n'));
    console.log(`Native-select ownership passed across ${result.files} source files and ${result.wrappers.length} wrapper classes.`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
