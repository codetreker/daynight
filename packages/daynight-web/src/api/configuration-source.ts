import { jsonContainerSources, jsonObjectSources } from './json-source';
import type { WorkerConfigurationResource, WorkerConfigurationValue } from './worker-configuration';

export type ConfigurationDocument = { readonly source: string; readonly known: WorkerConfigurationResource };
export type ConfigurationBaseline = { readonly revision: string; readonly valueSource: string; readonly known: WorkerConfigurationValue };
export type ConfigurationSubmission = { readonly baseline: ConfigurationBaseline; readonly valueSource: string; readonly known: WorkerConfigurationValue };

// Validate the whole response before inspecting source spans. Maps avoid treating
// special property names as JavaScript object mutations.
export const validateConfigurationSource = (source: string): unknown => {
  const parsed: unknown = JSON.parse(source);
  const visit = (text: string, depth: number): void => {
    const value = text.trim();
    if (value[0] !== '{' && value[0] !== '[') return;
    if (depth > 64) throw new SyntaxError('Configuration JSON exceeds maximum depth');
    if (value[0] === '[') {
      for (const child of jsonContainerSources(value)) visit(child, depth + 1);
      return;
    }
    const seen = new Set<string>();
    for (const field of jsonContainerSources(value)) {
      const end = (() => { let i = 1; while (field[i] !== '"') i += field[i] === '\\' ? 2 : 1; return i + 1; })();
      const key: string = JSON.parse(field.slice(0, end));
      if (seen.has(key)) throw new SyntaxError('Duplicate configuration JSON key');
      seen.add(key);
      visit(field.slice(end).trimStart().slice(1), depth + 1);
    }
  };
  visit(source, 1);
  return parsed;
};

export const decodeConfigurationDocument = (source: string, parseKnown: (value: unknown) => WorkerConfigurationResource): ConfigurationDocument =>
  decodeDocument(source, parseKnown);

const decodeDocument = (source: string, parseKnown: (value: unknown) => WorkerConfigurationResource): ConfigurationDocument => {
  const parsed = validateConfigurationSource(source);
  const fields = (value: string | undefined): ReadonlyMap<string, string> => value?.trim().startsWith('{') ? jsonObjectSources(value) : new Map();
  const exactNumber = (value: string | undefined): void => {
    if (value === undefined || !/^-?\d/.test(value.trim())) return;
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || numberTuple(value.trim()) !== numberTuple(JSON.stringify(parsed))) throw new SyntaxError('Inexact known configuration number');
  };
  const root = fields(source), desired = fields(root.get('desired')), value = fields(desired.get('value'));
  for (const key of ['maxConcurrent', 'pollIntervalMs', 'recoveryLimit']) exactNumber(value.get(key));
  const observation = fields(root.get('observation')), items = observation.get('items');
  if (items?.trim().startsWith('[')) for (const item of jsonContainerSources(items)) {
    const entry = fields(item), key = fields(entry.get('key')).get('kind');
    if (key !== undefined && ['maxConcurrent', 'pollIntervalMs', 'recoveryLimit'].includes(JSON.parse(key))) exactNumber(entry.get('appliedValue'));
  }
  return { source, known: parseKnown(parsed) };
};

export const configurationBaseline = (document: ConfigurationDocument): ConfigurationBaseline | null => {
  if (document.known.desired === null) return null;
  const desired = jsonObjectSources(document.source).get('desired');
  if (desired === undefined || desired.trim() === 'null') throw new SyntaxError('Missing desired source');
  const valueSource = jsonObjectSources(desired).get('value');
  if (valueSource === undefined) throw new SyntaxError('Missing configuration value source');
  return { revision: document.known.desired.revision, valueSource, known: document.known.desired.value };
};

const objectSource = (values: ReadonlyMap<string, string>): string => `{${[...values].map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`;
const arraySource = (values: readonly string[]): string => `[${values.join(',')}]`;
const sourceObject = (source: string): Map<string, string> => new Map(jsonObjectSources(source));
const setKnown = (map: Map<string, string>, key: string, value: unknown): void => {
  if (value === undefined) map.delete(key); else map.set(key, JSON.stringify(value));
};
const mergeMembers = (source: string, value: object, keys: readonly string[]): string => {
  const result = sourceObject(source);
  const fields = value as Record<string, unknown>;
  for (const key of keys) setKnown(result, key, fields[key]);
  return objectSource(result);
};
const projectId = (source: string): string => String(JSON.parse(jsonObjectSources(source).get('projectId')!)).toLowerCase();
const tools = ['codex', 'copilot'] as const;

export const configurationBaselinesCompatible = (baseline: ConfigurationBaseline, observed: ConfigurationBaseline | null): boolean => {
  if (observed === null || baseline.revision !== observed.revision) return true;
  return configurationValueSourcesEqual(baseline.valueSource, observed.valueSource);
};

// Negotiated projections can reveal omitted fields without changing the target.
// Only a response for the same revision can supply those missing facts.
export const enrichConfigurationBaseline = (baseline: ConfigurationBaseline, observed: ConfigurationBaseline | null): ConfigurationBaseline => {
  if (observed === null || baseline.revision !== observed.revision || !configurationBaselinesCompatible(baseline, observed)) return baseline;
  const original = sourceObject(baseline.valueSource), incoming = sourceObject(observed.valueSource);
  let known = baseline.known;
  for (const key of ['toolPaths'] as const) {
    const source = incoming.get(key);
    if (!original.has(key) && source !== undefined && observed.known[key] !== undefined) {
      original.set(key, source);
      known = { ...known, [key]: observed.known[key] };
    }
  }
  return { ...baseline, known, valueSource: objectSource(original) };
};

export const mergeConfigurationDraft = (baseline: ConfigurationBaseline, known: WorkerConfigurationValue): ConfigurationSubmission => {
  const root = sourceObject(baseline.valueSource);
  for (const key of ['maxConcurrent', 'pollIntervalMs', 'recoveryLimit', 'preferPlatformSpecificTasks'] as const) setKnown(root, key, known[key]);
  root.delete('agentControlMode');
  root.set('native', mergeMembers(root.get('native')!, known.native, ['agent', 'model', 'args']));
  const projects = new Map(jsonContainerSources(root.get('projects')!).map(source => [projectId(source), source]));
  root.set('projects', arraySource(known.projects.map(project => {
    const old = projects.get(project.projectId.toLowerCase());
    if (old === undefined) return JSON.stringify(project);
    const fields = sourceObject(old);
    fields.set('projectId', JSON.stringify(project.projectId));
    fields.set('nativeOverrides', mergeMembers(fields.get('nativeOverrides')!, project.nativeOverrides, ['agent', 'model', 'args']));
    return objectSource(fields);
  })));
  if (known.toolPaths === undefined) root.delete('toolPaths');
  else {
    const source = root.get('toolPaths');
    const result = source === undefined || !source.trim().startsWith('{') ? new Map<string, string>() : sourceObject(source);
    result.delete('herdr');
    for (const tool of tools) {
      const next = known.toolPaths[tool], old = result.get(tool);
      if (next === null || old === undefined || old.trim() === 'null') { result.set(tool, JSON.stringify(next)); continue; }
      const fields = sourceObject(old);
      const previousKind: unknown = JSON.parse(fields.get('kind')!);
      if (previousKind !== next.kind) fields.delete('path');
      fields.set('kind', JSON.stringify(next.kind));
      if (next.kind === 'path') fields.set('path', JSON.stringify(next.path));
      result.set(tool, objectSource(fields));
    }
    root.set('toolPaths', objectSource(result));
  }
  return { baseline, valueSource: objectSource(root), known };
};

const numberTuple = (text: string): string => {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)!;
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  if (digits === '') return '0';
  const trailing = /0*$/.exec(digits)![0].length;
  digits = digits.slice(0, digits.length - trailing);
  const exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length) + BigInt(trailing);
  return `${match[1]}${digits}e${exponent}`;
};
const equivalent = (left: string, right: string, projects = false, projectEntity = false): boolean => {
  left = left.trim(); right = right.trim();
  if (left[0] === '{' && right[0] === '{') {
    const a = jsonObjectSources(left), b = jsonObjectSources(right);
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      const other = b.get(key);
      if (other === undefined) return false;
      if (projectEntity && key === 'projectId') {
        if (String(JSON.parse(value)).toLowerCase() !== String(JSON.parse(other)).toLowerCase()) return false;
      } else if (!equivalent(value, other, projects && key === 'projects')) return false;
    }
    return true;
  }
  if (left[0] === '[' && right[0] === '[') {
    let a = jsonContainerSources(left), b = jsonContainerSources(right);
    if (a.length !== b.length) return false;
    if (projects) {
      a = [...a].sort((x, y) => projectId(x).localeCompare(projectId(y)));
      b = [...b].sort((x, y) => projectId(x).localeCompare(projectId(y)));
    }
    return a.every((value, i) => equivalent(value, b[i]!, false, projects));
  }
  if (/^-?\d/.test(left) && /^-?\d/.test(right)) return numberTuple(left) === numberTuple(right);
  return JSON.parse(left) === JSON.parse(right);
};
export const configurationValueSourcesEqual = (left: string, right: string, options?: { readonly toolPaths?: boolean }): boolean => {
  validateConfigurationSource(left); validateConfigurationSource(right);
  if (options !== undefined) {
    const project = (source: string): string => {
      const fields = sourceObject(source);
      if (options.toolPaths === false) fields.delete('toolPaths');
      return objectSource(fields);
    };
    left = project(left); right = project(right);
  }
  return equivalent(left, right, true);
};
export const encodeConfigurationPut = (submission: ConfigurationSubmission): string => {
  validateConfigurationSource(submission.valueSource);
  return `{"revision":${JSON.stringify(submission.baseline.revision)},"value":${submission.valueSource}}`;
};
