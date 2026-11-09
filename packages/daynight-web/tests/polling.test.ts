import { afterEach, describe, expect, it } from 'vitest';
import { pollingInterval, pollingIntervalsKey } from '../src/app/polling';

const key = Symbol.for(pollingIntervalsKey);
afterEach(() => { Reflect.deleteProperty(globalThis, key); });

describe('polling intervals', () => {
  it('uses the production task-sync period without an override', () => {
    expect(pollingInterval('taskSync')).toBe(15_000);
  });

  it('replaces only the named polling periods', () => {
    Reflect.set(globalThis, key, { taskSync: 100 });
    expect(pollingInterval('taskSync')).toBe(100);
    Reflect.set(globalThis, key, { taskSync: 200 });
    expect(pollingInterval('taskSync')).toBe(200);
  });

  it.each([null, [], 100, '100', { taskSync: undefined }, { taskSync: 0 }, { taskSync: -1 }, { taskSync: 0.5 },
    { taskSync: Number.NaN }, { taskSync: Number.POSITIVE_INFINITY }, { taskSync: 2_147_483_648 },
    { requestTimeout: 100 }, { [Symbol('unknown')]: 100 }, { sessionSummary: 100 }])('rejects invalid overrides %j', (overrides) => {
    Reflect.set(globalThis, key, overrides);
    expect(() => pollingInterval('taskSync')).toThrow('Invalid polling intervals.');
  });
});
