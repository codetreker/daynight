import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';
import { login } from '../../../daynight-server/scripts/auth-fixture.mts';

const repository = fileURLToPath(new URL('../../../..', import.meta.url));
const relevant = (name: string) => /^(?:packages\/daynight-web\/|packages\/daynight-server\/|packages\/daynight\/src\/(?:api|session)\/|packages\/daynight\/src\/platform\/text\.ts$|patches\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|deployment\/(?:dev-ci|localhost)\/)/.test(name);
const fingerprint = async () => {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repository }).toString().split('\0').filter(name => name && relevant(name)).sort();
  const hash = createHash('sha256');
  for (const name of names) { hash.update(name).update('\0'); try { hash.update(await readFile(path.join(repository, name))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hash.update('<deleted>'); } hash.update('\0'); }
  return hash.digest('hex');
};
if (process.argv.includes('--fingerprint')) { console.log(await fingerprint()); process.exit(0); }

const base = process.env.DAYNIGHT_BASE_URL;
const sourceHash = process.env.DAYNIGHT_SEARCH_SOURCE_HASH;
assert.ok(base && process.env.DAYNIGHT_SEARCH_RUN_ID && process.env.DAYNIGHT_SEARCH_BINARY_SHA && process.env.DAYNIGHT_SEARCH_DB_CONTAINER && process.env.DAYNIGHT_SEARCH_DB_PORT && sourceHash, 'Run via pnpm web:acceptance and the isolated local runner.');
assert.equal(await fingerprint(), sourceHash, 'Sources changed while the production server was being built.');
const runId = process.env.DAYNIGHT_SEARCH_RUN_ID;
const output = path.join(repository, '.tmp', 'task-search-acceptance', runId);
await mkdir(output, { recursive: true });
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const binarySha256 = process.env.DAYNIGHT_SEARCH_BINARY_SHA;
const htmlResponse = await fetch(base);
assert.equal(htmlResponse.status, 200);
const html = await htmlResponse.text();
const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
assert.ok(script, 'The built page must reference its production entry.');
const asset = await fetch(new URL(script, base));
assert.equal(asset.status, 200);
const assetHash = createHash('sha256').update(new Uint8Array(await asset.arrayBuffer())).digest('hex');
const session = await login({ origin: base });
const request = async (url: string, method = 'GET', body?: unknown, expected = 200) => {
  const response = await session.request(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, expected, `${method} ${url}: ${await response.clone().text()}`);
  return response.json();
};
const user = await request('/api/v1/me');
const project = await request('/api/v1/projects', 'POST', { name: 'Search browser acceptance', repoUrl: 'https://github.com/example/search-browser-acceptance.git', expectedUserId: user.id }, 201);
const emptyProject = await request('/api/v1/projects', 'POST', { name: 'Search empty project', repoUrl: 'https://github.com/example/search-browser-empty.git', expectedUserId: user.id }, 201);
const endpoint = `/api/v1/projects/${project.id}/tasks`;
const create = async (title: string, description = '', options: Record<string, unknown> = {}) => request(endpoint, 'POST', { title, description, ...options }, 201);
const goal = await create('[Goal] Search acceptance context');
const child = await create('Quartz child', 'Child description', { dependsOn: [goal.id] });
const description = await create('Description-only match', `${'long markdown text '.repeat(20)} unique-description-quartz at the tail`);
const longTitle = await create(`${'long-title-'.repeat(20)}quartz-ending`);
const historical = await create('Quartz historical completed', '', { assignedTo: user.id });
await request(`${endpoint}/${historical.id}/status`, 'PUT', { version: historical.version, status: 'done' });
// Backdate this disposable fixture before the first sync or search, then rotate
// its history epoch just as a restored history requires.
const changed = execFileSync('docker', ['exec', '-i', process.env.DAYNIGHT_SEARCH_DB_CONTAINER, 'psql', '-X', '-q', '-t', '-A', '-p', process.env.DAYNIGHT_SEARCH_DB_PORT, '-U', 'daynight', '-d', 'daynight', '-v', 'ON_ERROR_STOP=1', '-v', `task_id=${historical.id}`, '-v', `project_id=${project.id}`], {
  input: `BEGIN;
WITH changed AS (UPDATE tasks SET created_at=statement_timestamp()-interval '31 days', updated_at=statement_timestamp()-interval '30 days', completed_at=statement_timestamp()-interval '30 days' WHERE id=:'task_id'::uuid AND project_id=:'project_id'::uuid AND status='done' AND started_at IS NULL RETURNING id) SELECT count(*) FROM changed;
UPDATE projects SET task_cache_epoch=gen_random_uuid() WHERE id=:'project_id'::uuid RETURNING id;
COMMIT;`, encoding: 'utf8', timeout: 15_000,
}).trim().split('\n');
assert.deepEqual(changed, ['1', project.id], 'Backdate exactly the intended task and rotate the project epoch.');
const aged = await request(`${endpoint}/${historical.id}`);
assert.equal(aged.status, 'done');
assert.ok(Date.parse(aged.completedAt) < Date.now() - 8 * 24 * 60 * 60 * 1000, 'Completed task must predate the normal recent window.');
assert.ok(Date.parse(aged.createdAt) <= Date.parse(aged.completedAt) && Date.parse(aged.completedAt) <= Date.parse(aged.updatedAt));
for (let index = 0; index < 17; index++) await create(`Quartz item ${String(index).padStart(2, '0')}`);
const search = (query: string, cursor: string | null = null) => request(`${endpoint}/search`, 'POST', { query, limit: 15, cursor });
const first = await search('quartz');
assert.equal(first.total, 21);
assert.equal(first.items.length, 15);
assert.ok(first.nextCursor);
const second = await search('quartz', first.nextCursor);
const expectedIds = [...first.items, ...second.items].map((item: { id: string }) => item.id);
assert.equal(new Set(expectedIds).size, 21);
assert.ok(expectedIds.includes(child.id) && expectedIds.includes(description.id) && expectedIds.includes(longTitle.id) && expectedIds.includes(historical.id));
assert.equal([...first.items, ...second.items].find((item: { id: string }) => item.id === child.id).context, null);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
const [cookieName, ...cookieValue] = session.cookie.split('=');
await context.addCookies([{ name: cookieName!, value: cookieValue.join('='), url: base, httpOnly: true, sameSite: 'Lax' }]);
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const checks: string[] = [];
const done = (label: string) => { checks.push(label); console.log(`PASS ${label}`); };
const goTasks = async (id: string, target: Page = page) => {
  await target.goto(`${base}/projects/${id}`);
  await target.getByRole('tab', { name: 'Task list' }).click();
  await expect(target.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' })).toBeVisible();
};
const submit = async (query: string) => { const input = page.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' }); await input.fill(query); await input.press('Enter'); };
try {
  await goTasks(project.id);
  await submit('quartz');
  const resultButtons = page.getByRole('button', { name: /^Open task: / });
  await expect(resultButtons).toHaveCount(15);
  const shown = await resultButtons.allTextContents();
  for (let index = 0; index < first.items.length; index++) assert.ok(shown[index]!.includes(first.items[index].title), 'UI preserves the server page order and full titles');
  await page.screenshot({ path: path.join(output, 'search-results.png'), fullPage: true });
  done('real search response order, full titles and first page');
  await page.getByRole('navigation', { name: 'Search results pagination' }).getByRole('button', { name: 'Next' }).click();
  await expect(resultButtons).toHaveCount(second.items.length);
  const nextShown = await resultButtons.allTextContents();
  for (let index = 0; index < second.items.length; index++) assert.ok(nextShown[index]!.includes(second.items[index].title));
  done('real cursor continuation and remaining results');
  await submit('quartz');
  await expect(resultButtons).toHaveCount(15);
  await request(`${endpoint}/${goal.id}`, 'PATCH', { version: goal.version, title: '[Goal] Search acceptance context updated' });
  await page.getByRole('navigation', { name: 'Search results pagination' }).getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  await expect(resultButtons).toHaveCount(15);
  done('changed project invalidates the cursor and restarts the first page');

  await page.getByRole('combobox', { name: 'Status' }).selectOption('done');
  await expect(page.getByRole('button', { name: 'Open task: Quartz historical completed' })).toBeVisible();
  await page.getByRole('button', { name: 'Assignee: Everyone' }).click();
  await page.getByRole('option', { name: 'Assigned to me' }).click();
  await expect(resultButtons).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' }).fill('unsubmitted');
  await expect(page.getByText('Results for: quartz')).toBeVisible();
  await expect(resultButtons).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Status' }).selectOption('');
  await page.getByRole('button', { name: 'Assignee: Assigned to me' }).click();
  await page.getByRole('option', { name: 'Everyone' }).click();
  done('status and assignee intersect without changing the unapplied draft');

  await submit('unique-description-quartz');
  const detailButton = page.getByRole('button', { name: 'Open task: Description-only match' });
  await expect(detailButton).toBeVisible();
  await detailButton.click();
  await expect(page.getByRole('dialog')).toContainText('unique-description-quartz');
  await page.screenshot({ path: path.join(output, 'full-detail.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(detailButton).toBeFocused();
  done('description beyond 160 characters and direct full detail with focus restoration');

  await submit('Quartz child');
  await expect(page.getByRole('button', { name: 'Open task: Quartz child' })).toBeVisible();
  await expect(page.getByText('[Goal] Search acceptance context updated')).toHaveCount(0);
  await submit('Quartz historical completed');
  await expect(page.getByRole('button', { name: 'Open task: Quartz historical completed' })).toBeVisible();
  await submit('quartz-ending');
  await expect(page.getByRole('button', { name: `Open task: ${longTitle.title}` })).toBeVisible();
  done('unassigned context, completed task and long-title tail');

  await submit('no-match-fc954b');
  await expect(page.getByText('No matching tasks', { exact: false })).toBeVisible();
  await submit('😀 AND (');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect.poll(() => page.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' }).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([7, 8]);
  done('zero results and server syntax error remain distinct');

  let fail = true;
  await page.route(`**${endpoint}/search`, async route => { if (fail) { fail = false; await route.abort('failed'); } else await route.continue(); });
  await submit('unique-description-quartz');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(detailButton).toBeVisible();
  await page.unroute(`**${endpoint}/search`);
  done('network failure and retry against the real backend');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await submit(`id:${longTitle.id}`);
    const idResult = page.getByRole('button', { name: `Open task: ${longTitle.title}` });
    await expect(idResult).toContainText(longTitle.id);
    await expect(idResult).toContainText('ID match');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `layout at ${width}px must not overflow`);
    await idResult.click();
    await expect(page.getByRole('dialog')).toContainText(longTitle.title);
    await page.keyboard.press('Escape');
    await expect(idResult).toBeFocused();
  }
  await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true });
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' })).toBeVisible();
  done('ID match and long title at 390/320px, full detail and clearing to ordinary view');

  await goTasks(emptyProject.id);
  await submit('quartz');
  await expect(page.getByText('No matching tasks', { exact: false })).toBeVisible();
  done('empty project can search');

  const isolatedContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  await isolatedContext.addCookies([{ name: cookieName!, value: cookieValue.join('='), url: base, httpOnly: true, sameSite: 'Lax' }]);
  const graphPage = await isolatedContext.newPage();
  await graphPage.route(`**/api/v1/projects/${project.id}/task-sync**`, route => route.abort('failed'));
  await goTasks(project.id, graphPage);
  await graphPage.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' }).fill('unique-description-quartz');
  await graphPage.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' }).press('Enter');
  await graphPage.getByRole('button', { name: 'Open task: Description-only match' }).click();
  await expect(graphPage.getByRole('dialog')).toContainText('unique-description-quartz');
  await isolatedContext.close();
  done('search and direct full detail while task sync continuously fails');

  assert.equal(await fingerprint(), sourceHash, 'Sources changed during acceptance.');
  await writeFile(path.join(output, 'browser.json'), JSON.stringify({ result: 'passed', runId, sourceRevision, sourceHash, binarySha256, entryAsset: script, entryAssetSha256: assetHash, browser: browser.version(), checks }, null, 2) + '\n');
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  await writeFile(path.join(output, 'browser.json'), JSON.stringify({ result: 'failed', runId, sourceRevision, sourceHash, binarySha256, entryAsset: script, entryAssetSha256: assetHash, browser: browser.version(), checks, error: String(error) }, null, 2) + '\n');
  throw error;
} finally { await context.close(); await browser.close(); }
