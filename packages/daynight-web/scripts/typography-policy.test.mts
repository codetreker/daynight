import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectTypographyCss, inspectTypographyCss, readTypographyRoles } from './typography-policy-css.mts';
import { checkTypographyPolicy } from './typography-policy.mts';

const root = fileURLToPath(new URL('../', import.meta.url));
const owner = ':root { --text-xs: .75rem; --text-sm: .875rem; --text-base: 1rem; --text-lg: 1.125rem; --text-xl: 1.375rem; --text-2xl: 1.75rem; }';
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

test('requires exactly six sizes in one unconditional owner without bridges', () => {
  assert.equal(roles.size, 6);
  for (const invalid of [
    owner.replace(':root', '.local'), `${owner} :root { --text-extra: 2rem; }`,
    owner.replace('.875rem', '.9rem'), owner.replace('.875rem', '14px'),
    `@media (width > 10px) { ${owner} }`, `${owner} :root {}`,
    owner.replace('--text-xs: .75rem;', ''),
    owner.replace('}', '--text-interface: var(--text-sm); }'),
    owner.replace('}', '--text-touch-field: max(var(--text-base), 16px); }'),
    owner.replace('}', '--text-terminal: .75rem; }'),
  ]) assert.throws(() => readTypographyRoles(invalid), invalid);
  assert.throws(() => readTypographyRoles(owner.replace('}', String.raw`--te\78 t-sm: .875rem; }`)), /duplicate/);
});

test('allows only scale values, inheritance and semantic shorthand', () => {
  assert.deepEqual(inspectTypographyCss('.a {font-size:var(--text-sm)} .b {font:italic 600 var(--text-base)/1.75 system-ui} .c {font:inherit;font-size:unset}', 'src/view.css', roles), []);
  for (const declaration of [
    'font-size:14px', 'font-size:1em', 'font-size:100%', 'font-size:medium',
    'font-size:var(--text-sm,14px)', 'font-size:var(--business-font)',
    'font-size:calc(var(--text-sm)*2)', '--text-sm:2rem', '--business-font-size:var(--text-sm)',
    'font:14px monospace', 'font:menu', 'font:italic 600 14px/1.5 system-ui',
    'font:medium/var(--text-sm) monospace', 'font:120%/var(--text-base) monospace',
    'font-size:var(--TEXT-sm)', 'font:var(--text-sm)', 'font-size:revert', 'font:revert-layer',
  ]) {
    const diagnostics = inspectTypographyCss(`\n.a {${declaration}}`, 'src/view.css', roles);
    assert.ok(diagnostics.length > 0, declaration);
    assert.match(diagnostics[0]!, /^src\/view.css:2:5: typography ownership:/);
  }
  assert.throws(() => inspectTypographyCss('.a {font-size:var(;}', 'src/view.css', roles), /CSS parse failed/);
});

test('constrains terminal and touch expressions to their public boundaries', () => {
  const terminal = '.terminal-text {font:calc(var(--text-sm)*var(--terminal-text-scale,1))/1.75 monospace}';
  assert.deepEqual(inspectTypographyCss(terminal, 'src/features/task-agent-session/terminal-session.css', roles), []);
  assert.equal(inspectTypographyCss(terminal, 'src/other.css', roles).length, 1);
  const touch = '.field {font-size:max(var(--text-base),16px)}';
  assert.deepEqual(inspectTypographyCss(touch, 'src/ui/selection-control/selection-control.css', roles), []);
  assert.equal(inspectTypographyCss(touch, 'src/styles/typography.css', roles).length, 1);
  assert.equal(inspectTypographyCss(touch, 'src/view.css', roles).length, 1);
  assert.equal(inspectTypographyCss('font-size:max(var(--text-base),16px)', 'src/ui/selection-control/selection-control.css', roles, true).length, 1);
});

test('tracks retired identifiers in all geometry, definitions and escaped references', () => {
  const text = '.chart {--bar-chart-plot-height:calc(10*var(--text-metadata));height:var(--selection-control-font-size);--native-select-font-size:var(--text-interface)}';
  const items = collectTypographyCss(text, 'src/view.css', roles);
  assert.equal(items.filter(item => item.category === 'legacy-reference').length, 3);
  assert.equal(items.filter(item => item.category === 'legacy-definition').length, 1);
  assert.equal(collectTypographyCss(String.raw`.a {height:var(--te\78 t-interface)}`, 'src/a.css', roles)[0]?.category, 'legacy-reference');
  for (const property of ['--text-sm', '--text-interface', '--native-select-font-size', '--selection-control-font-size']) {
    assert.ok(inspectTypographyCss(`@property ${property} {syntax:"<length>";inherits:false;initial-value:8px}`, 'src/view.css', roles).some(value => value.includes('cannot be registered')));
  }
});

test('checks unimported production files and static TS writes', async () => {
  await fixture(async (directory, put) => {
    await put('src/unimported.css', '.old {font-size:9px}');
    await put('src/deep/view.tsx', `
      const bad = '13px'; const property = 'fontSize';
      const styles = { [property]: bad, '--text-sm': '1rem' };
      const view = <span fontSize="12px" style={{font:'14px monospace'}} />;
      element.style.fontSize = bad;
      element.style['font'] = '12px monospace';
      element.style.setProperty('font-size', bad);
      element.setAttribute('style', 'color:red;font-size:10px');
      element.style.cssText = 'font:10px monospace';
    `);
    const result = await checkTypographyPolicy(directory);
    assert.equal(result.files, 4);
    assert.equal(result.diagnostics.length, 10, result.diagnostics.join('\n'));
    assert.ok(result.diagnostics.some(value => value.startsWith('src/unimported.css:1:')));
    assert.deepEqual(await readdir(join(directory, '.tmp')), []);
  });
});

test('rejects retired static strings, runtime reads and writes including concatenation', async () => {
  await fixture(async (directory, put) => {
    await put('src/legacy.ts', `
      const name = '--text-' + 'interface';
      const alias = name;
      element.style.setProperty('height', 'var(' + name + ')');
      const size = getComputedStyle(element).getPropertyValue(alias);
      element.style.cssText = 'height:var(--text-metadata)';
      element.setAttribute('style', 'width:var(--text-reading)');
      const key = '--native-select-font-size';
    `);
    const result = await checkTypographyPolicy(directory);
    for (const identifier of ['--text-interface', '--text-metadata', '--text-reading', '--native-select-font-size']) {
      assert.ok(result.diagnostics.some(value => value.includes(identifier)), identifier);
    }
  });
});

test('constrains Mermaid font settings to measured adapter paths', async () => {
  await fixture(async (directory, put) => {
    const adapter = 'src/ui/markdown/mermaid/MermaidRenderer.ts';
    const wrap = (body: string) => `const buildMermaidConfiguration = (sizes: MermaidSizes): MermaidConfig => (${body});`;
    await put(adapter, wrap('{themeVariables:{fontSize:`${sizes.sm}px`,pieTitleTextSize:`${sizes.lg}px`,packet:{byteFontSize:`${sizes.xs}px`}}, sequence:{actorFontSize:sizes.sm}, themeCSS:`.title {font-size:${sizes.lg}px}`}'));
    assert.deepEqual((await checkTypographyPolicy(directory)).diagnostics, []);
    for (const bad of [
      '{sequence:{actorFontSize:13}}', '{themeVariables:{pieTitleTextSize:"18px"}}',
      '{themeVariables:{packet:{byteFontSize:"12px"}}}', '{sequence:{actorFontSize:getSize()}}',
      '{sequence:{actorFontSize:sizes.lg}}', '{themeCSS:`.title {font-size:18px}`} ',
      '{themeCSS:`.title {font-size:${getSize()}px}`}', '{themeCSS:`.title {font-size:var(--text-sm)}`}',
      '{sequence: other}', '{...other}',
    ]) {
      await put(adapter, wrap(bad));
      assert.ok((await checkTypographyPolicy(directory)).diagnostics.some(value => value.includes('Mermaid')), bad);
    }
    await put(adapter, '');
    await put('src/mermaid.ts', 'const sequence = { actorFontSize: 13 }; const configuration: MermaidConfig = { sequence }; const alias = configuration.sequence; alias.actorFontSize = 14; configuration.packet = {byteFontSize: 13}; mermaid.initialize({sequence:{actorFontSize:13}});');
    const diagnostics = (await checkTypographyPolicy(directory)).diagnostics.join('\n');
    assert.match(diagnostics, /actorFontSize/);
    assert.match(diagnostics, /cannot be written dynamically/);
    for (const bad of [
      'type Config = MermaidConfig; const c: Config = {sequence:{actorFontSize:13}};',
      'const c = {} as MermaidConfig; c.sequence.actorFontSize = 13;',
      'const c: MermaidConfig = {}; Object.assign(c, {sequence:{actorFontSize:13}});',
      'function f(c: MermaidConfig) { c.sequence.actorFontSize = 13; }',
      'const c: MermaidConfig = {}; const {sequence} = c; sequence.actorFontSize = 13;',
      'const c: MermaidConfig = {}; Reflect.set(c.sequence, "actorFontSize", 13);',
      'import type { MermaidConfig as C } from "mermaid"; const c: C = {sequence:{actorFontSize:13}};',
    ]) {
      await put('src/mermaid.ts', bad);
      assert.ok((await checkTypographyPolicy(directory)).diagnostics.some(value => value.includes('Mermaid')), bad);
    }
  });
});

test('finds composed and escaped retired names without any complete raw token', async () => {
  await fixture(async (directory, put) => {
    for (const expression of ["'--text-' + 'interface'", String.raw`'--te\u0078t-interface'`, "`--text-${'interface'}`"]) {
      await put('src/composed.ts', `const property = ${expression}; element.style.setProperty('height', 'var(' + property + ')'); getComputedStyle(element).getPropertyValue(property);`);
      const result = await checkTypographyPolicy(directory);
      assert.ok(result.diagnostics.some(value => value.includes('retired typography')), expression);
    }
  });
});

test('allows new inline sizes and rejects neighboring fixed or dynamic values and numeric coercion', async () => {
  await fixture(async (directory, put) => {
    await put('src/view.tsx', `
      const role = 'var(--text-sm)';
      const styles = {fontSize:role,font:'inherit'};
      const view = <span style={styles} fontSize={role} />;
      element.style.fontSize = role;
      element.style.setProperty('font-size',role);
      element.setAttribute('style','font-size:var(--text-sm)');
      const text = 'font-size:1px';
      const bad = {fontSize:getSize()};
      const n = 14; element.style.cssText = \`font-size: \${n}px\`;
      element.setAttribute('style', 'font-size:' + 10 + 'px');
      element.style.cssText = \`font-size: \${-12}px\`;
      element.setAttribute('STYLE', 'font-size:10px');
      element.style.setProperty('FONT-SIZE','11px');
    `);
    const result = await checkTypographyPolicy(directory);
    assert.equal(result.diagnostics.length, 6, result.diagnostics.join('\n'));
  });
});

test('rejects unknown runtime font values at recognized writes', async () => {
  await fixture(async (directory, put) => {
    await put('src/runtime.tsx', `
      element.style.fontSize = getSize();
      element.style.setProperty('font-size', getSize());
      element.style.font = getFont();
      const view = <span fontSize={getSize()} />;
    `);
    const diagnostics = (await checkTypographyPolicy(directory)).diagnostics;
    assert.equal(diagnostics.length, 4, diagnostics.join('\n'));
    assert.ok(diagnostics.every(value => value.includes('statically readable')));
  });
});

test('reports malformed unimported TypeScript', async () => {
  await fixture(async (directory, put) => {
    await put('src/bad.tsx', 'const broken = <span');
    assert.ok((await checkTypographyPolicy(directory)).diagnostics.some(value => /src\/bad.tsx:\d+:\d+: TypeScript parse failed/.test(value)));
  });
});

test('rejects every retired identifier in definitions, font values and geometry', async () => {
  await fixture(async (directory, put) => {
    const identifiers = [
      '--text-metadata', '--text-interface', '--text-reading', '--text-section-heading',
      '--text-detail-heading', '--text-page-heading', '--text-terminal', '--text-touch-field',
      '--selection-control-font-size', '--selection-control-count-font-size', '--native-select-font-size',
    ];
    await put('src/view.css', identifiers.map(name => `.a {height:var(${name});font-size:var(${name});${name}:var(--text-sm)}`).join('\n'));
    const diagnostics = (await checkTypographyPolicy(directory)).diagnostics;
    for (const name of identifiers) assert.equal(diagnostics.filter(value => value.includes(name)).length, 3, name);
    await put('src/view.css', '.a {font-size:var(--text-sm)}');
    assert.deepEqual((await checkTypographyPolicy(directory)).diagnostics, []);
  });
});

test('rejects wrapped retired values at inline writes', async () => {
  await fixture(async (directory, put) => {
    for (const expression of [
      "('var(--text-interface)' as const)", "('var(--text-interface)')",
      "('var(--text-interface)' satisfies string)",
      "condition ? 'var(--text-interface)' : 'inherit'",
    ]) {
      await put('src/wrapped.ts', `element.style.fontSize = ${expression};`);
      assert.ok((await checkTypographyPolicy(directory)).diagnostics.some(value => value.includes('retired typography')), expression);
    }
  });
});

test('preserves escaped CSS dependencies in cssText, setAttribute and JSX declarations', async () => {
  await fixture(async (directory, put) => {
    const css = String.raw`font-size:var(--te\78 t-interface)`;
    for (const statement of [
      `element.style.cssText = ${JSON.stringify(css)};`,
      `element.setAttribute('style', ${JSON.stringify(css)});`,
      `<div style="${css}" />;`,
      `<div style={${JSON.stringify(css)}} />;`,
    ]) {
      await put('src/escaped.tsx', statement);
      const diagnostics = (await checkTypographyPolicy(directory)).diagnostics;
      assert.ok(diagnostics.some(value => value.includes('retired typography')), statement);
      assert.ok(diagnostics.every(value => !value.includes('undefined')));
    }
  });
});

test('production tree and direct CLI enforce the same strict policy', async () => {
  const result = await checkTypographyPolicy(root);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.roles.length, 6);
  assert.ok(result.files > 100);
  const command = spawnSync(process.execPath, ['scripts/typography-policy.mts'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /Typography ownership passed/);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.match(packageJson.scripts['test:harness'], /typography-policy/);
});
