import { expect, type Locator } from '@playwright/test';

/** Check painted controls: layout-only containers may not generate a CSS box. */
export const expectTaskStatusLayout = async (surface: Locator): Promise<void> => {
  await expect.poll(() => surface.locator('.task-detail-status-row').evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const controls = Array.from(row.querySelectorAll('.task-status-trigger, .task-assignee-field, .task-platform-select, .task-detail-ready, .task-detail-blocked, .task-detail-execution-mode, .task-automation-control'))
      .map((element) => element.getBoundingClientRect());
    const automation = row.querySelector('.task-automation-control')!.getBoundingClientRect();
    const contained = controls.every((box) => box.width > 0 && box.height > 0 && box.left >= bounds.left - .5 && box.right <= bounds.right + .5);
    const separated = controls.every((box, index) => controls.slice(index + 1).every((other) =>
      box.right <= other.left + .5 || other.right <= box.left + .5 || box.bottom <= other.top + .5 || other.bottom <= box.top + .5));
    const ordered = innerWidth > 600 || controls.every((box, index) => index === 0 || box.top >= controls[index - 1]!.bottom - .5
      || (Math.abs(box.top + box.height / 2 - controls[index - 1]!.top - controls[index - 1]!.height / 2) <= 1 && box.left >= controls[index - 1]!.right - .5));
    const lines: number[] = [];
    for (const box of controls) {
      const center = box.top + box.height / 2;
      if (!lines.some((line) => Math.abs(line - center) <= 1)) lines.push(center);
    }
    const compact = innerWidth > 600 || innerHeight <= 500 || lines.length <= (document.documentElement.lang === 'en' && innerWidth <= 320 ? 3 : 2);
    return contained && separated && ordered && compact && Math.abs(bounds.right - automation.right) <= .5
      && row.scrollWidth <= row.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  }), { message: 'Status controls remain ordered, visible and separate, with compact phone rows and right-aligned automation' }).toBe(true);
};
