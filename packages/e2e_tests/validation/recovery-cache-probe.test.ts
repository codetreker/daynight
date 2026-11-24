import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { probeHigherTaskCache } from '../src/subtask-compat-recovery-readback.ts';

test('version probe preserves real IndexedDB data and aborts a racing upgrade', { timeout: 45_000 }, async () => {
  const server = createServer((_request, response) => response.end('<!doctype html><title>cache probe</title>'));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test listener has no port.');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}/`);
    assert.equal(await page.evaluate(probeHigherTaskCache), null);
    assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
    const make = async (version: number) => await page.evaluate(async version => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('daynight-task-cache', version);
        request.onupgradeneeded = () => { request.result.createObjectStore('witness').put('original', 'key'); };
        request.onerror = () => reject(request.error); request.onsuccess = () => { request.result.close(); resolve(); };
      });
    }, version);
    const remove = async () => await page.evaluate(async () => await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('daynight-task-cache'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    }));
    await make(13); assert.equal(await page.evaluate(probeHigherTaskCache), null); await remove();
    await make(14);
    assert.deepEqual(await page.evaluate(probeHigherTaskCache), { version: 14, result: 'version-error' });
    const witness = await page.evaluate(async () => await new Promise<{ version: number; value: unknown }>((resolve, reject) => {
      const request = indexedDB.open('daynight-task-cache');
      request.onerror = () => reject(request.error); request.onsuccess = () => {
        const db = request.result, get = db.transaction('witness').objectStore('witness').get('key');
        get.onerror = () => { db.close(); reject(get.error); }; get.onsuccess = () => { const value = get.result; const version = db.version; db.close(); resolve({ version, value }); };
      };
    }));
    assert.deepEqual(witness, { version: 14, value: 'original' });
    const isolated = await browser.newContext();
    try {
      const newPage = await isolated.newPage(); await newPage.goto(`http://127.0.0.1:${address.port}/`);
      assert.deepEqual(await newPage.evaluate(() => indexedDB.databases()), []);
      await newPage.evaluate(async () => await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('daynight-task-cache', 13);
        request.onerror = () => reject(request.error); request.onsuccess = () => { request.result.close(); resolve(); };
      }));
      assert.equal((await newPage.evaluate(() => indexedDB.databases()))[0]?.version, 13);
      assert.equal((await page.evaluate(() => indexedDB.databases()))[0]?.version, 14);
    } finally { await isolated.close(); }
    await page.evaluate(() => {
      const original = indexedDB.databases.bind(indexedDB);
      indexedDB.databases = async () => {
        const before = await original();
        await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('daynight-task-cache'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
        indexedDB.databases = original;
        return before;
      };
    });
    assert.deepEqual(await page.evaluate(probeHigherTaskCache), { version: 14, result: 'aborted' });
    assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  } finally { await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
