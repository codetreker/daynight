import type { Page } from '@playwright/test';
import { pollingIntervalsKey, type PollingIntervals } from '../../src/app/polling';

export const shortPollingInterval = 100;

export const mockPollingIntervals = async (page: Page, intervals: Partial<PollingIntervals>): Promise<void> => {
  await page.addInitScript(({ key, intervals }) => {
    Object.defineProperty(globalThis, Symbol.for(key), { value: intervals });
  }, { key: pollingIntervalsKey, intervals });
};
