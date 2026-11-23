import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectSelectCss } from './native-select-policy-css.mts';
import { checkNativeSelectPolicy, withPolicyCleanup } from './native-select-policy.mts';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = join(packageDirectory, '.tmp');
const fixture = async (run: (directory: string, put: (path: string, text: string) => Promise<void>) => Promise<void>): Promise<void> => {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'native-select-test-'));
  const put = async (path: string, text: string): Promise<void> => {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text);
  };
  try {
    await put('src/ui/native-select/NativeSelect.tsx', 'export const NativeSelect = (props: unknown) => <select />;');
    await put('src/ui/native-select/native-select.css', '.native-select__control { appearance: none; }');
    await run(directory, put);
  } finally { await rm(directory, { recursive: true, force: true }); }
};

test('allows the public owner, aliases, single/multiple selects and literal wrapper combinations', async () => {
  await fixture(async (directory, put) => {
    await put('src/view.tsx', `
      import { NativeSelect as Choice } from './ui/native-select/NativeSelect';
      import { NativeSelect as Select } from './ui/native-select/NativeSelect';
      import * as Selects from './ui/native-select/NativeSelect';
      declare const flag: boolean;
      const first = <Choice wrapperClassName={'wide' + ' spaced'}><option>One</option></Choice>;
      const second = <Selects.NativeSelect multiple size={4} wrapperClassName={flag ? 'column' : \`grid \${'narrow'}\`} />;
      const generic = <T,>(value: T): T => value;
      const text = '<select /> React.createElement("select")';
      // <select /> createElement('select')
      const other = <input />;
      declare const SELECT: any;
      const components = <><Select wrapperClassName="caps" /><SELECT /></>;
    `);
    await put('src/layout.css', '.wide,.narrow{width:120px;max-inline-size:100%}.spaced{margin:8px 0}.column{flex:1;align-self:start}.grid{grid-column:2;order:1}');
    const result = await checkNativeSelectPolicy(directory);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.wrappers, ['caps', 'column', 'grid', 'narrow', 'spaced', 'wide']);
    assert.deepEqual(await readdir(join(directory, '.tmp')), []);
  });
});

test('rejects unreferenced native JSX and React createElement import aliases with relative line diagnostics', async () => {
  await fixture(async (directory, put) => {
    await put('src/unreferenced.tsx', `import R, { createElement as element } from 'react';
      import * as ReactAlias from 'react';
      import { default as DefaultAlias } from 'react';
      const a = <select />;
      const b = <select multiple size={4}><option>One</option></select>;
      const mixed = <sElEcT />;
      const c = R.createElement('SELECT');
      const d = ReactAlias.createElement('Select');
      const e = element('sElEcT');
      const f = DefaultAlias.createElement('select');
      const g = element('div');`);
    const result = await checkNativeSelectPolicy(directory);
    assert.equal(result.diagnostics.length, 7);
    for (const [index, diagnostic] of result.diagnostics.entries()) {
      assert.match(diagnostic, new RegExp(`^src/unreferenced\\.tsx:${index + 4}:\\d+: native-select creation:`));
      assert.ok(!diagnostic.includes(directory));
    }
  });
});

test('uses actual import symbols and ignores shadowed or unrelated component and factory names', async () => {
  await fixture(async (directory, put) => {
    await put('src/view.tsx', `
      import React, { createElement as element } from 'react';
      import { NativeSelect } from './ui/native-select/NativeSelect';
      declare const dynamic: string;
      const fakeFactory = (element: (tag: string) => unknown) => element('select');
      const fakeReact = (React: { createElement: (tag: string) => unknown }) => React.createElement('select');
      const fakeSelect = (NativeSelect: (props: unknown) => unknown) => <NativeSelect wrapperClassName={dynamic} />;
      const realSelect = <NativeSelect wrapperClassName="real" />;
    `);
    assert.deepEqual((await checkNativeSelectPolicy(directory)).diagnostics, []);
  });
});

test('rejects unresolved wrapper tokens and checks every branch of statically known wrappers', async () => {
  await fixture(async (directory, put) => {
    await put('src/view.tsx', `import { NativeSelect as Choice } from './ui/native-select/NativeSelect';
      declare const dynamic: string; declare const flag: boolean;
      const a = <Choice wrapperClassName={dynamic} />;
      const b = <Choice wrapperClassName={flag ? 'good' : 'bad'} />;
      const c = <Choice wrapperClassName />;`);
    await put('src/layout.css', '.good { width: 120px }.bad { background: white }');
    const result = await checkNativeSelectPolicy(directory);
    assert.equal(result.diagnostics.filter(text => text.includes('static string')).length, 2);
    assert.equal(result.diagnostics.filter(text => text.includes('CSS ownership')).length, 1);
  });
});

test('checks literal spread and createElement component props and rejects unresolved spreads', async () => {
  await fixture(async (directory, put) => {
    await put('src/view.tsx', `import { NativeSelect as Choice } from './ui/native-select/NativeSelect';
      import { createElement as element } from 'react';
      declare const props: object; declare const dynamic: string;
      const a = <Choice {...{ value: dynamic, ...{ wrapperClassName: 'spread' } }} />;
      const b = element(Choice, {wrapperClassName: 'factory'});
      const c = <Choice {...props} />;
      const d = element(Choice, {wrapperClassName: dynamic});
      const e = element(Choice, null);`);
    await put('src/layout.css', '.spread{color:red}.factory{border:0}');
    const result = await checkNativeSelectPolicy(directory);
    assert.deepEqual(result.wrappers, ['factory', 'spread']);
    assert.equal(result.diagnostics.length, 4);
    assert.ok(result.diagnostics.some(text => text.includes('spreads must be literal')));
    assert.ok(result.diagnostics.some(text => text.includes('static string token')));
  });
});

test('allows shared presentation owners and statically resolved trigger layout aliases', async () => {
  await fixture(async (directory, put) => {
    await put('src/ui/selection-control/SelectTrigger.tsx', 'export const SelectTrigger = (props: unknown) => <button />;');
    await put('src/ui/selection-control/selection-control.css', '.selection-control { --selection-control-height:32px; font-size:var(--text-sm) }.select-trigger {height:var(--selection-control-height);background:white}.selection-control__arrow,.select-trigger__count{width:10px}');
    await put('src/view.tsx', `import { SelectTrigger as Trigger } from './ui/selection-control/SelectTrigger';
      import * as Selection from './ui/selection-control/SelectTrigger';
      import { createElement as element } from 'react';
      const narrow = 'narrow'; const alias = narrow; declare const flag: boolean;
      const a = <Trigger density="filter" layoutClassName={alias} />;
      const b = <Selection.SelectTrigger as="summary" layoutClassName={flag ? alias : 'wide'} />;
      const c = element(Trigger, {layoutClassName: 'factory'});
      const d = <Trigger {...(flag ? {layoutClassName: 'spread'} : {})} />;
      const shadow = (Trigger: any) => <Trigger className="unrelated" />;`);
    await put('src/layout.css', '.narrow{max-width:240px}.wide{width:100%}.factory{grid-column:2}.spread{margin:8px}');
    const result = await checkNativeSelectPolicy(directory);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.wrappers, ['factory', 'narrow', 'spread', 'wide']);
  });
});

test('rejects trigger skins, unresolved layout tokens and JSX/factory styling escapes', async () => {
  await fixture(async (directory, put) => {
    await put('src/ui/selection-control/SelectTrigger.tsx', 'export const SelectTrigger = (props: unknown) => <button />;');
    await put('src/view.tsx', `import { SelectTrigger as Trigger } from './ui/selection-control/SelectTrigger';
      import * as Selection from './ui/selection-control/SelectTrigger';
      import React, { createElement as element } from 'react';
      declare const dynamic: string; declare const props: object;
      const a = <Trigger className="tag-filter-trigger" style={{height:36}} />;
      const b = <Trigger layoutClassName={dynamic} />;
      const c = element(Trigger, {className:'assignee-trigger', style:{color:'red'}});
      const d = React.createElement(Selection.SelectTrigger, {layoutClassName:dynamic});
      const e = <Trigger {...props} />;
      const legacy = 'tag-filter-trigger'; const alias = legacy;
      const f = <Trigger layoutClassName={alias} />;
      const g = <Trigger {...{['class'+'Name']: 'bad', ['style']: {color:'red'}}} />;`);
    await put('src/feature.css', '.tag-filter-trigger{font-size:14px}');
    const result = await checkNativeSelectPolicy(directory);
    assert.equal(result.diagnostics.filter(text => text.includes('className/style')).length, 6);
    assert.equal(result.diagnostics.filter(text => text.includes('static string token')).length, 2);
    assert.equal(result.diagnostics.filter(text => text.includes('spreads must be literal')).length, 1);
    assert.equal(result.diagnostics.filter(text => text.includes('CSS ownership')).length, 1);
  });
});

test('keeps native internals and shared presentation owners separate without CSS exemptions', async () => {
  await fixture(async (directory, put) => {
    await put('src/ui/selection-control/selection-control.css', '.selection-control{--selection-control-height:32px}.native-select__control{font-size:14px}select{color:red}');
    await put('src/ui/native-select/native-select.css', '.native-select__control{appearance:none}.select-trigger{background:red}:root{--selection-control-height:40px}');
    await put('src/page.css', ':root{--selection-control-height:80px}.selection-control{font-size:20px}.select-trigger__count{color:red}.selection-control__arrow path{stroke:red}');
    const result = await checkNativeSelectPolicy(directory);
    assert.equal(result.diagnostics.filter(text => text.startsWith('src/ui/selection-control/selection-control.css:')).length, 2);
    assert.equal(result.diagnostics.filter(text => text.startsWith('src/ui/native-select/native-select.css:')).length, 2);
    assert.equal(result.diagnostics.filter(text => text.startsWith('src/page.css:')).length, 4);
  });
});

test('rejects appearance, mixed selector branches, internal markers and pseudo-element arrows', () => {
  for (const css of [
    '.selection-control[data-density="filter"]{height:40px}', '.select-trigger{font-size:14px}',
    '.select-trigger__label{font-weight:600}', '.select-trigger__count{padding:10px}',
    '.selection-control__arrow path{stroke-width:3}', ':is(.selection-control,.other){background:red}',
    '[class~="select-trigger__arrow"]{width:20px}', '.select-trigger{&:focus-visible{outline:none}}',
    '@scope (.selection-control){:scope{font-size:20px}}',
    'input,select,textarea{font:inherit}', '.field :is(input, select, textarea):disabled{color:gray}',
    '.native-select__control{appearance:auto}', '.native-select__arrow{width:12px}',
    '[class~="native-select__control"]{background:white}', '.layout{padding:10px}',
    '.layout::after{content:""}', '.layout:before{border:3px solid}',
    '.layout{--native-select-height:60px}', '.layout > *{color:red}',
    '.native-select{height:50px}', '.native-select :where(svg){display:none}',
    '.native\\2d select__control{color:red}', 's\\65 lect{appearance:auto}',
    '.layout{&::after{content:"";border:3px solid red}}',
    '.native-select{& > *{color:red}}', '.layout{@media(width > 1px){background:red}}',
    '.layout{& .child{& .grandchild{color:red}}}', '.native-select__control{&:disabled{color:red}}',
    '.native-select__arrow path{stroke-width:6;stroke:red}', ':is(.native-select__arrow) path{display:none}',
    '.native-select__arrow path + path{stroke:red}', '.layout > .child ~ input{color:red}',
    '.native-select__control + svg{display:none}', '.native-select__control + svg path{stroke:red}',
    '.native-select__control ~ svg{display:none}', '.native-select__control ~ svg path{stroke:red}',
    ':is(.native-select__control) + svg{display:none}', ':where(.native-select__control) ~ svg path{stroke:red}',
    '[class~="native-select__control"] + svg{display:none}',
    '.native-select__control{& + svg{display:none}}', '.native-select__control{& ~ svg path{stroke:red}}',
    ':is(.native-select__control){& + svg path{stroke:red}}',
    '.pr-toolbar select + svg{display:none}', 'select ~ svg{display:none}', 'select + svg path{stroke:red}',
    ':is(select) + svg{display:none}', ':where(select) ~ svg path{stroke:red}',
    'select{& + svg{display:none}}', 'select{& ~ svg path{stroke:red}}', ':is(select){& + svg path{stroke:red}}',
    'select + input{padding:8px}', 'select ~ span{color:red}',
    ':has(> select){background:red}', ':has(> select)::after{content:""}',
    ':has(> .native-select__control) > svg path{stroke:red}', ':has(> .native-select__arrow path){padding:8px}',
    ':has(> select + svg) > svg{display:none}', ':has(+ .native-select__arrow){appearance:auto}',
    ':has(~ select + svg){appearance:auto}', ':is(:has(> select))::after{content:""}',
    ':where(:has(> :is(select, .native-select__control))) > span{color:red}',
    ':has(> :nth-child(1 of .native-select__control)) > svg{display:none}',
    ':has(> select){&::after{content:""}}', ':has(> select){& > svg path{stroke:red}}',
    '.native-select__control{&:has(+ .native-select__arrow){color:red}}',
    ':has(+ :where(.native-select__arrow)) + span{color:red}',
    ':has(> :is(select > option)) + svg{display:none}',
    ':has(> :where(.native-select__arrow > path)){margin:8px}',
    ':has(> :is(select, option)){width:120px}', ':has(> :is(select > option, select)){margin:8px}',
    ':has(> :where(.native-select__arrow > path, select)) + svg{display:none}',
    ':has(+ :is(select > option)) + span{color:red}',
    ':has(> :has(> :is(select > option))){margin:8px}',
    ':has(> :is(.native-select__control, .native-select__arrow path)){width:120px}',
    ':has(> select, > option){width:200px}', ':has(> select, > option) + svg{display:none}',
    ':has(> .native-select__control, > :is(.native-select__arrow path)){margin:8px}',
    ':has(> select, + .native-select__arrow){width:200px}',
    ':has(> select, select){width:200px}',
    '.native-select__control option{font-size:42px}', ':nth-child(1 of .layout){background:red}',
    ':nth-last-child(2 of .native-select__control){appearance:auto}',
    '@scope (.native-select__arrow){path{stroke:red}}', '@scope (.layout){:scope::after{content:"";border:3px solid red}}',
  ]) {
    assert.ok(inspectSelectCss(css, 'src/styles.css', new Set(['layout'])).length > 0, css);
  }
});

test('allows layout, ordinary inputs, menu options, select ancestors and :has conditions', () => {
  for (const css of [
    '.layout{width:120px;min-width:0;max-inline-size:100%;margin-inline-start:8px;flex-shrink:0;grid-row:2}',
    'input,textarea{font:inherit;background:white}', '.menu [role="option"]{padding:8px}',
    '.native-select + input{margin-top:8px;padding:8px}', '.native-select ~ input{padding:8px}',
    '.native-select{& ~ input{padding:8px}}',
    '.field:has(select) input{background:white}', '.field:not(select){display:block}',
    '.field:has(> .native-select) input{background:white}',
    ':has(> select){width:120px;max-inline-size:100%;margin:8px}',
    ':has(> select) + input{padding:8px}', ':has(> select) ~ input{padding:8px}',
    ':has(> select){& + input{padding:8px}}',
    ':has(> :is(select, .native-select__arrow)){width:120px;margin:8px}',
    ':has(> select:is(option, .other)){width:120px}',
    ':has(> :has(+ .native-select__arrow)){width:120px}',
    ':has(> select, > .native-select__control){width:120px}',
    ':has(> .native-select__control, > .native-select__arrow path){margin:8px}',
    '.field:has(select, > .native-select) input{padding:8px}',
    '/* select { appearance: auto } */ .other::after{content:"select .native-select__control"}',
    '@keyframes turn{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}',
    '.layout{& + input{padding:8px}}', '.field{& input{padding:8px}& .menu [role="option"]{color:red}}',
    '.layout{@media(width > 1px){width:120px;&{margin:8px}}}',
    '@scope (.field){input{padding:8px}}',
  ]) assert.deepEqual(inspectSelectCss(css, 'src/styles.css', new Set(['layout'])), [], css);
});

test('CSS parser failures retain relative location and the parser error chain', () => {
  assert.throws(() => inspectSelectCss('select { color }', 'src/broken.css', new Set()), error => {
    assert.ok(error instanceof Error && error.cause instanceof Error);
    assert.match(error.message, /^src\/broken.css:1:\d+: CSS parse failed:/);
    return true;
  });
});

test('TypeScript parse failures fail closed and release temporary project resources', async () => {
  await fixture(async (directory, put) => {
    await put('src/broken.tsx', 'export const broken = <select');
    const result = await checkNativeSelectPolicy(directory);
    assert.ok(result.diagnostics.some(text => /^src\/broken.tsx:1:\d+: TypeScript parse failed:/.test(text)));
    assert.deepEqual(await readdir(join(directory, '.tmp')), []);
    await put('src/broken.tsx', 'export const valid = <input />;');
    assert.deepEqual((await checkNativeSelectPolicy(directory)).diagnostics, []);
  });
});

test('CSS failure after TypeScript inspection still releases the project and API', async () => {
  await fixture(async (directory, put) => {
    await put('src/broken.css', 'select { color }');
    await assert.rejects(checkNativeSelectPolicy(directory), /src\/broken.css:1:/);
    assert.deepEqual(await readdir(join(directory, '.tmp')), []);
    await put('src/broken.css', 'input { color: red }');
    assert.deepEqual((await checkNativeSelectPolicy(directory)).diagnostics, []);
  });
});

test('missing source roots and source symlinks are explicit filesystem failures', async () => {
  await fixture(async (directory) => {
    await rm(join(directory, 'src'), { recursive: true });
    await assert.rejects(checkNativeSelectPolicy(directory), error => {
      assert.ok(error instanceof Error && error.cause instanceof Error);
      assert.match(error.message, /^src:1: cannot enumerate/);
      return true;
    });
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'outside'));
    await symlink(join(directory, 'outside'), join(directory, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(checkNativeSelectPolicy(directory), /src\/linked:1: source symlinks are unsupported/);
  });
});

test('cleanup retains the primary failure, tries every release and exposes cleanup-only failures', async () => {
  const primary = new Error('AST transport failed'), release = new Error('snapshot release failed'), close = new Error('API close failed');
  const observed: string[] = [];
  await assert.rejects(withPolicyCleanup(async register => {
    register(() => { observed.push('directory'); });
    register(() => { observed.push('api'); throw close; });
    register(() => { observed.push('snapshot'); throw release; });
    throw primary;
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, release, close]);
    return true;
  });
  assert.deepEqual(observed, ['snapshot', 'api', 'directory']);
  await assert.rejects(withPolicyCleanup(async register => { register(() => { throw release; }); return true; }), error => error === release);
  await assert.rejects(withPolicyCleanup(async () => { throw primary; }), error => error === primary);
});

test('the complete production source tree satisfies native-select ownership', async () => {
  const result = await checkNativeSelectPolicy(packageDirectory);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.files > 0);
});

test('the CLI checks its own package and refuses alternate scan roots', () => {
  const script = fileURLToPath(new URL('./native-select-policy.mts', import.meta.url));
  const result = spawnSync(process.execPath, [script, '.'], { cwd: packageDirectory, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node scripts\/native-select-policy.mts/);
});
