import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { withPolicyCleanup } from './native-select-policy.mts';
import { collectTypographyCss, readTypographyRoles, typographyOwner } from './typography-policy-css.mts';
import { collectTypographyTypeScript } from './typography-policy-typescript.mts';
import { compareTypographyBaseline, readTypographyBaseline, typographyBaselinePath, type TypographyBaselineEntry } from './typography-policy-baseline.mts';
import { typographyDependencyDiagnostics, type TypographyOccurrence } from './typography-policy-contract.mts';

const sourceFiles = async (directory: string): Promise<string[]> => {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${path}: source symlinks are unsupported.`);
    if (entry.isDirectory()) paths.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:css|tsx?)$/.test(entry.name)) paths.push(path);
    else if (!entry.isFile()) throw new Error(`${path}: unsupported source entry.`);
  }
  return paths.sort();
};

export const collectTypographyPolicy = async (packageDirectory: string): Promise<{ files: number; roles: string[]; occurrences: TypographyOccurrence[]; diagnostics: string[] }> => {
  const root = resolve(packageDirectory);
  const label = (path: string): string => relative(root, path).split(sep).join('/');
  const paths = await sourceFiles(join(root, 'src'));
  const ownerText = await readFile(join(root, typographyOwner), 'utf8');
  const roles = readTypographyRoles(ownerText);
  const diagnostics: string[] = [];
  const occurrences: TypographyOccurrence[] = [];
  for (const path of paths.filter(path => path.endsWith('.css'))) occurrences.push(...collectTypographyCss(await readFile(path, 'utf8'), label(path), roles));
  const typescript = paths.filter(path => /\.tsx?$/.test(path));
  if (typescript.length === 0) throw new Error('src:1: typography inspection requires TypeScript product sources.');
  await withPolicyCleanup(async register => {
    const temporaryRoot = join(root, '.tmp');
    await mkdir(temporaryRoot, { recursive: true });
    const temporary = await mkdtemp(join(temporaryRoot, 'typography-policy-'));
    register(() => rm(temporary, { recursive: true, force: true }));
    const config = join(temporary, 'tsconfig.json');
    await writeFile(config, JSON.stringify({ compilerOptions: { noEmit: true, noResolve: true, noLib: true, types: [], jsx: 'react-jsx', target: 'ESNext', module: 'ESNext' }, files: typescript }));
    const api = new API({ cwd: root });
    register(() => api.close());
    const parsed = api.parseConfigFile(config);
    if (JSON.stringify(parsed.fileNames.map(path => resolve(path)).sort()) !== JSON.stringify([...typescript].sort())) throw new Error('src:1: TypeScript inspection omitted product sources.');
    const snapshot = api.updateSnapshot({ openProject: config });
    register(() => snapshot.dispose());
    const project = snapshot.getProject(config);
    if (project === undefined) throw new Error('src:1: TypeScript project AST is unavailable.');
    for (const path of typescript) {
      const source = project.program.getSourceFile(path);
      if (source === undefined) throw new Error(`${label(path)}:1: TypeScript source AST is unavailable.`);
      const errors = project.program.getSyntacticDiagnostics(path);
      for (const error of errors) {
        const { line, character } = source.getLineAndCharacterOfPosition(error.pos);
        diagnostics.push(`${label(path)}:${line + 1}:${character + 1}: TypeScript parse failed: ${error.text}`);
      }
      if (errors.length === 0) occurrences.push(...collectTypographyTypeScript(source, label(path), roles, project.checker));
    }
  });
  return { files: paths.length, roles: [...roles].sort(), occurrences, diagnostics: [...diagnostics, ...typographyDependencyDiagnostics(occurrences)] };
};

export const checkTypographyPolicy = async (packageDirectory: string, options: { baseline?: readonly TypographyBaselineEntry[]; zeroLegacy?: boolean } = {}): Promise<{ files: number; roles: string[]; legacy: number; diagnostics: string[] }> => {
  const result = await collectTypographyPolicy(packageDirectory);
  const baseline = options.zeroLegacy === true ? [] : options.baseline ?? readTypographyBaseline(await readFile(join(packageDirectory, typographyBaselinePath), 'utf8'));
  return { files: result.files, roles: result.roles, legacy: result.occurrences.filter(item => item.category !== 'invalid').length, diagnostics: [...result.diagnostics, ...compareTypographyBaseline(result.occurrences, baseline, options.zeroLegacy === true)] };
};

if (import.meta.main) {
  try {
    if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== '--zero-legacy')) throw new Error('Usage: node scripts/typography-policy.mts [--zero-legacy]');
    const result = await checkTypographyPolicy(fileURLToPath(new URL('../', import.meta.url)), { zeroLegacy: process.argv[2] === '--zero-legacy' });
    if (result.diagnostics.length > 0) throw new Error(result.diagnostics.join('\n'));
    console.log(`Typography ownership passed across ${result.files} source files, ${result.roles.length} public sizes and ${result.legacy} recorded legacy occurrences.`);
  } catch (error) { console.error(error); process.exitCode = 1; }
}
