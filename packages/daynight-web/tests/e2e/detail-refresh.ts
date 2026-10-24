import type { Locator, Page } from '@playwright/test';
import { authenticatedAPI } from './authentication';
import { expect } from './fixtures';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const within = async <T,>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 15_000);
    })]);
  } finally { clearTimeout(timer); }
};
const bounds = (elements: Locator) => elements.evaluateAll((nodes) => nodes.map((element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { className: element.className, x, y, width, height };
}));
type Geometry = Awaited<ReturnType<typeof bounds>>;
const expectSameBounds = (before: Geometry, actual: Geometry, phase: string): void => {
  expect(actual.map(({ className }) => className), `${phase}: same visible reading elements`).toEqual(before.map(({ className }) => className));
  for (const [index, original] of before.entries()) {
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(actual[index]![dimension] - original[dimension]), `${phase}: ${original.className} ${dimension}`).toBeLessThanOrEqual(1);
    }
  }
};

export const expectStableAutomaticDetailRefresh = async (
  page: Page,
  projectId: string,
  taskId: string,
  advance: () => Promise<void>,
  expectRetainedState: () => Promise<void>,
  contentChanged = true,
) => {
  const elements = page.locator('.task-detail-heading,.task-detail-title,.task-detail-tabs,.task-detail-panel:not([hidden])');
  const nodes = await elements.elementHandles();
  const before = await bounds(elements);
  const previousReceipt = await page.locator('.snapshot-time time').getAttribute('datetime');
  expect(before).toHaveLength(4);
  const fetched = deferred();
  const release = deferred();
  const finished = deferred();
  const path = `/api/v1/projects/${projectId}/tasks/${taskId}`;
  const pattern = `**${path}`;
  let reads = 0;
  const handler: Parameters<Page['route']>[1] = async (route) => {
    reads++;
    try {
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200);
      fetched.resolve();
      await within(release.promise, 'version-driven automatic detail response release');
      await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
    } finally { finished.resolve(); }
  };
  await page.route(pattern, handler);
  try {
    await expectRetainedState();
    const response = contentChanged ? page.waitForResponse((response) => new URL(response.url()).pathname === path) : null;
    await advance();
    await expect(page.locator('.snapshot-time time')).not.toHaveAttribute('datetime', previousReceipt!);
    if (contentChanged) await within(fetched.promise, 'version-driven automatic detail GET');
    // Advance rendering frames while the real response stays gated; settled-only checks miss transient shifts.
    await page.clock.runFor(32);
    const during = await bounds(elements);
    expectSameBounds(before, during, contentChanged ? 'pending detail response' : 'unchanged summary receipt');
    await expectRetainedState();
    release.resolve();
    if (response !== null) {
      await within(finished.promise, 'version-driven automatic detail response completion');
      expect((await response).status()).toBe(200);
      expect(await (await response).finished()).toBeNull();
    }
    await page.clock.runFor(32);
    const after = await bounds(elements);
    expectSameBounds(before, after, contentChanged ? 'completed detail response' : 'unchanged summary applied');
    await expectRetainedState();
    for (const [index, node] of nodes.entries()) {
      expect(await node.evaluate((element, index) => element.isConnected && element === document.querySelectorAll('.task-detail-heading,.task-detail-title,.task-detail-tabs,.task-detail-panel:not([hidden])')[index], index)).toBe(true);
    }
    expect(reads, contentChanged ? 'An own-version change reads the full task detail exactly once' : 'An unchanged summary receipt reuses the admitted detail without a GET').toBe(contentChanged ? 1 : 0);
    return { viewport: page.viewportSize(), before, during, after, reads, contentChanged };
  } finally {
    release.resolve();
    if (reads > 0) await within(finished.promise, 'automatic detail route cleanup');
    await page.unroute(pattern, handler);
    await Promise.all(nodes.map((node) => node.dispose()));
  }
};
