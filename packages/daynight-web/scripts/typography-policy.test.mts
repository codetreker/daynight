import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectTypographyCss, readTypographyRoles } from './typography-policy-css.mts';
import { checkTypographyPolicy } from './typography-policy.mts';

const root = fileURLToPath(new URL('../', import.meta.url));
const owner = ':root { --text-interface: .875rem; --text-reading: 1rem; --text-metadata: .75rem; --text-terminal: .75rem; --text-touch-field: max(1rem, 16px); }';
const roles = readTypographyRoles(owner);
const fixture = async (run: (directory: string, put: (path: string, text: string) => Promise<void>) => Promise<void>): Promise<void> => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(root, '.tmp/typography-test-'));
  const put = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  };
  try {
    await put('src/styles/typography.css', owner);
    await put('src/index.ts', 'export {};');
    await run(directory, put);
  } finally { await rm(directory, { recursive: true, force: true }); }
};

test('allows semantic sizes, inheritance, shared shorthand and terminal rendering scale', () => {
  const css = '.a { font-size: var(--text-interface); } .b { font: italic 600 var(--text-reading)/1.75 system-ui; } .c { font: inherit; font-size: unset; } .terminal {font: calc(var(--text-terminal)*var(--terminal-text-scale,1))/1.75 monospace;}';
  assert.deepEqual(inspectTypographyCss(css, 'src/view.css', roles), []);
});

test('rejects fixed sizes, fallback, unregistered alias, local overrides and fixed shorthand with positions', () => {
  const samples = [
    'font-size: 14px', 'font-size: 1em', 'font-size: 100%', 'font-size: medium',
    'font-size: var(--text-interface, 14px)', 'font-size: var(--business-font)',
    'font-size: calc(var(--text-interface) * 2)', '--text-interface: 2rem',
    'font: 14px monospace', 'font: menu', 'font: italic 600 14px/1.5 system-ui',
    'font: medium/var(--text-interface) monospace', 'font: 120%/var(--text-reading) monospace',
    'font-size: var(--TEXT-interface)', 'font: var(--text-interface)',
    'font-size: revert', 'font-size: revert-layer', 'font: revert', 'font: revert-layer',
  ];
  for (const sample of samples) {
    const diagnostics = inspectTypographyCss(`\n.a { ${sample}; }`, 'src/view.css', roles);
    assert.equal(diagnostics.length, 1, sample);
    assert.match(diagnostics[0]!, /^src\/view.css:2:6: typography ownership:/);
  }
  assert.throws(() => inspectTypographyCss('.a { font-size: var(; }', 'src/view.css', roles), /CSS parse failed/);
});

test('allows selection aliases only through their actual owners and validates every declaration', () => {
  assert.deepEqual(inspectTypographyCss('.selection-control { --selection-control-font-size: var(--text-interface); font-size: var(--selection-control-font-size); }', 'src/ui/selection-control/selection-control.css', roles), []);
  assert.deepEqual(inspectTypographyCss('.native-select { --native-select-font-size: var(--selection-control-font-size); font-size: var(--native-select-font-size); }', 'src/ui/native-select/native-select.css', roles), []);
  assert.equal(inspectTypographyCss('.consumer { font-size: var(--selection-control-font-size); }', 'src/view.css', roles).length, 1);
  assert.equal(inspectTypographyCss('.selection-control { --selection-control-font-size: 14px; }', 'src/ui/selection-control/selection-control.css', roles).length, 1);
  assert.equal(inspectTypographyCss('.consumer { --selection-control-font-size: var(--text-interface); }', 'src/view.css', roles).length, 1);
  for (const property of ['--text-interface', '--native-select-font-size', '--selection-control-font-size', '--selection-control-count-font-size']) {
    for (const path of ['src/consumer.css', 'src/ui/native-select/native-select.css', 'src/ui/selection-control/selection-control.css']) {
      const diagnostics = inspectTypographyCss(`@property ${property} {syntax: "<length>"; inherits: false; initial-value: 8px;}`, path, roles);
      assert.equal(diagnostics.length, 1, `${property} in ${path}`);
      assert.match(diagnostics[0]!, /cannot be registered with @property/);
    }
  }
  assert.equal(inspectTypographyCss(String.raw`@property --te\78 t-reading {syntax: "<length>"; inherits: false; initial-value: 8px;}`, 'src/consumer.css', roles).length, 1);
  assert.equal(inspectTypographyCss(String.raw`@property --native-select-font-\73 ize {syntax: "<length>"; inherits: false; initial-value: 8px;}`, 'src/consumer.css', roles).length, 1);
});

test('validates the single role owner and derives new registered roles from it', () => {
  assert.ok(readTypographyRoles(`${owner} :root { --text-extra: 2rem; }`).has('--text-extra'));
  for (const invalid of [owner.replace(':root', '.local'), `${owner} :root { --text-interface: 1rem; }`, owner.replace('.875rem', '14px'), `@media (width > 10px) { ${owner} }`]) {
    assert.throws(() => readTypographyRoles(invalid), /typography roles|duplicate typography role|shared rem size/);
  }
  assert.throws(() => readTypographyRoles(owner + String.raw` :root { --te\78 t-reading: 2rem; }`), /duplicate typography role/);
  assert.throws(() => readTypographyRoles(owner + String.raw` .local { --te\78 t-extra: 2rem; }`), /unconditional :root/);
});

test('checks unimported production CSS and TSX inline declarations, aliases, DOM writes and shorthand', async () => {
  await fixture(async (directory, put) => {
    await put('src/unimported.css', '.old {font-size: 9px}');
    await put('src/deep/view.tsx', `
      const bad = '13px'; const property = 'fontSize';
      const styles = { [property]: bad, '--text-interface': '1rem' };
      const view = <span fontSize="12px" style={{font: '14px monospace'}} />;
      element.style.fontSize = bad;
      element.style['font'] = '12px monospace';
      element.style.setProperty('font-size', bad);
      element.setAttribute('style', 'color: red; font-size: 10px');
      element.style.cssText = 'font: 10px monospace';
    `);
    const result = await checkTypographyPolicy(directory);
    assert.equal(result.files, 4);
    assert.equal(result.diagnostics.length, 10, result.diagnostics.join('\n'));
    assert.ok(result.diagnostics.some(value => value.startsWith('src/unimported.css:1:')));
    assert.ok(result.diagnostics.some(value => value.startsWith('src/deep/view.tsx:5:')));
    assert.deepEqual(await readdir(join(directory, '.tmp')), []);
  });
});

test('allows inline shared values and external Mermaid theme configuration while rejecting neighboring UI sizes', async () => {
  await fixture(async (directory, put) => {
    await put('src/view.tsx', `
      const role = 'var(--text-interface)';
      const styles = {fontSize: role, font: 'inherit'};
      const view = <span style={styles} fontSize={role} />;
      element.style.fontSize = role;
      element.style.setProperty('font-size', role);
      element.setAttribute('style', 'font-size: var(--text-interface)');
      const configuration: MermaidConfig = { themeVariables: { fontSize: '14px' } };
      const other = { themeVariables: { fontSize: '14px' } };
      const text = 'font-size: 1px'; // No style sink.
    `);
    const result = await checkTypographyPolicy(directory);
    assert.equal(result.diagnostics.length, 1, result.diagnostics.join('\n'));
    assert.match(result.diagnostics[0]!, /view.tsx:9:/);
  });
});

test('reports malformed unimported TypeScript instead of treating it as no declarations', async () => {
  await fixture(async (directory, put) => {
    await put('src/bad.tsx', 'const broken = <span');
    const result = await checkTypographyPolicy(directory);
    assert.ok(result.diagnostics.some(value => /src\/bad.tsx:\d+:\d+: TypeScript parse failed/.test(value)));
  });
});

test('rejects statically readable numeric coercion in inline CSS strings', async () => {
  await fixture(async (directory, put) => {
    await put('src/numeric.ts', "const n = 14; element.style.cssText = `font-size: ${n}px`; element.setAttribute('style', 'font-size:' + 10 + 'px'); element.style.cssText = `font-size: ${-12}px`; element.setAttribute('STYLE', 'font-size:10px'); element.style.setProperty('FONT-SIZE','11px');");
    const result = await checkTypographyPolicy(directory);
    assert.equal(result.diagnostics.length, 5, result.diagnostics.join('\n'));
    assert.ok(result.diagnostics.every(value => value.startsWith('src/numeric.ts:1:')));
  });
});

test('production tree and direct CLI enforce the same policy', async () => {
  const result = await checkTypographyPolicy(root);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.files > 100);
  const command = spawnSync(process.execPath, ['scripts/typography-policy.mts'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /Typography ownership passed/);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.match(packageJson.scripts['test:harness'], /typography-policy/);
});
