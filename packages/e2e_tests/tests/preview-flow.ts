import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { cli, expect, topology } from './fixtures.ts';
import { hasPaintedPdfMarker, readPdfPixels } from './pdf-pixels.ts';

// Normal product journey; HTTP refusal and recovery matrices belong to module tests.
export const verifyPreviewFlow = async (page: Page, projectId: string, taskIds: string[]): Promise<void> => {
  const cookies = await page.context().cookies();
  expect(cookies.some(cookie => cookie.name === '__Host-daynight_session')).toBe(true);
  expect(cookies.some(cookie => cookie.name === '__Secure-daynight_preview_session')).toBe(true);

  const created = await cli(['task', 'create', '--type', 'goal', '--project', projectId, '--title', 'Preview Goal']);
  const goalId = created.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  expect(goalId).toBeDefined();
  const ids = [...taskIds, goalId!];
  const html = '<!doctype html><title>Preview</title><link rel="stylesheet" href="./style.css"><p id="message">Waiting</p><img alt="Relative image" src="./image.svg"><script src="./app.js"></script>';
  const script = 'fetch("./data.json").then(response => response.json()).then(data => { document.querySelector("#message").textContent = data.message; }); if (!localStorage.getItem("preview-owner")) localStorage.setItem("preview-owner", location.hostname);';
  const css = 'body { background-color: rgb(12, 34, 56); }';
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>';
  const pdf = readFileSync(new URL('../../daynight-web/tests/navigation/fixtures/brief.pdf', import.meta.url));
  for (const id of ids) {
    const root = `${topology.baseURL}/api/v1/projects/${projectId}/tasks/${id}`;
    for (const [filename, body, contentType] of [['index.html', html, 'text/html'], ['app.js', script, 'text/javascript'], ['style.css', css, 'text/css'], ['image.svg', image, 'image/svg+xml'], ['data.json', '{"message":"Relative script loaded"}', 'application/json']] as const) {
      const response = await page.request.put(`${root}/attachments/files/${filename}`, { headers: { Origin: topology.baseURL, 'Content-Type': contentType }, data: body });
      expect(response.status(), await response.text()).toBe(201);
    }
    const response = await page.request.put(`${root}/attachments/files/brief.pdf`, { headers: { Origin: topology.baseURL, 'Content-Type': 'application/pdf' }, data: pdf });
    expect(response.status(), await response.text()).toBe(201);
  }

  const root = `/api/v1/projects/${projectId}/tasks/${ids[0]}`;
  const legacy = await page.request.get(`${topology.baseURL}${root}/preview/index.html`, { maxRedirects: 0 });
  expect(legacy.status()).toBe(302);
  const previewURL = new URL(legacy.headers().location!);
  expect(previewURL.hostname).toBe(`${ids[0]}.preview.daynight.localhost`);
  expect((await page.request.head(`${topology.baseURL}${root}/preview/index.html`, { maxRedirects: 0 })).status()).toBe(200);

  const navigations: { method: string; origin: string; path: string }[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.includes(`/tasks/${ids[0]}/preview/`)) navigations.push({ method: request.method(), origin: url.origin, path: url.pathname });
  });
  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${ids[0]}?tab=attachments`);
  const attachments = page.locator('.task-attachments');
  await attachments.getByRole('button', { name: /^index\.html/ }).click();
  const frame = attachments.locator('iframe');
  await expect(frame).toHaveAttribute('src', previewURL.href);
  await expect(frame.contentFrame().locator('#message')).toHaveText('Relative script loaded');
  expect(navigations).toContainEqual({ method: 'GET', origin: previewURL.origin, path: previewURL.pathname });
  expect(navigations.some(request => request.method === 'HEAD' && request.origin === topology.baseURL)).toBe(false);
  expect(await frame.contentFrame().locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(12, 34, 56)');
  await expect.poll(() => frame.contentFrame().getByRole('img', { name: 'Relative image' }).evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(10);
  expect(await page.evaluate(() => {
    try { return Boolean(document.querySelector('iframe')?.contentWindow?.document.body); }
    catch (error) { return error instanceof DOMException && error.name === 'SecurityError' ? false : null; }
  })).toBe(false);

  await attachments.getByRole('button', { name: /^brief\.pdf/ }).click();
  const pdfPath = previewURL.pathname.replace(/index\.html$/, 'brief.pdf');
  await expect.poll(async () => hasPaintedPdfMarker(await page.evaluate(readPdfPixels, (await frame.screenshot({ animations: 'disabled' })).toString('base64'))), { timeout: 20_000 }).toBe(true);
  expect(navigations).toContainEqual({ method: 'GET', origin: previewURL.origin, path: pdfPath });
  expect(navigations.some(request => request.method === 'HEAD' && request.origin === topology.baseURL)).toBe(false);

  const reader = await page.context().newPage();
  try {
    for (const id of ids) {
      const url = new URL(previewURL.href);
      url.hostname = `${id}.preview.daynight.localhost`;
      url.pathname = `/api/v1/projects/${projectId}/tasks/${id}/preview/index.html`;
      await reader.goto(url.href);
      await expect(reader.locator('#message')).toHaveText('Relative script loaded');
      expect(await reader.evaluate(() => localStorage.getItem('preview-owner'))).toBe(url.hostname);
    }
    const goalURL = reader.url();
    const first = `${goalURL}?view=one%2Ftwo#first`;
    await reader.goto(first);
    await expect(reader).toHaveURL(first);
    await reader.goto(`${goalURL}?view=second#second`);
    await reader.goBack();
    await expect(reader).toHaveURL(first);
    await reader.reload();
    await expect(reader).toHaveURL(first);
    await page.goto(`${topology.baseURL}/projects/${projectId}`);
    expect(await page.evaluate(() => localStorage.getItem('preview-owner'))).toBeNull();
  } finally { await reader.close(); }

  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${ids[1]}`);
  const link = page.getByRole('link', { name: 'Open preview', exact: true });
  const expected = previewURL.href.replace(`${ids[0]}.preview`, `${ids[1]}.preview`).replace(`/tasks/${ids[0]}/`, `/tasks/${ids[1]}/`);
  await expect(link).toHaveAttribute('href', expected);
  await page.bringToFront();
  await link.evaluate(element => {
    element.addEventListener('click', event => {
      queueMicrotask(() => { element.setAttribute('data-test-click', JSON.stringify({ ctrl: event instanceof MouseEvent && event.ctrlKey, prevented: event.defaultPrevented, connected: element.isConnected, href: element.getAttribute('href') })); });
    });
  });
  await link.click({ modifiers: ['Control'] });
  await expect.poll(async () => JSON.parse((await link.getAttribute('data-test-click')) ?? 'null')).toEqual({ ctrl: true, prevented: false, connected: true, href: expected });
  await expect(page).toHaveURL(`${topology.baseURL}/projects/${projectId}/tasks/${ids[1]}`);
};
