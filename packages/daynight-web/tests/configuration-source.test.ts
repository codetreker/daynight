import { describe, expect, it } from 'vitest';
import { configurationBaseline, configurationValueSourcesEqual, decodeConfigurationDocument, encodeConfigurationPut, mergeConfigurationDraft, validateConfigurationSource } from '../src/api/configuration-source';
import { configurationResource, configurationValue } from './helpers/worker-configuration';

const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const valueSource = `{
  "maxConcurrent":2,"pollIntervalMs":60000,"recoveryLimit":3,"preferPlatformSpecificTasks":false,
  "future": {"n":-900719925474099312345.001e+100,"__proto__":{"x":1},"list":[1,null,{"kind":"future"}]},
  "agentControlMode":null,
  "native":{"agent":"codex","model":null,"args":[],"futureNative":123456789012345678901},
  "projects":[{"projectId":"${a}","nativeOverrides":{"agent":"claude","futureOverride":-1.25e-9},"futureProject":true},
    {"projectId":"${b}","nativeOverrides":{},"removedFuture":42}],
  "toolPaths":{"codex":{"kind":"path","path":"/old","futureChoice":7},"copilot":null,"herdr":{"kind":"auto"},"futureTool":{"kind":"later","n":9007199254740993}}
}`;
const known = { ...configurationValue(), projects: [{ projectId: a, nativeOverrides: { agent: 'claude' as const } }, { projectId: b, nativeOverrides: {} }], toolPaths: { codex: { kind: 'path' as const, path: '/old' }, copilot: null } };
const document = () => decodeConfigurationDocument(`{"desired":{"revision":"9","value":${valueSource}}}`, () => configurationResource('9', known));

describe('configuration source', () => {
  it('rejects duplicate decoded keys and depth beyond 64', () => {
    expect(() => validateConfigurationSource('{"nested":{"a":1,"\\u0061":2}}')).toThrow();
    expect(() => validateConfigurationSource(`${'['.repeat(64)}0${']'.repeat(64)}`)).not.toThrow();
    expect(() => validateConfigurationSource(`${'['.repeat(65)}0${']'.repeat(65)}`)).toThrow();
    expect(() => validateConfigurationSource('{bad')).toThrow();
  });

  it('rejects known integer values that round during native parsing', () => {
    const parse = () => configurationResource();
    expect(() => decodeConfigurationDocument('{"desired":{"value":{"maxConcurrent":1.00000000000000001}}}', parse)).toThrow();
    expect(() => decodeConfigurationDocument('{"observation":{"items":[{"key":{"kind":"recoveryLimit"},"appliedValue":1.00000000000000001}]}}', parse)).toThrow();
    expect(() => decodeConfigurationDocument('{"desired":{"value":{"maxConcurrent":1e0,"unknown":9007199254740993}}}', parse)).not.toThrow();
  });

  it('merges known edits by entity while retaining raw unknown content', () => {
    const baseline = configurationBaseline(document())!;
    const edited = { ...known, maxConcurrent: 4, native: { ...known.native, model: 'new' }, projects: [{ projectId: a, nativeOverrides: {} }], toolPaths: { ...known.toolPaths, codex: { kind: 'auto' as const } } };
    const body = encodeConfigurationPut(mergeConfigurationDraft(baseline, edited));
    expect(body).toContain('"revision":"9"');
    expect(body).toContain('-900719925474099312345.001e+100');
    expect(body).toContain('"__proto__":{"x":1}');
    expect(body).toContain('"futureNative":123456789012345678901');
    expect(body).toContain('"futureOverride":-1.25e-9');
    expect(body).toContain('"futureProject":true');
    expect(body).not.toContain('"removedFuture"');
    expect(body).toContain('"futureTool":{"kind":"later","n":9007199254740993}');
    expect(body).toContain('"codex":{"kind":"auto","futureChoice":7}');
    expect(body).not.toContain('"herdr"');
    expect(body).not.toContain('"agentControlMode"');
    expect(body).not.toContain('"path":"/old"');
    expect(body).not.toContain('"agent":"claude"');
  });

  it('removes unsupported legacy fields and constructs new entities without unknowns', () => {
    const baseline = configurationBaseline(document())!;
    const edited = { ...configurationValue(), projects: [{ projectId: b, nativeOverrides: {} }, { projectId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', nativeOverrides: {} }] };
    const result = mergeConfigurationDraft(baseline, edited).valueSource;
    expect(result).not.toContain('"agentControlMode"');
    expect(result).toContain('"toolPaths":{"codex":null,"copilot":null');
    expect(result).not.toContain('"herdr"');
    expect(result).not.toContain('"futureProject"');
    expect(result).toContain('"removedFuture":42');
    expect(result).toContain('"projectId":"cccccccc-cccc-cccc-cccc-cccccccccccc","nativeOverrides":{}');
  });

  it('compares precise numbers and aligned projects while keeping other arrays ordered', () => {
    const left = `{"n":1000,"large":9007199254740993,"x":[1,2],"projects":[{"projectId":"${a.toUpperCase()}","v":-0.00},{"projectId":"${b}","v":0.01}]}`;
    const right = `{"projects":[{"v":1e-2,"projectId":"${b}"},{"v":0,"projectId":"${a}"}],"x":[1,2],"large":9007199254740993.0,"n":1e3}`;
    expect(configurationValueSourcesEqual(left, right)).toBe(true);
    expect(configurationValueSourcesEqual(left, right.replace('9007199254740993.0', '9007199254740992'))).toBe(false);
    expect(configurationValueSourcesEqual(left, right.replace('[1,2]', '[2,1]'))).toBe(false);
    expect(configurationValueSourcesEqual('{"x":1e999999999999999999}', '{"x":10e999999999999999998}')).toBe(true);
    expect(configurationValueSourcesEqual('{"future":{"projects":[1,2]}}', '{"future":{"projects":[2,1]}}')).toBe(false);
    expect(configurationValueSourcesEqual('{"toolPaths":{"future":1},"n":2}', '{"n":2}', { toolPaths: false })).toBe(true);
    expect(configurationValueSourcesEqual('{"toolPaths":{"future":1},"n":2}', '{"n":2}')).toBe(false);
  });

  it('merges filter members without losing future source and compares filter semantics', () => {
    const filter = { names: ['Backend', 'urgent'], match: 'all' as const };
    const knownFilter = { ...known, taskTagFilter: filter };
    const source = valueSource.replace('"future": {', '"taskTagFilter":{"names":["urgent","Backend"],"match":"all","future":9007199254740993},"future": {');
    const baseline = configurationBaseline(decodeConfigurationDocument(`{"desired":{"revision":"9","value":${source}}}`, () => configurationResource('9', knownFilter)))!;
    const unchanged = mergeConfigurationDraft(baseline, { ...knownFilter, taskTagFilter: { names: ['backend', 'URGENT'], match: 'all' } }).valueSource;
    expect(unchanged).toContain('"taskTagFilter":{"names":["urgent","Backend"],"match":"all","future":9007199254740993}');
    const edited = mergeConfigurationDraft(baseline, { ...knownFilter, taskTagFilter: { names: ['new'], match: 'any' } }).valueSource;
    expect(edited).toContain('"taskTagFilter":{"names":["new"],"match":"any","future":9007199254740993}');
    const left = '{"taskTagFilter":{"names":["Backend","urgent"],"match":"all","future":9007199254740993}}';
    const right = '{"taskTagFilter":{"names":["URGENT","backend","backend"],"match":"all","future":9007199254740993}}';
    expect(configurationValueSourcesEqual(left, right)).toBe(false);
    expect(configurationValueSourcesEqual(left, right, { semanticTagFilter: true })).toBe(true);
    expect(configurationValueSourcesEqual(left, right.replace('9007199254740993', '9007199254740992'), { semanticTagFilter: true })).toBe(false);
    expect(configurationValueSourcesEqual(left, right.replace('"all"', '"any"'), { semanticTagFilter: true })).toBe(false);
    expect(configurationValueSourcesEqual(left, '{}')).toBe(false);
  });
});
