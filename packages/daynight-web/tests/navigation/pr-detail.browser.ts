import { expect, test } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000011';
const projectId = '00000000-0000-4000-8000-000000000031';
const path = `/api/v1/projects/${projectId}/pull-requests/1248`;
const text = Array.from({ length: 36 }, (_, index) => `Paragraph ${index + 1}: readable content with a long branch and Unicode 中文🙂.`).join('\n\n');
const longCode = 'const longValue = "' + 'content'.repeat(60) + '";';
const description = `## Description heading\n\n${text}\n\n| A | B |\n| - | - |\n| ${'wide'.repeat(60)} | value |\n\n\`\`\`ts\n${longCode}\n\`\`\`\n\n![remote image](https://pr-image.invalid/image.png)\n\n<script>window.prInjected = true</script><iframe src="https://pr-image.invalid/frame"></iframe>\n\n\`\`\`mermaid\nflowchart LR\nA-->B\n\`\`\`\n\n[GitHub](https://github.com/codetreker/daynight)`;
const fixture = (revision: number) => ({
  number: '1248', id: '9007199254740993', url: 'https://github.com/codetreker/daynight/pull/1248',
  title: revision === 1 ? 'Initial PR title' : 'Updated PR title', author: { id: '42', login: 'author' },
  state: 'open', draft: false, base: { repositoryId: '10', repositoryFullName: 'codetreker/daynight', ref: 'main' },
  head: { repositoryId: '11', repositoryFullName: 'other/daynight', ref: 'long-branch', sha: '1234567890123456789012345678901234567890' },
  createdAt: '2026-11-12T09:00:00Z', updatedAt: '2026-11-13T14:29:10Z', closedAt: null, mergedAt: null,
  observedAt: '2026-11-13T14:32:18Z', revision: String(revision), description,
});

for (const width of [1280, 320]) for (const locale of ['en', 'zh-CN'] as const) {
  test(`real PR dialog retains its reading state through refresh at ${width}px (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    let reads = 0;
    const unexpected: string[] = [], external: string[] = [];
    await page.route('https://pr-image.invalid/**', route => { external.push(route.request().url()); return route.abort(); });
    await page.route('**/api/v1/**', route => {
      const request = route.request();
      if (new URL(request.url()).pathname !== path || request.method() !== 'GET') {
        unexpected.push(`${request.method()} ${request.url()}`);
        return route.abort();
      }
      reads++;
      return route.fulfill({ json: fixture(reads), headers: { 'Daynight-User-ID': userId } });
    });
    await page.goto(`/tests/navigation/pr-detail-browser.html?locale=${locale}`);
    const opener = page.getByRole('button', { name: 'Open PR' });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Initial PR title' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Description heading' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const table = dialog.getByRole('region', { name: locale === 'en' ? 'Description table' : 'Description 表格' });
    const code = dialog.getByRole('region', { name: locale === 'en' ? 'Code' : '代码' }).filter({ hasText: longCode });
    await expect(table).toHaveAttribute('tabindex', '0'); await expect(code).toHaveAttribute('tabindex', '0');
    if (width === 320) {
      expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      expect(await code.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      await table.focus(); await page.keyboard.press('ArrowRight');
      await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    }
    expect(await dialog.locator('iframe, script, img[src^="https:"], img[src^="http:"]').count()).toBe(0);
    const diagram = dialog.locator('.mermaid-diagram img');
    await expect(diagram).toHaveCount(1, { timeout: 45_000 });
    await expect.poll(() => diagram.evaluate(async image => {
      const img = image as HTMLImageElement;
      try { await img.decode(); } catch { return false; }
      return img.src.startsWith('blob:') && img.naturalWidth > 0 && img.naturalHeight > 0;
    }), { timeout: 45_000 }).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { prInjected?: boolean }).prInjected)).toBeUndefined();
    expect(external).toEqual([]);
    const github = dialog.getByRole('link', { name: locale === 'en' ? /View on GitHub/ : /在 GitHub 查看/ });
    await expect(github).toHaveAttribute('href', 'https://github.com/codetreker/daynight/pull/1248');
    await expect(github).toHaveAttribute('target', '_blank');
    await expect(github).toHaveAttribute('rel', 'noopener noreferrer');

    const raw = dialog.getByRole('checkbox');
    await raw.check();
    await expect(dialog.locator('img, iframe, script')).toHaveCount(0);
    await expect(raw).toBeFocused();
    await expect(dialog.getByText('Paragraph 36:', { exact: false })).toBeAttached();
    const body = dialog.locator('.dialog-body');
    const before = await body.evaluate(element => { element.scrollTop = Math.floor(element.scrollHeight / 2); return element.scrollTop; });
    expect(before).toBeGreaterThan(0);
    await page.evaluate(() => (window as unknown as { refreshPrDetail: () => void }).refreshPrDetail());
    await expect(dialog.getByRole('heading', { name: 'Updated PR title' })).toBeVisible();
    expect(reads).toBe(2);
    await expect(raw).toBeChecked();
    await expect(raw).toBeFocused();
    expect(await body.evaluate(element => element.scrollTop)).toBe(before);
    expect(external).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(dialog.getByRole('heading', { name: 'Updated PR title' })).toBeVisible();
    await dialog.getByRole('button', { name: locale === 'en' ? 'Close pull request details' : '关闭 PR 详情' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(unexpected).toEqual([]);
  });
}

test('a very long title remains readable without hiding the body or GitHub link on a short phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 500 });
  const title = '长'.repeat(256);
  await page.route('**/api/v1/**', route => {
    expect(new URL(route.request().url()).pathname).toBe(path);
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: { ...fixture(1), title }, headers: { 'Daynight-User-ID': userId } });
  });
  await page.goto('/tests/navigation/pr-detail-browser.html');
  await page.getByRole('button', { name: 'Open PR' }).click();
  const dialog = page.getByRole('dialog'), heading = dialog.getByRole('heading', { name: title });
  await expect(heading).toHaveText(title);
  const header = dialog.locator('.dialog-header');
  const titleEndVisible = await header.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    const node = element.querySelector('h2')!.firstChild!, range = document.createRange();
    range.setStart(node, node.textContent!.length - 1); range.setEnd(node, node.textContent!.length);
    const character = range.getBoundingClientRect(), viewport = element.getBoundingClientRect();
    return element.scrollTop > 0 && character.top >= viewport.top && character.bottom <= viewport.bottom;
  });
  expect(titleEndVisible).toBe(true);
  const body = dialog.locator('.dialog-body');
  expect(await body.evaluate(element => element.clientHeight)).toBeGreaterThan(0);
  const raw = dialog.getByRole('checkbox', { name: 'Raw Markdown' });
  await raw.scrollIntoViewIfNeeded();
  await raw.check();
  await expect(raw).toBeChecked();
  const github = dialog.getByRole('link', { name: /View on GitHub/ });
  await expect(github).toBeInViewport();
  await expect(github).toHaveAttribute('href', 'https://github.com/codetreker/daynight/pull/1248');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
