export type PollingIntervals = {
  readonly taskSync: number;
};

export const pollingIntervalsKey = 'daynight.pollingIntervals';
const defaults: PollingIntervals = { taskSync: 15_000 };

export const pollingInterval = (name: keyof PollingIntervals): number => {
  const overrides: unknown = Reflect.get(globalThis, Symbol.for(pollingIntervalsKey));
  if (overrides === undefined) return defaults[name];
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) throw new Error('Invalid polling intervals.');
  for (const key of Reflect.ownKeys(overrides)) {
    const value: unknown = Reflect.get(overrides, key);
    if (typeof key !== 'string' || !Object.hasOwn(defaults, key) || typeof value !== 'number'
      || !Number.isInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('Invalid polling intervals.');
  }
  return Object.hasOwn(overrides, name) ? Reflect.get(overrides, name) as number : defaults[name];
};
