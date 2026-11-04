import { functionalScenarios } from './inventory.mts';

export type FunctionalShard = { current: 1 | 2; total: 2 };

export const requireShard = (value: unknown): FunctionalShard => {
  const shard = value as Partial<FunctionalShard> | null;
  if (typeof shard !== 'object' || shard === null || Array.isArray(shard)
    || Object.keys(shard).length !== 2 || !Object.hasOwn(shard, 'current') || !Object.hasOwn(shard, 'total')
    || shard.total !== 2 || (shard.current !== 1 && shard.current !== 2)) throw new Error('Invalid functional shard; expected 1/2 or 2/2.');
  return { current: shard.current, total: shard.total };
};

export const parseShard = (value: string): FunctionalShard => {
  if (value !== '1/2' && value !== '2/2') throw new Error('Invalid functional shard; expected 1/2 or 2/2.');
  return requireShard({ current: Number(value[0]), total: 2 });
};

export const ownsSharedChecks = (shard: FunctionalShard | undefined): boolean => shard === undefined || shard.current === 2;

export const functionalArguments = (shard: FunctionalShard | undefined): string[] => [
  '--workers=1', '--retries=0',
  ...(shard === undefined ? [] : ['--fully-parallel', `--shard=${shard.current}/${shard.total}`]),
  '--grep-invert', '@capacity',
];

export const requireSelection = (value: unknown, shard: FunctionalShard | undefined): readonly string[] => {
  if (shard === undefined) {
    if (value !== undefined) throw new Error('Unsharded acceptance cannot declare a shard selection.');
    return functionalScenarios;
  }
  if (!Array.isArray(value) || value.length !== (shard.current === 1 ? Math.ceil(functionalScenarios.length / 2) : Math.floor(functionalScenarios.length / 2))
    || value.some((name) => typeof name !== 'string' || !functionalScenarios.includes(name as typeof functionalScenarios[number]))
    || new Set(value).size !== value.length) throw new Error('Functional shard selection is incomplete, duplicated or unknown.');
  return value;
};

export const readFunctionalCollection = (value: unknown, shard: FunctionalShard | undefined): readonly string[] => {
  const report = value as { config?: { workers?: unknown; fullyParallel?: unknown; shard?: unknown; projects?: unknown };
    errors?: unknown; suites?: unknown } | null;
  if (typeof report !== 'object' || report === null || Array.isArray(report) || !Array.isArray(report.errors) || report.errors.length !== 0
    || !Array.isArray(report.suites) || report.config?.workers !== 1 || report.config.fullyParallel !== true
    || !Array.isArray(report.config.projects) || report.config.projects.length !== 1) throw new Error('Invalid functional collection report.');
  const project = report.config.projects[0] as { retries?: unknown; repeatEach?: unknown } | null;
  if (project?.retries !== 0 || project.repeatEach !== 1) throw new Error('Functional collection requires zero retries and one repetition.');
  if (shard === undefined) {
    if (report.config.shard !== null) throw new Error('Complete functional collection must be unsharded.');
  } else {
    const collected = requireShard(report.config.shard);
    if (collected.current !== shard.current) throw new Error('Functional collection belongs to a different shard.');
  }
  const names: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid functional collection suite.');
    const suite = value as { specs?: unknown; suites?: unknown };
    if (suite.specs !== undefined) {
      if (!Array.isArray(suite.specs)) throw new Error('Invalid functional collection specs.');
      for (const value of suite.specs) {
        const spec = value as { tests?: unknown } | null;
        if (typeof spec !== 'object' || spec === null || !Array.isArray(spec.tests) || spec.tests.length !== 1) throw new Error('Functional collection requires exactly one test per case.');
        const test = spec.tests[0] as { expectedStatus?: unknown; annotations?: unknown; results?: unknown } | null;
        if (test?.expectedStatus !== 'passed' || !Array.isArray(test.annotations) || !Array.isArray(test.results) || test.results.length !== 0) {
          throw new Error('Functional collection contains a skipped, failed or executed case.');
        }
        const scenarios = test.annotations.filter((value) => typeof value === 'object' && value !== null && value.type === 'scenario');
        if (scenarios.length !== 1 || typeof scenarios[0].description !== 'string') throw new Error('Functional collection requires one scenario annotation per case.');
        names.push(scenarios[0].description);
      }
    }
    if (suite.suites !== undefined) {
      if (!Array.isArray(suite.suites)) throw new Error('Invalid functional collection children.');
      suite.suites.forEach(visit);
    }
  };
  report.suites.forEach(visit);
  if (shard === undefined) {
    if (names.length !== functionalScenarios.length || new Set(names).size !== names.length
      || functionalScenarios.some((name) => !names.includes(name))) throw new Error('Complete functional collection differs from the canonical inventory.');
    return names;
  }
  return requireSelection(names, shard);
};
