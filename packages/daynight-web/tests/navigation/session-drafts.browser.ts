import { expect, test, type Page } from '@playwright/test';
import { boundary, current, exactPng, file, installDraftAPI, openDraft, ready, saved, seedLegacyDraft, sha256 } from './session-drafts-api';
import { pngImage } from '../helpers/pngImage';

const clientFixture = '/tests/navigation/session-drafts-client-fixture.html';
const clientSaved = (page: Page) => page.evaluate(() => window.sessionDraftClient.storage.read());
const clientView = (page: Page) => page.evaluate(() => {
  const { active, loading, text, conflict, error, canSend, items } = window.sessionDraftClient.client.imageDrafts.getSnapshot();
  return { active, loading, text, conflict, error, canSend, items: items.map(({ asset, ...item }) => ({ ...item, asset: asset?.key ?? null })) };
});
const clientReady = (page: Page) => expect.poll(async () => { const view = await clientView(page); return { loading: view.loading, canSend: view.canSend, error: view.error }; }).toEqual({ loading: false, canSend: true, error: null });
const legacyEntries = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('daynight:session-draft:')).map(key => ({ key, value: JSON.parse(sessionStorage.getItem(key)!) })));

test.afterEach(async ({ context }, info) => {
  if (info.status === info.expectedStatus) return;
  for (const [index, page] of context.pages().entries()) {
    if (page.isClosed()) continue;
    const state = await page.evaluate(() => JSON.stringify({ url: location.href, draft: window.sessionDraftClient?.client.imageDrafts.getSnapshot() ?? window.sessionDraftHarness?.controller.getSnapshot(), client: window.sessionDraftClient?.client.snapshot(), errors: window.sessionDraftClient?.errors ?? window.sessionDraftHarness?.pageErrors, usage: window.sessionDraftHarness?.usage() }, (key, value: unknown) => key === 'asset' ? (value as { key?: string } | null)?.key ?? null : value instanceof Map ? [...value] : value));
    await info.attach(`failed-browser-state-${index}`, { body: state, contentType: 'application/json' });
  }
});

test('wires the actual TaskSessionClient and SessionView through image upload, preview, restore and send', async ({ page, context }, info) => {
  const api = await installDraftAPI(context);
  await page.goto('/tests/navigation/session-drafts-client-fixture.html');
  await expect(page.getByRole('textbox')).toBeEditable(); await expect(page.getByRole('button', { name: 'Add images' })).toBeEnabled();
  await page.getByRole('textbox').fill('client-owned original'); await page.locator('input[type=file]').setInputFiles(file('Client.png'));
  await expect.poll(() => page.evaluate(() => { const { canSend, error, disabledReason } = window.sessionDraftClient.client.imageDrafts.getSnapshot(); return { canSend, error, disabledReason }; })).toEqual({ canSend: true, error: null, disabledReason: null });
  const first = await page.evaluate(() => { const client = window.sessionDraftClient.client, draft = client.imageDrafts.getSnapshot(); return { draftId: draft.draftId, scope: draft.items[0]?.asset?.scope === client.imageScope(), id: draft.items[0]?.draftImageId }; });
  expect(first.scope).toBe(true);
  await page.getByRole('button', { name: 'View image: Client.png', exact: true }).click(); await expect(page.locator('dialog img')).toHaveJSProperty('naturalWidth', 3); await page.keyboard.press('Escape');
  await page.reload(); await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await expect(page.getByRole('textbox')).toHaveValue('client-owned original');
  expect(await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().draftId)).toBe(first.draftId);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission)).toBeNull();
  expect(api.observations.commands[0]!.kind).toBe('send_message'); expect(api.observations.prepares).toHaveLength(1);
  expect(await page.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('TaskSessionClient-SessionView-wiring', { body: JSON.stringify({ boundary: `${boundary} This case also uses the real TaskSessionClient, SessionView, createSessionApi and parsed HTTP/WebSocket messages.`, first, observations: api.observations }), contentType: 'application/json' });
});

test('clears the real client send gate after observing acceptance of a lost image command receipt', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); api.setDispatch('lost'); api.setQuery('404');
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.locator('input[type=file]').setInputFiles(file('First.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission?.state)).toBe('unknown');
  const operationId = api.observations.commands[0]!.operationId;
  await page.reload();
  await expect.poll(() => api.observations.queries.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission?.operationId)).toBe(operationId);
  expect(api.observations.commands).toHaveLength(1);
  api.setQuery('provider_accepted');
  await page.locator('.session-draft-attachments').getByRole('button', { name: 'Check status', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission)).toBeNull();
  expect(await page.evaluate(id => window.sessionDraftClient.client.snapshot().state.operations.get(id)?.state, operationId)).toBe('provider_accepted');
  api.setDispatch('confirmed'); await page.getByRole('textbox').fill('next message'); await page.locator('input[type=file]').setInputFiles(file('Second.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(2);
  expect(api.observations.commands[1]!.operationId).not.toBe(operationId);
  expect(api.observations.queries.every(id => id === operationId)).toBe(true);
  await info.attach('client-unknown-receipt-gate', { body: JSON.stringify({ boundary: `${boundary} Actual TaskSessionClient dispatch and 404/acceptance observation.`, observations: api.observations }), contentType: 'application/json' });
});

test('clears an accepted native command from the durable draft after removing its last image', async ({ page, context }, info) => {
  const api = await installDraftAPI(context, {}, { nativeCommands: true });
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('/compact'); await page.locator('input[type=file]').setInputFiles(file('Removed-before-command.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await page.getByRole('button', { name: 'Remove image: Removed-before-command.png', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().items.length)).toBe(0);
  await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  const before = await page.evaluate(() => window.sessionDraftClient.storage.read());
  expect(before?.editable?.text).toBe('/compact'); expect(before?.editable?.items).toEqual([]);
  await page.getByRole('textbox').press('Enter');
  await expect.poll(() => api.observations.commands.length).toBe(1);
  expect(api.observations.commands[0]!.kind).toBe('execute_command');
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect.poll(() => page.evaluate(async () => (await window.sessionDraftClient.storage.read())?.editable?.text)).toBe('');
  await page.reload(); await expect(page.getByRole('textbox')).toBeEditable(); await expect(page.getByRole('textbox')).toHaveValue('');
  expect((await page.evaluate(() => window.sessionDraftClient.storage.read()))?.submission).toBeNull();
  expect(api.observations.commands).toHaveLength(1); expect(await page.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('durable-native-command-accepted', { body: JSON.stringify({ boundary, before, after: await page.evaluate(() => window.sessionDraftClient.storage.read()), observations: api.observations }), contentType: 'application/json' });
});

test('keeps a lost native command durable across reload and preserves later edits after original acceptance', async ({ page, context }, info) => {
  const api = await installDraftAPI(context, {}, { nativeCommands: true }); api.setDispatch('lost'); api.setQuery('404');
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('/compact'); await page.locator('input[type=file]').setInputFiles(file('Removed-before-unknown.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await page.getByRole('button', { name: 'Remove image: Removed-before-unknown.png', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().items.length)).toBe(0);
  await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush()); await page.getByRole('textbox').press('Enter');
  await expect.poll(() => api.observations.commands.length).toBe(1);
  const operationId = api.observations.commands[0]!.operationId; expect(api.observations.commands[0]!.kind).toBe('execute_command');
  await expect.poll(() => page.evaluate(async () => (await window.sessionDraftClient.storage.read())?.submission?.state)).toBe('unknown');
  const frozen = await page.evaluate(() => window.sessionDraftClient.storage.read());
  expect(frozen?.submission).toMatchObject({ operationId, kind: 'execute_command' }); expect(frozen?.frozen?.text).toBe('/compact');
  await page.reload(); await expect.poll(() => api.observations.queries.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().executionBlocked)).toBe(true);
  expect((await page.evaluate(() => window.sessionDraftClient.storage.read()))?.submission).toMatchObject({ operationId, state: 'unknown', kind: 'execute_command' });
  const refused = await page.evaluate(async () => { try { await window.sessionDraftClient.client.executeCommand('compact', '', '3', '/compact'); return null; } catch (error) { return String(error); } });
  expect(refused).not.toBeNull(); expect(api.observations.commands).toHaveLength(1);
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click(); await page.getByRole('textbox').fill('keep later command edits');
  await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  api.setQuery('confirmed'); await page.locator('.session-draft-attachments').getByRole('button', { name: 'Check status', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission)).toBeNull();
  await expect(page.getByRole('textbox')).toHaveValue('keep later command edits');
  await page.reload(); await expect(page.getByRole('textbox')).toBeEditable(); await expect(page.getByRole('textbox')).toHaveValue('keep later command edits');
  expect(api.observations.commands).toHaveLength(1); expect(api.observations.queries.every(id => id === operationId)).toBe(true);
  expect(await page.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('durable-native-command-unknown', { body: JSON.stringify({ boundary, frozen, refused, after: await page.evaluate(() => window.sessionDraftClient.storage.read()), observations: api.observations }), contentType: 'application/json' });
});

test('cancels a durably prepared native command after its catalog changes without dispatching or losing its text', async ({ page, context }, info) => {
  const api = await installDraftAPI(context, {}, { nativeCommands: true });
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('/compact'); await page.locator('input[type=file]').setInputFiles(file('Removed-before-prepared.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await page.getByRole('button', { name: 'Remove image: Removed-before-prepared.png', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().items.length)).toBe(0);
  await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  await page.evaluate(() => window.sessionDraftClient.storage.holdBeforeDispatchClaim()); await page.getByRole('textbox').press('Enter');
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.storage.dispatchClaimArrivals())).toBe(1);
  const prepared = (await page.evaluate(() => window.sessionDraftClient.storage.read()))!;
  expect(prepared.submission).toMatchObject({ kind: 'execute_command', state: 'prepared' }); expect(prepared.frozen?.text).toBe('/compact');
  expect(api.observations.commands).toEqual([]); expect(api.observations.queries).toEqual([]);
  await page.close(); const unavailableRevision = api.changeCommandCatalog(false);
  const reopened = await context.newPage(); await reopened.goto('/tests/navigation/session-drafts-client-fixture.html');
  const cancel = reopened.getByRole('button', { name: 'Cancel the pending message and keep its draft', exact: true }); await expect(cancel).toBeEnabled();
  expect(await reopened.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canResumePrepared)).toBe(false);
  await expect(reopened.getByRole('button', { name: 'Send this saved message', exact: true })).toHaveCount(0);
  expect((await reopened.evaluate(() => window.sessionDraftClient.storage.read()))?.submission?.operationId).toBe(prepared.submission!.operationId);
  expect(api.observations.commands).toEqual([]); expect(api.observations.queries).toEqual([]);
  await cancel.click(); await expect(reopened.getByRole('textbox')).toBeEditable(); await expect(reopened.getByRole('textbox')).toHaveValue('/compact');
  await expect.poll(() => reopened.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().executionBlocked)).toBe(false);
  const cancelled = await reopened.evaluate(() => window.sessionDraftClient.storage.read());
  expect(cancelled?.submission).toBeNull(); expect(cancelled?.editable?.text).toBe('/compact');
  await reopened.reload(); await expect(reopened.getByRole('textbox')).toBeEditable(); await expect(reopened.getByRole('textbox')).toHaveValue('/compact');
  expect(api.observations.commands).toEqual([]); expect(api.observations.queries).toEqual([]);
  expect(await reopened.evaluate(() => window.sessionDraftClient.client.snapshot().state.snapshot?.controls?.revision)).toBe(unavailableRevision);
  const unavailable = await reopened.evaluate(async revision => { try { await window.sessionDraftClient.client.executeCommand('compact', '', revision, '/compact'); return null; } catch (error) { return String(error); } }, unavailableRevision);
  expect(unavailable).not.toBeNull(); expect(api.observations.commands).toEqual([]); await expect(reopened.getByRole('textbox')).toHaveValue('/compact');
  const availableRevision = api.changeCommandCatalog(true);
  await expect.poll(() => reopened.evaluate(() => window.sessionDraftClient.client.snapshot().state.snapshot?.controls?.revision)).toBe(availableRevision);
  await reopened.getByRole('textbox').press('Enter');
  try { await expect.poll(() => api.observations.commands.length).toBe(1); }
  catch (error) {
    const state = await reopened.evaluate(async () => {
      const client = window.sessionDraftClient.client, view = client.snapshot();
      return { errors: window.sessionDraftClient.errors, connected: view.connected, actionAdmitted: view.actionAdmitted, authPaused: view.authPaused,
        operations: [...view.state.operations.values()], snapshot: view.state.snapshot, draft: client.imageDrafts.getSnapshot(), saved: await window.sessionDraftClient.storage.read() };
    });
    await info.attach('prepared-command-send-failure', { body: JSON.stringify({ state, observations: api.observations }), contentType: 'application/json' });
    throw error;
  }
  expect(api.observations.commands[0]!.kind).toBe('execute_command'); expect(api.observations.commands[0]!.operationId).not.toBe(prepared.submission!.operationId);
  if (api.observations.commands[0]!.kind === 'execute_command') expect(api.observations.commands[0]!.payload.expectedControlsRevision).toBe(availableRevision);
  await expect(reopened.getByRole('textbox')).toHaveValue(''); expect(await reopened.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('durable-native-command-prepared-cancel', { body: JSON.stringify({ boundary: `${boundary} A barrier delays entry to the production claim transaction after native IDB freeze commits; closing the page precedes any command dispatch.`, prepared, cancelled, unavailableRevision, unavailable, availableRevision, observations: api.observations }), contentType: 'application/json' });
});

test('moves an earlier null-target successor explicitly after acceptance while reclaiming only unreferenced originals', async ({ page, context }, info) => {
  const api = await installDraftAPI(context, { expectedNativeSessionId: null }, { testSession: true }); api.setDispatch('lost'); api.setQuery('404');
  const first = file('First-submitted.png'), later = [file('Later-A.png', pngImage(5, 3)), file('Later-B.png', pngImage(7, 4))];
  await page.goto('/tests/navigation/session-drafts-client-fixture.html?test-session'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('first message before native identity'); await page.locator('input[type=file]').setInputFiles(first);
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  const original = (await page.evaluate(() => window.sessionDraftClient.storage.read()))!;
  expect(original.owner.identity.target.expectedNativeSessionId).toBeNull();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission?.state)).toBe('unknown');
  const operationId = api.observations.commands[0]!.operationId;
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await page.getByRole('textbox').fill('successor text and ordered originals'); await page.locator('input[type=file]').setInputFiles(later);
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().items.map(item => item.status))).toEqual(['complete', 'complete']);
  await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  const successor = (await page.evaluate(() => window.sessionDraftClient.storage.read()))!;
  expect(successor.editable?.items.map(item => item.label)).toEqual(later.map(item => item.name));
  const before = await page.evaluate(() => window.sessionDraftClient.storage.inventory());
  expect(before.owners.find(owner => owner.ownerKey === original.owner.ownerKey)?.allocatedBytes).toBe(first.buffer.length + later.reduce((sum, item) => sum + item.buffer.length, 0));
  api.changeTarget('native-established'); await expect(page.getByRole('textbox')).toHaveValue('');
  await expect(page.getByText('Earlier message', { exact: true })).toBeVisible();
  await expect(page.locator('.session-draft-attachments').getByRole('button', { name: 'Check status', exact: true })).toBeEnabled();
  api.setQuery('confirmed'); await page.locator('.session-draft-attachments').getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(page.getByText('Earlier draft', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.sessionDraftClient.storage.inventory()).blobs.length)).toBe(2);
  const accepted = await page.evaluate(() => window.sessionDraftClient.storage.inventory());
  expect(accepted.blobs.some(blob => blob.blobId === original.editable!.items[0]!.blobId)).toBe(false);
  expect(accepted.owners.find(owner => owner.ownerKey === original.owner.ownerKey)?.allocatedBytes).toBe(later.reduce((sum, item) => sum + item.buffer.length, 0));
  expect(accepted.blobs.map(blob => blob.actualSha256).sort()).toEqual(later.map(item => sha256(item.buffer)).sort());
  expect(accepted.blobs.every(blob => blob.actualSha256 === blob.sha256 && blob.references.some(reference => reference.startsWith(`draft:${successor.editable!.draftId}:`)))).toBe(true);
  await page.reload(); await expect(page.getByText('Earlier draft', { exact: true })).toBeVisible(); await expect(page.getByRole('textbox')).toHaveValue('');
  expect(api.observations.commands).toHaveLength(1);
  const move = page.getByRole('button', { name: 'Move to current draft', exact: true }); await expect(move).toBeEnabled();
  await page.getByRole('textbox').fill('occupied current input'); await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  await expect(move).toBeDisabled(); await expect(page.getByRole('textbox')).toHaveValue('occupied current input');
  expect((await page.evaluate(() => window.sessionDraftClient.storage.inventory())).drafts.find(draft => draft.draftId === successor.editable!.draftId)?.text).toBe('successor text and ordered originals');
  await page.getByRole('textbox').fill(''); await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush()); await expect(move).toBeEnabled();
  await move.click(); await expect(page.getByRole('group', { name: 'Confirm', exact: true })).toBeVisible();
  expect(api.observations.commands).toHaveLength(1); await expect(page.getByRole('textbox')).toHaveValue('');
  await page.getByRole('group', { name: 'Confirm', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('textbox')).toHaveValue('successor text and ordered originals');
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  const moved = (await page.evaluate(() => window.sessionDraftClient.storage.read()))!, movedInventory = await page.evaluate(() => window.sessionDraftClient.storage.inventory());
  expect(moved.editable!.draftId).not.toBe(successor.editable!.draftId); expect(moved.editable!.items.map(item => item.label)).toEqual(later.map(item => item.name));
  for (const [index, item] of moved.editable!.items.entries()) {
    const old = successor.editable!.items[index]!;
    for (const key of ['draftImageId', 'imageId', 'blobId', 'uploadId'] as const) { expect(item[key]).not.toBeNull(); expect(item[key]).not.toBe(old[key]); }
    expect(movedInventory.blobs.find(blob => blob.blobId === item.blobId)?.actualSha256).toBe(sha256(later[index]!.buffer));
  }
  expect(movedInventory.owners.find(owner => owner.ownerKey === original.owner.ownerKey)?.allocatedBytes).toBe(0);
  expect(movedInventory.blobs.every(blob => blob.ownerKey === moved.owner.ownerKey)).toBe(true);
  expect(movedInventory.drafts.some(draft => draft.draftId === successor.editable!.draftId)).toBe(false);
  expect(api.observations.commands).toHaveLength(1); expect(api.observations.queries.every(id => id === operationId)).toBe(true);
  await page.getByRole('button', { name: 'View image: Later-A.png', exact: true }).click(); await expect(page.locator('dialog img')).toHaveJSProperty('naturalWidth', 5); await page.keyboard.press('Escape');
  api.setDispatch('confirmed'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(2);
  const sent = api.observations.commands[1]!; if (sent.kind !== 'send_message') throw new Error('Expected the explicitly moved image message.');
  expect(sent.operationId).not.toBe(operationId); expect(sent.payload.content.filter(part => part.type === 'image').map(part => part.imageId)).toEqual(moved.editable!.items.map(item => item.imageId));
  expect(sent.payload.content[0]).toEqual({ type: 'text', text: 'successor text and ordered originals' });
  expect(await page.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('detached-null-target-successor-move', { body: JSON.stringify({ boundary, original, successor, before, accepted, moved, movedInventory, observations: api.observations }), contentType: 'application/json' });
});

test('keeps a rejected earlier native draft discoverable after choosing it and moves it only on confirmation', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); api.setDispatch('lost'); api.setQuery('404');
  const failed = file('Failed-retained.png', pngImage(6, 3));
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('restore the failed original'); await page.locator('input[type=file]').setInputFiles(failed);
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  const original = (await page.evaluate(() => window.sessionDraftClient.storage.read()))!;
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission?.state)).toBe('unknown');
  const operationId = api.observations.commands[0]!.operationId;
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click(); await page.getByRole('textbox').fill('discard this later draft'); await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  api.changeTarget('native-after-refusal'); await expect(page.getByRole('textbox')).toHaveValue('');
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().recoveries.some(entry => !entry.currentOwner && entry.canCheck))).toBe(true);
  await expect(page.locator('.session-draft-attachments').getByRole('button', { name: 'Check status', exact: true })).toBeEnabled();
  api.setQuery('rejected'); await page.locator('.session-draft-attachments').getByRole('button', { name: 'Check status', exact: true }).click();
  await page.getByRole('button', { name: 'Restore failed draft and discard later edits', exact: true }).click();
  await page.getByRole('group', { name: 'Confirm', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Earlier draft', { exact: true })).toBeVisible(); await expect(page.getByRole('textbox')).toHaveValue('');
  await page.reload(); await expect(page.getByText('Earlier draft', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveValue(''); expect(api.observations.commands).toHaveLength(1);
  await page.getByRole('button', { name: 'Move to current draft', exact: true }).click();
  await page.getByRole('group', { name: 'Confirm', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('textbox')).toHaveValue('restore the failed original'); await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  const moved = (await page.evaluate(() => window.sessionDraftClient.storage.read()))!, inventory = await page.evaluate(() => window.sessionDraftClient.storage.inventory());
  expect(moved.editable!.draftId).not.toBe(original.editable!.draftId); expect(moved.editable!.items.map(item => item.label)).toEqual(['Failed-retained.png']);
  expect(inventory.blobs.find(blob => blob.blobId === moved.editable!.items[0]!.blobId)?.actualSha256).toBe(sha256(failed.buffer));
  expect(api.observations.commands).toHaveLength(1); expect(api.observations.queries.every(id => id === operationId)).toBe(true);
  expect(await page.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('detached-failed-draft-choice-move', { body: JSON.stringify({ boundary, original, moved, inventory, observations: api.observations }), contentType: 'application/json' });
});

test('preserves image drafts and unknown submissions through the actual Session fullscreen control', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); api.setDispatch('lost'); api.setQuery('404');
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('keep across fullscreen'); await page.locator('input[type=file]').setInputFiles(file('Fullscreen.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  const saved = await page.evaluate(() => window.sessionDraftClient.storage.read()), root = page.locator('section.task-agent-session');
  const blobId = saved!.editable!.items[0]!.blobId!, original = await page.evaluate(id => window.sessionDraftClient.storage.readBlob(id), blobId);
  const rootHandle = await root.elementHandle();
  await page.getByRole('button', { name: 'Enter Session fullscreen', exact: true }).click(); await expect(root).toHaveAttribute('data-session-fullscreen', 'true');
  await expect(page.getByRole('textbox')).toHaveValue('keep across fullscreen');
  expect(await page.evaluate(() => window.sessionDraftClient.storage.read())).toEqual(saved);
  await page.getByRole('button', { name: 'View image: Fullscreen.png', exact: true }).click(); await expect(page.locator('dialog img')).toHaveJSProperty('naturalWidth', 3);
  await page.keyboard.press('Escape'); await expect(page.locator('dialog')).not.toBeVisible(); await expect(root).toHaveAttribute('data-session-fullscreen', 'true');
  await page.keyboard.press('Escape'); await expect(root).not.toHaveAttribute('data-session-fullscreen');
  await expect(page.getByRole('button', { name: 'Enter Session fullscreen', exact: true })).toBeFocused();
  expect(api.observations.commands).toEqual([]);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission?.state)).toBe('unknown');
  const frozen = await page.evaluate(() => window.sessionDraftClient.storage.read()), operationId = api.observations.commands[0]!.operationId;
  await page.getByRole('button', { name: 'Enter Session fullscreen', exact: true }).click(); await expect(root).toHaveAttribute('data-session-fullscreen', 'true');
  await expect(page.locator('.session-draft-attachments')).toContainText('Awaiting the original message result');
  await page.getByRole('button', { name: 'Exit Session fullscreen', exact: true }).click(); await expect(root).not.toHaveAttribute('data-session-fullscreen');
  const retained = await page.evaluate(() => window.sessionDraftClient.storage.read());
  expect(retained?.submission?.operationId).toBe(operationId); expect(retained?.submission?.state).toBe('unknown'); expect(retained?.frozen).toEqual(frozen?.frozen);
  expect(await page.evaluate(id => window.sessionDraftClient.storage.readBlob(id), blobId)).toEqual(original);
  expect(await root.evaluate((node, previous) => node === previous, rootHandle)).toBe(true);
  expect(api.observations.commands).toHaveLength(1); expect(api.observations.queries.every(id => id === operationId)).toBe(true);
  expect(await page.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('client-fullscreen-draft-unknown', { body: JSON.stringify({ boundary: `${boundary} Actual SessionView/useSessionFullscreen controls and preview Escape ownership.`, saved, original, frozen, retained, observations: api.observations }), contentType: 'application/json' });
});

test('resolves an earlier native target failure without replacing the current target draft', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); api.setDispatch('lost'); api.setQuery('404');
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('original submitted text'); await page.locator('input[type=file]').setInputFiles(file('Original-target.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission?.state)).toBe('unknown');
  const operationId = api.observations.commands[0]!.operationId;
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click(); await page.getByRole('textbox').fill('old target later edits');
  await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  api.changeTarget('native-thread-2');
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().recoveries.some(entry => !entry.currentOwner && entry.currentExecution))).toBe(true);
  await page.getByRole('textbox').fill('new target retained'); await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  api.setQuery('rejected');
  await page.locator('.session-draft-attachments').getByRole('button', { name: 'Check status', exact: true }).click();
  const keep = page.getByRole('button', { name: 'Keep later edits and discard failed draft', exact: true }); await expect(keep).toBeVisible();
  const choices = await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().recoveries);
  expect(choices[0]).toMatchObject({ currentOwner: false, state: 'rejected', frozen: { text: 'original submitted text' }, successor: { text: 'old target later edits' } });
  await keep.click(); await page.getByRole('group', { name: 'Confirm', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().recoveries.length)).toBe(0);
  await expect(page.getByRole('textbox')).toHaveValue('new target retained');
  api.changeTarget('native-thread-1'); await expect(page.getByRole('textbox')).toHaveValue('old target later edits');
  const retained = await page.evaluate(() => window.sessionDraftClient.storage.read());
  expect(retained?.submission).toBeNull(); expect(retained?.frozen).toBeNull(); expect(retained?.editable?.text).toBe('old target later edits');
  expect(api.observations.commands).toHaveLength(1); expect(api.observations.queries.every(id => id === operationId)).toBe(true);
  expect(await page.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('old-native-failure-choice', { body: JSON.stringify({ boundary, choices, retained, observations: api.observations }), contentType: 'application/json' });
});

test('queries an earlier generation without importing its frozen draft or operation into the current generation', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); api.setDispatch('lost'); api.setQuery('404');
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('generation one frozen'); await page.locator('input[type=file]').setInputFiles(file('Generation-one.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission?.state)).toBe('unknown');
  const operationId = api.observations.commands[0]!.operationId, nextGeneration = String(BigInt(api.observations.commands[0]!.executionGeneration) + 1n);
  api.changeTarget('next-generation-native', nextGeneration);
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().recoveries.some(entry => !entry.currentExecution))).toBe(true);
  await page.getByRole('textbox').fill('generation two edit'); await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  const before = await page.evaluate(() => { const draft = window.sessionDraftClient.client.imageDrafts.getSnapshot(); return { submission: draft.submission, executionBlocked: draft.executionBlocked, recoveries: draft.recoveries }; });
  expect(before.submission).toBeNull(); expect(before.executionBlocked).toBe(false); expect(before.recoveries[0]?.frozen?.text).toBe('generation one frozen');
  api.setQuery('confirmed'); await page.locator('.session-draft-attachments').getByRole('button', { name: 'Check status', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().recoveries.length)).toBe(0);
  await expect(page.getByRole('textbox')).toHaveValue('generation two edit');
  expect(await page.evaluate(id => window.sessionDraftClient.client.snapshot().state.operations.has(id), operationId)).toBe(false);
  expect(api.observations.commands).toHaveLength(1); expect(api.observations.queries.every(id => id === operationId)).toBe(true);
  expect(await page.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('historical-generation-recovery', { body: JSON.stringify({ boundary, before, current: await page.evaluate(() => window.sessionDraftClient.storage.read()), observations: api.observations }), contentType: 'application/json' });
});

test('reopens a durably prepared message without claiming or dispatching it until explicit resume', async ({ page, context }, info) => {
  const api = await installDraftAPI(context);
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('prepared before tab close'); await page.locator('input[type=file]').setInputFiles(file('Prepared.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await page.evaluate(() => window.sessionDraftClient.storage.holdBeforeDispatchClaim());
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.storage.dispatchClaimArrivals())).toBe(1);
  const prepared = await page.evaluate(() => window.sessionDraftClient.storage.read());
  expect(prepared?.submission?.state).toBe('prepared'); expect(prepared?.frozen?.text).toBe('prepared before tab close'); expect(api.observations.commands).toEqual([]);
  const operationId = prepared!.submission!.operationId;
  await page.close(); const reopened = await context.newPage(); await reopened.goto('/tests/navigation/session-drafts-client-fixture.html');
  await expect(reopened.getByRole('button', { name: 'Send this saved message', exact: true })).toBeEnabled();
  const recovered = await reopened.evaluate(() => window.sessionDraftClient.storage.read());
  expect(recovered?.submission?.operationId).toBe(operationId); expect(recovered?.submission?.state).toBe('prepared'); expect(recovered?.frozen).toEqual(prepared?.frozen);
  expect(api.observations.commands).toEqual([]); expect(api.observations.queries).toEqual([]);
  await reopened.getByRole('button', { name: 'Send this saved message', exact: true }).click();
  await expect.poll(() => api.observations.commands.length).toBe(1); expect(api.observations.commands[0]!.operationId).toBe(operationId);
  await expect.poll(() => reopened.evaluate(async () => (await window.sessionDraftClient.storage.read())?.submission)).toBeNull();
  expect(await reopened.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
  await info.attach('native-prepared-recovery', { body: JSON.stringify({ boundary: `${boundary} A barrier delays entry to claimDispatch after the real freeze transaction commits; the page closes before any claim transaction or command.`, prepared, recovered, observations: api.observations }), contentType: 'application/json' });
});

test('restores a real client draft after definitive capability rejection and sends under a fresh revision', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); api.setDispatch('capability_changed');
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('retained after 409'); await page.locator('input[type=file]').setInputFiles(file('Retained.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(1);
  await expect.poll(() => page.evaluate(() => { const draft = window.sessionDraftClient.client.imageDrafts.getSnapshot(); return { submission: draft.submission, canSend: draft.canSend, text: draft.text }; })).toEqual({ submission: null, canSend: true, text: 'retained after 409' });
  const old = api.observations.commands[0]!.operationId;
  expect(await page.evaluate(id => window.sessionDraftClient.client.snapshot().state.operations.get(id)?.state, old)).toBe('rejected');
  api.setDispatch('confirmed'); Object.assign(api.capability, { revision: '3' });
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(2);
  const retry = api.observations.commands[1]!; expect(retry.operationId).not.toBe(old);
  if (retry.kind !== 'send_message') throw new Error('Expected the retained image message.');
  expect(retry.payload.expectedImageCapabilityRevision).toBe('3'); expect(api.observations.prepares).toHaveLength(1); expect(api.observations.queries).toEqual([]);
  await info.attach('client-capability-refusal-gate', { body: JSON.stringify({ boundary: `${boundary} Actual TaskSessionClient receives a parsed capability_changed HTTP 409.`, observations: api.observations }), contentType: 'application/json' });
});

test('persists original Blob bytes through refresh and closing the only Session tab', async ({ page, context }, info) => {
  const api = await installDraftAPI(context), original = file('Original.png');
  await openDraft(page); await page.getByRole('textbox').fill(' durable text ');
  await page.locator('input[type=file]').setInputFiles(original); await ready(page, 1);
  const before = await saved(page), initial = await page.evaluate(() => window.sessionDraftHarness.originals());
  expect(initial).toEqual([{ id: before!.editable!.items[0]!.draftImageId, label: original.name, size: original.buffer.length, mediaType: 'image/png', sha256: sha256(original.buffer) }]);
  await page.reload(); await ready(page, 1); await expect(page.getByRole('textbox')).toHaveValue(' durable text ');
  expect(await page.evaluate(() => window.sessionDraftHarness.originals())).toEqual(initial);
  expect((await saved(page))!.editable!.draftId).toBe(before!.editable!.draftId);
  await page.close(); const reopened = await context.newPage(); await openDraft(reopened); await ready(reopened, 1);
  expect(await reopened.evaluate(() => window.sessionDraftHarness.originals())).toEqual(initial);
  expect(api.observations.prepares).toHaveLength(1); expect(api.observations.commands).toEqual([]);
  expect(await reopened.evaluate(() => window.sessionDraftHarness.pageErrors)).toEqual([]);
  await info.attach('durable-blob-evidence', { body: JSON.stringify({ boundary, initial, reopened: await saved(reopened), observations: api.observations }), contentType: 'application/json' });
});

test('reports a missing native IndexedDB Blob after reload without discarding its sibling', async ({ page, context }, info) => {
  const api = await installDraftAPI(context), retained = file('Retained.png', pngImage(5, 3));
  await openDraft(page); await page.getByRole('textbox').fill('keep this text');
  await page.locator('input[type=file]').setInputFiles([file('Missing.png'), retained]); await ready(page, 2);
  const before = (await saved(page))!, missingId = before.editable!.items[0]!.blobId!;
  await page.evaluate(id => window.sessionDraftHarness.storage.removeBlob(id), missingId);
  expect(await page.evaluate(() => window.sessionDraftHarness.storage.counts())).toMatchObject({ drafts: 1, blobs: 1 });
  await page.reload();
  await expect.poll(async () => (await current(page)).items.map(item => item.validation)).toEqual(['bytes_missing', 'valid']);
  await expect(page.getByText('The original image is missing. Remove it and select the file again.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveValue('keep this text'); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect((await saved(page))!.editable!.items.map(item => item.draftImageId)).toEqual(before.editable!.items.map(item => item.draftImageId));
  expect(api.observations.commands).toEqual([]); expect(api.observations.prepares).toHaveLength(2);
  await page.getByRole('button', { name: 'Remove image: Missing.png', exact: true }).click(); await ready(page, 1);
  expect(await page.evaluate(() => window.sessionDraftHarness.originals())).toEqual([{ id: before.editable!.items[1]!.draftImageId, label: retained.name, size: retained.buffer.length, mediaType: 'image/png', sha256: sha256(retained.buffer) }]);
  await info.attach('native-missing-blob', { body: JSON.stringify({ boundary, before, missingId, recovered: await saved(page), observations: api.observations }), contentType: 'application/json' });
});

for (const fault of ['abort', 'quota'] as const) test(`preserves committed native IndexedDB data and retries unsaved edits after ${fault}`, async ({ page, context }, info) => {
  const api = await installDraftAPI(context), second = file('Unsaved.png', pngImage(5, 3));
  await openDraft(page); await page.getByRole('textbox').fill('committed text');
  await page.locator('input[type=file]').setInputFiles(file('Committed.png')); await ready(page, 1);
  const before = await saved(page), originals = await page.evaluate(() => window.sessionDraftHarness.originals()), counts = await page.evaluate(() => window.sessionDraftHarness.storage.counts());
  await page.evaluate(kind => window.sessionDraftHarness.storage.armFault(kind), fault);
  await page.getByRole('textbox').fill('unsaved local edit'); await page.locator('input[type=file]').setInputFiles(second);
  await expect.poll(async () => { const view = await current(page); return { error: view.error, images: view.items.map(item => ({ label: item.label, validation: item.validation })) }; }).toEqual({ error: fault === 'quota' ? 'image_draft_quota' : 'image_draft_unavailable', images: [{ label: 'Committed.png', validation: 'valid' }, { label: 'Unsaved.png', validation: 'pending' }] });
  await expect(page.getByRole('alert').filter({ hasText: fault === 'quota' ? 'Local image storage is full.' : 'The draft could not be saved.' })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveValue('unsaved local edit'); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(await saved(page)).toEqual(before); expect(await page.evaluate(() => window.sessionDraftHarness.originals())).toEqual(originals);
  expect(await page.evaluate(() => window.sessionDraftHarness.storage.counts())).toEqual(counts);
  await expect.poll(() => page.evaluate(() => window.sessionDraftHarness.storage.writes().filter(write => write.aborted).length)).toBeGreaterThan(0);
  const writes = await page.evaluate(() => window.sessionDraftHarness.storage.writes());
  expect(writes.every(write => write.aborted && !write.completed && write.requestSucceeded === (fault === 'abort'))).toBe(true);
  expect(api.observations.prepares).toHaveLength(1); expect(api.observations.commands).toEqual([]);
  await page.evaluate(() => window.sessionDraftHarness.storage.clearFault()); await page.getByRole('button', { name: 'Retry saving', exact: true }).click(); await ready(page, 2);
  expect((await saved(page))?.editable?.text).toBe('unsaved local edit');
  const committed = await page.evaluate(() => window.sessionDraftHarness.originals()); expect(committed[1]!.sha256).toBe(sha256(second.buffer));
  await page.reload(); await ready(page, 2); await expect(page.getByRole('textbox')).toHaveValue('unsaved local edit');
  expect(await page.evaluate(() => window.sessionDraftHarness.originals())).toEqual(committed);
  await info.attach(`native-storage-${fault}`, { body: JSON.stringify({ boundary, fault: fault === 'abort' ? 'Native IDBTransaction.abort() after the real draft write request succeeded; completion was not observed.' : 'Injected QuotaExceededError at the native object-store write boundary; no physical disk-quota exhaustion was attempted.', writes, before, after: await saved(page), observations: api.observations }), contentType: 'application/json' });
});

test('isolates two account owners in the same native database and browser context', async ({ page, context }, info) => {
  await installDraftAPI(context); await openDraft(page); await page.getByRole('textbox').fill('account A private draft');
  await page.locator('input[type=file]').setInputFiles(file('Account A.png')); await ready(page, 1);
  const a = (await saved(page))!, other = '00000072-1111-4111-8111-111111111111';
  expect(await page.evaluate(actor => window.sessionDraftHarness.storage.read(actor), other)).toBeNull();
  const peer = await context.newPage(); await peer.goto(`/tests/navigation/session-drafts-fixture.html?actor=${other}`); await peer.bringToFront();
  await expect(peer.getByRole('textbox')).toBeEditable(); await expect(peer.getByRole('textbox')).toHaveValue('');
  expect(await saved(peer)).toBeNull(); await expect(peer.getByRole('button', { name: 'View image: Account A.png', exact: true })).toHaveCount(0);
  await peer.getByRole('textbox').fill('account B private draft'); await peer.locator('input[type=file]').setInputFiles(file('Account B.png', pngImage(5, 3))); await ready(peer, 1);
  const b = (await saved(peer))!; expect(b.owner.ownerKey).not.toBe(a.owner.ownerKey); expect(b.owner.identity.target.actorUserId).toBe(other);
  expect(await peer.evaluate(id => window.sessionDraftHarness.storage.readBlob(id), a.editable!.items[0]!.blobId!)).toBeNull();
  expect(await page.evaluate(actor => window.sessionDraftHarness.storage.read(actor), other)).toEqual(b);
  await page.bringToFront(); await page.reload(); await ready(page, 1); await expect(page.getByRole('textbox')).toHaveValue('account A private draft');
  await expect(page.getByRole('button', { name: 'View image: Account B.png', exact: true })).toHaveCount(0);
  expect((await saved(page))!.owner.ownerKey).toBe(a.owner.ownerKey); await expect(peer.getByRole('textbox')).toHaveValue('account B private draft');
  await info.attach('native-account-isolation', { body: JSON.stringify({ boundary, accountA: a, accountB: b, refreshedA: await saved(page) }), contentType: 'application/json' });
});

for (const state of ['failed', 'expired', 'released'] as const) test(`retries a ${state} upload with a fresh wire image identity while retaining its original draft bytes`, async ({ page, context }, info) => {
  const api = await installDraftAPI(context), original = file('Retained.png'); api.completeNextAs(state);
  try {
    await page.goto(clientFixture); await expect(page.getByRole('textbox')).toBeEditable();
    await page.getByRole('textbox').fill('Retain this caption'); await page.locator('input[type=file]').setInputFiles(original);
    await expect.poll(async () => (await clientSaved(page))?.uploads[0]?.receipt?.state).toBe(state);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    const before = (await clientSaved(page))!, item = before.editable!.items[0]!, firstSpec = api.observations.prepareSpecs[0]!;
    const originals = await page.evaluate(() => window.sessionDraftClient.storage.inventory());
    expect(api.observations.commands).toEqual([]); expect(api.observations.prepares).toHaveLength(1);
    await page.locator('.session-draft-item').getByRole('button', { name: 'Retry', exact: true }).click(); await clientReady(page);
    const after = (await clientSaved(page))!, next = after.editable!.items[0]!, secondSpec = api.observations.prepareSpecs[1]!;
    expect(next).toMatchObject({ draftImageId: item.draftImageId, blobId: item.blobId, byteRevision: item.byteRevision, label: item.label, validation: 'valid' });
    expect(after.editable!.text).toBe('Retain this caption'); expect(after.editable!.items).toHaveLength(1);
    expect(next.imageId).not.toBe(item.imageId); expect(next.uploadId).not.toBe(item.uploadId);
    expect(secondSpec).toEqual({ ...firstSpec, uploadId: next.uploadId, imageId: next.imageId });
    expect(api.observations.prepares).toHaveLength(2); expect(api.observations.identityConflicts).toEqual([]);
    expect(api.uploads.get(item.uploadId!)!.spec).toEqual(firstSpec); expect(api.observations.commands).toEqual([]);
    expect((await page.evaluate(() => window.sessionDraftClient.storage.inventory())).blobs).toEqual(originals.blobs);
    expect(Buffer.concat(api.uploads.get(next.uploadId!)!.chunks)).toEqual(original.buffer);
    await page.reload(); await clientReady(page);
    expect((await clientSaved(page))!.editable!.items[0]).toEqual(next); expect(api.observations.prepares).toHaveLength(2);
    await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(1);
    const command = api.observations.commands[0]!; if (command.kind !== 'send_message') throw new Error('Expected the explicitly retried image message.');
    expect(command.payload.content.filter(part => part.type === 'image').map(part => ({ imageId: part.imageId, uploadId: part.uploadId }))).toEqual([{ imageId: next.imageId, uploadId: next.uploadId }]);
    await info.attach('terminal-upload-originals', { body: JSON.stringify({ boundary: `${boundary} Terminal receipts are controlled; the fixture enforces the service's retained (sessionId, imageId) identity and immutable upload retry contract.`, state, before, after, originals }), contentType: 'application/json' });
  } finally {
    await info.attach('terminal-upload-observations', { body: JSON.stringify({ state, view: await clientView(page).catch(() => null), saved: await clientSaved(page).catch(() => null), observations: api.observations }), contentType: 'application/json' });
  }
});

for (const version of [1, 2, 3] as const) test(`restores a native schema ${version} image draft and retries its legacy upload without editing`, async ({ page, context }, info) => {
  const api = await installDraftAPI(context), original = file('Legacy.png'); api.completeNextAs('failed');
  await page.goto(clientFixture); await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('textbox').fill('Caption from the legacy image draft'); await page.locator('input[type=file]').setInputFiles(original);
  await expect.poll(async () => (await clientSaved(page))?.uploads[0]?.receipt?.state).toBe('failed');
  const before = (await clientSaved(page))!, oldItem = before.editable!.items[0]!, firstSpec = api.observations.prepareSpecs[0]!;
  const originals = await page.evaluate(() => window.sessionDraftClient.storage.inventory());
  const seeded = await page.evaluate(async version => {
    await window.sessionDraftClient.client.imageDrafts.close(); window.sessionDraftClient.client.close();
    return window.sessionDraftClient.storage.recreateLegacySchema(version);
  }, version);
  expect(seeded.version).toBe(version); expect(seeded.sourceVersion).toBe(3);
  expect(seeded.drafts.flatMap(draft => draft.items).every(item => item.incarnation === undefined)).toBe(true);
  expect(seeded.blobs).toEqual([{ blobId: oldItem.blobId, byteLength: original.buffer.length, actualSha256: sha256(original.buffer) }]);
  await info.attach('native-legacy-seed', { body: JSON.stringify({ boundary: `${boundary} The legacy format is a controlled fixture rebuilt from production-created records after closing their clients; it was not created by a historical bundle.`, before, seeded }), contentType: 'application/json' });
  await context.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      const request = open.apply(this, args);
      if (args[0] === 'daynight-session-drafts') request.addEventListener('upgradeneeded', event => {
        const evidence = { oldVersion: event.oldVersion, newVersion: event.newVersion, committed: false };
        sessionStorage.setItem('fixture-native-schema-upgrade', JSON.stringify(evidence));
        request.transaction!.addEventListener('complete', () => { evidence.committed = true; sessionStorage.setItem('fixture-native-schema-upgrade', JSON.stringify(evidence)); }, { once: true });
      }, { once: true });
      return request;
    };
  });
  await page.close(); const reopened = await context.newPage();
  try {
    await reopened.goto(clientFixture);
    await expect(reopened.getByRole('textbox')).toBeEditable(); await expect(reopened.getByRole('textbox')).toHaveValue('Caption from the legacy image draft');
    await expect(reopened.locator('.session-draft-item').getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    const restored = (await clientSaved(reopened))!, restoredItem = restored.editable!.items[0]!;
    expect(restoredItem.incarnation).toEqual(expect.any(String)); expect(restoredItem.incarnation).not.toBe(oldItem.incarnation);
    expect(restored.editable).toEqual({ ...before.editable, items: [{ ...oldItem, incarnation: restoredItem.incarnation }] });
    const upgrade = await reopened.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-native-schema-upgrade') ?? 'null'));
    expect(upgrade).toEqual(version === 3 ? null : { oldVersion: version, newVersion: 3, committed: true });
    expect((await reopened.evaluate(() => window.sessionDraftClient.storage.inventory())).blobs).toEqual(originals.blobs);
    expect(api.observations.prepares).toHaveLength(1); expect(api.observations.commands).toEqual([]);
    await reopened.getByRole('button', { name: 'View image: Legacy.png', exact: true }).click();
    await expect(reopened.locator('dialog img')).toHaveJSProperty('naturalWidth', 3); await reopened.keyboard.press('Escape');
    await reopened.locator('.session-draft-item').getByRole('button', { name: 'Retry', exact: true }).click(); await clientReady(reopened);
    const after = (await clientSaved(reopened))!, next = after.editable!.items[0]!;
    expect(next).toMatchObject({ draftImageId: oldItem.draftImageId, incarnation: restoredItem.incarnation, blobId: oldItem.blobId, byteRevision: oldItem.byteRevision });
    expect(after.editable).toMatchObject({ text: before.editable!.text, draftId: before.editable!.draftId, revision: before.editable!.revision, savedAt: before.editable!.savedAt });
    expect(next.imageId).not.toBe(oldItem.imageId); expect(next.uploadId).not.toBe(oldItem.uploadId);
    expect(api.observations.prepareSpecs).toEqual([firstSpec, { ...firstSpec, imageId: next.imageId, uploadId: next.uploadId }]);
    expect(api.uploads.get(oldItem.uploadId!)!.spec).toEqual(firstSpec); expect(Buffer.concat(api.uploads.get(next.uploadId!)!.chunks)).toEqual(original.buffer);
    expect((await reopened.evaluate(() => window.sessionDraftClient.storage.inventory())).blobs).toEqual(originals.blobs);
    await reopened.reload(); await clientReady(reopened); expect((await clientSaved(reopened))!.editable!.items[0]).toEqual(next);
    await expect(reopened.getByRole('textbox')).toHaveValue('Caption from the legacy image draft'); expect(api.observations.prepares).toHaveLength(2);
    await reopened.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(1);
    await expect.poll(async () => (await clientSaved(reopened))?.submission).toBeNull();
    const command = api.observations.commands[0]!; if (command.kind !== 'send_message') throw new Error('Expected the recovered image message.');
    expect(command.payload.content.filter(part => part.type === 'text')).toEqual([{ type: 'text', text: before.editable!.text }]);
    expect(command.payload.content.filter(part => part.type === 'image').map(part => ({ imageId: part.imageId, uploadId: part.uploadId }))).toEqual([{ imageId: next.imageId, uploadId: next.uploadId }]);
    expect(api.observations.identityConflicts).toEqual([]); expect(await reopened.evaluate(() => window.sessionDraftClient.errors)).toEqual([]);
    await info.attach('native-legacy-retry-and-send', { body: JSON.stringify({ boundary, version, upgrade, restored, after, originals, observations: api.observations }), contentType: 'application/json' });
  } finally {
    await info.attach('native-legacy-final-observations', { body: JSON.stringify({ version, seeded, observations: api.observations,
      view: await clientView(reopened).catch(() => null), saved: await clientSaved(reopened).catch(() => null),
      inventory: await reopened.evaluate(() => window.sessionDraftClient.storage.inventory()).catch(() => null),
      upgrade: await reopened.evaluate(() => sessionStorage.getItem('fixture-native-schema-upgrade')).catch(() => null),
      errors: await reopened.evaluate(() => window.sessionDraftClient.errors).catch(() => null),
    }), contentType: 'application/json' });
  }
});


test('keeps an unknown prepare on its original upload and image identities through 404 and explicit retry', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); api.setPrepare('lost_before_create');
  try {
    await page.goto(clientFixture); await expect(page.getByRole('textbox')).toBeEditable(); await page.locator('input[type=file]').setInputFiles(file('Unknown.png'));
    await expect(page.getByRole('button', { name: 'Retry the original upload', exact: true })).toBeEnabled();
    const before = (await clientSaved(page))!, item = before.editable!.items[0]!, spec = api.observations.prepareSpecs[0]!;
    await expect.poll(() => api.observations.uploadQueries.length).toBeGreaterThan(0);
    expect(api.observations.uploadQueries.every(id => id === item.uploadId)).toBe(true); expect(api.observations.prepares).toEqual([item.uploadId]);
    expect(api.observations.commands).toEqual([]); expect(api.uploads.size).toBe(0);
    api.setPrepare('normal'); await page.reload();
    await expect(page.getByRole('button', { name: 'Retry the original upload', exact: true })).toBeEnabled();
    expect((await clientSaved(page))!.editable!.items[0]).toEqual(item); expect(api.observations.prepares).toEqual([item.uploadId]);
    await page.getByRole('button', { name: 'Retry the original upload', exact: true }).click(); await clientReady(page);
    const after = (await clientSaved(page))!;
    expect(after.editable!.items[0]).toEqual(item); expect(api.observations.prepareSpecs).toEqual([spec, spec]); expect(api.observations.prepares).toEqual([item.uploadId, item.uploadId]);
    expect(api.uploads.size).toBe(1); expect(api.observations.identityConflicts).toEqual([]); expect(api.observations.commands).toEqual([]);
    await info.attach('unknown-prepare-original-identity', { body: JSON.stringify({ boundary, before, after }), contentType: 'application/json' });
  } finally {
    await info.attach('unknown-prepare-observations', { body: JSON.stringify({ observations: api.observations, saved: await clientSaved(page).catch(() => null) }), contentType: 'application/json' });
  }
});

for (const scenario of [
  { trigger: 'restore', choice: 'local', sameText: false },
  { trigger: 'send preflight', choice: 'saved', sameText: false },
  { trigger: 'send preflight', choice: 'local', sameText: true },
] as const) test(`preserves an unimported legacy draft at first ${scenario.trigger} before choosing ${scenario.choice}${scenario.sameText ? ' with equal text and unseen remote images' : ''}`, async ({ page, context }, info) => {
  const api = await installDraftAPI(context), localText = 'A unsent local text', remoteText = scenario.sameText ? localText : 'B saved image caption';
  const url = `${clientFixture}?hold-draft-notifications`, peer = await context.newPage();
  let sendFailure: string | null = null;
  try {
    await page.goto(url); await expect(page.getByRole('textbox')).toBeEditable(); await page.getByRole('textbox').fill(localText);
    const legacy = await legacyEntries(page); expect(legacy).toHaveLength(1); expect(legacy[0]!.value.text).toBe(localText);
    expect((await clientView(page)).active).toBe(false); expect(await clientSaved(page)).toBeNull();
    if (scenario.trigger === 'restore') await page.goto('about:blank');
    else await page.evaluate(() => window.sessionDraftClient.notifications.hold());
    await peer.goto(clientFixture); await expect(peer.getByRole('textbox')).toBeEditable(); await peer.getByRole('textbox').fill(remoteText);
    await peer.locator('input[type=file]').setInputFiles(file('B original.png')); await clientReady(peer);
    const remote = (await clientSaved(peer))!, remoteBytes = await peer.evaluate(() => window.sessionDraftClient.storage.inventory());
    if (scenario.trigger === 'restore') await page.goto(url);
    else {
      await expect.poll(() => page.evaluate(() => window.sessionDraftClient.notifications.pending())).toBeGreaterThan(0);
      expect((await clientView(page)).active).toBe(false); await expect(page.getByRole('textbox')).toHaveValue(localText);
      // Calling the public client entry avoids a focus-driven refresh winning
      // the race before send's own preflight reads the other tab's real commit.
      sendFailure = await page.evaluate(async text => { try { await window.sessionDraftClient.client.send(text); return null; } catch (error) { return String(error); } }, localText);
      expect(sendFailure).not.toBeNull();
    }
    await expect.poll(async () => (await clientView(page)).conflict).toBe(true);
    await expect(page.getByRole('textbox')).toHaveValue(localText); expect((await clientView(page)).items).toEqual([]);
    expect(await legacyEntries(page)).toEqual(legacy); expect((await clientSaved(page))!.editable).toEqual(remote.editable);
    expect((await page.evaluate(() => window.sessionDraftClient.storage.inventory())).blobs).toEqual(remoteBytes.blobs);
    expect(api.observations.commands).toEqual([]); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await peer.close();
    await page.getByRole('button', { name: scenario.choice === 'local' ? 'Replace with this window’s draft' : 'Use saved draft', exact: true }).click();
    await clientReady(page); await expect.poll(() => legacyEntries(page)).toEqual([]);
    const chosen = (await clientSaved(page))!, expectedText = scenario.choice === 'local' ? localText : remoteText;
    expect(chosen.editable!.text).toBe(expectedText);
    expect(chosen.editable!.items).toEqual(scenario.choice === 'local' ? [] : remote.editable!.items);
    await page.evaluate(() => window.sessionDraftClient.notifications.release()); await page.reload(); await clientReady(page);
    expect((await clientView(page)).conflict).toBe(false); await expect(page.getByRole('textbox')).toHaveValue(expectedText);
    expect((await clientSaved(page))!.editable!.items).toEqual(chosen.editable!.items); expect(await legacyEntries(page)).toEqual([]); expect(api.observations.commands).toEqual([]);
    await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(1);
    const command = api.observations.commands[0]!; if (command.kind !== 'send_message') throw new Error('Expected only the explicitly chosen draft.');
    expect(command.payload.content.filter(part => part.type === 'text')).toEqual([{ type: 'text', text: expectedText }]);
    expect(command.payload.content.filter(part => part.type === 'image').map(part => part.imageId)).toEqual(chosen.editable!.items.map(item => item.imageId));
    await info.attach('legacy-first-adopt-choice', { body: JSON.stringify({ boundary: `${boundary} Two real tabs keep independent sessionStorage. The send cases delay delivery of real native BroadcastChannel events; committed IndexedDB and production send/restore are unchanged.`, scenario, legacy, remote, remoteBytes, chosen, sendFailure }), contentType: 'application/json' });
  } finally {
    await info.attach('legacy-first-adopt-observations', { body: JSON.stringify({ scenario, sendFailure, view: await clientView(page).catch(() => null), legacy: await legacyEntries(page).catch(() => null), observations: api.observations }), contentType: 'application/json' });
    if (!peer.isClosed()) await peer.close();
  }
});

test('imports a legacy text draft only after the native migration transaction commits', async ({ page, context }, info) => {
  const api = await installDraftAPI(context), legacy = await seedLegacyDraft(page, 'legacy text retained', 'old-draft-revision');
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toHaveValue('legacy text retained');
  await expect(page.getByRole('button', { name: 'Add images' })).toBeEnabled();
  expect(await page.evaluate(() => window.sessionDraftClient.storage.read())).toBeNull();
  await page.evaluate(() => window.sessionDraftClient.storage.armFault('abort')); await page.locator('input[type=file]').setInputFiles(file('Migrated.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().error)).toBe('image_draft_unavailable');
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.storage.writes().filter(write => write.aborted).length)).toBeGreaterThan(0);
  const retainedLegacy = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), legacy.draftKey);
  expect(retainedLegacy).toMatchObject({ text: 'legacy text retained', revision: 'old-draft-revision', submission: null });
  expect(typeof retainedLegacy.ownerKey).toBe('string');
  expect(await page.evaluate(() => window.sessionDraftClient.storage.counts())).toEqual({ owners: 0, drafts: 0, blobs: 0, uploads: 0, submissions: 0 });
  const writes = await page.evaluate(() => window.sessionDraftClient.storage.writes()); expect(writes.every(write => write.requestSucceeded && write.aborted && !write.completed)).toBe(true);
  expect(api.observations.prepares).toEqual([]); expect(api.observations.commands).toEqual([]);
  await page.evaluate(() => window.sessionDraftClient.storage.clearFault()); await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  const imported = (await page.evaluate(() => window.sessionDraftClient.storage.read()))!;
  expect(imported.owner.legacyImported).toBe(true); expect(imported.editable?.text).toBe('legacy text retained'); expect(imported.editable?.items).toHaveLength(1);
  expect(retainedLegacy).toEqual({ text: 'legacy text retained', revision: 'old-draft-revision', submission: null, ownerKey: imported.owner.ownerKey });
  expect(await page.evaluate(key => sessionStorage.getItem(key), legacy.draftKey)).toBeNull();
  await page.reload(); await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().canSend)).toBe(true);
  await expect(page.getByRole('textbox')).toHaveValue('legacy text retained');
  expect((await page.evaluate(() => window.sessionDraftClient.storage.read()))?.editable?.draftId).toBe(imported.editable?.draftId);
  expect(await page.evaluate(() => window.sessionDraftClient.storage.counts())).toMatchObject({ owners: 1, drafts: 1, blobs: 1 });
  await info.attach('native-legacy-migration-commit', { body: JSON.stringify({ boundary, writes, retainedLegacy, imported, restored: await page.evaluate(() => window.sessionDraftClient.storage.read()), observations: api.observations }), contentType: 'application/json' });
});

test('migrates a legacy unknown operation without replay and retains its successor after late acceptance', async ({ page, context }, info) => {
  const api = await installDraftAPI(context), operationId = '00000081-1111-4111-8111-111111111111'; api.setQuery('404');
  const legacy = await seedLegacyDraft(page, 'legacy frozen text', 'legacy-frozen-revision', { operationId, revision: 'legacy-frozen-revision' }); api.seedOperation(legacy.operation!);
  await page.goto('/tests/navigation/session-drafts-client-fixture.html'); await expect(page.getByRole('textbox')).toHaveValue('legacy frozen text');
  await expect.poll(() => api.observations.queries).toContain(operationId);
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.snapshot().checking.size)).toBe(0);
  await expect(page.getByRole('textbox')).toBeEditable();
  expect(await page.evaluate(() => window.sessionDraftClient.storage.read())).toBeNull();
  await page.locator('input[type=file]').setInputFiles(file('Not sent.png'));
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission?.operationId)).toBe(operationId);
  const imported = (await page.evaluate(() => window.sessionDraftClient.storage.read()))!;
  expect(imported.frozen?.text).toBe('legacy frozen text'); expect(imported.submission).toMatchObject({ operationId, state: 'unknown', command: null, legacy: { revision: 'legacy-frozen-revision', kind: 'send_message' } });
  expect(await page.evaluate(key => sessionStorage.getItem(key), legacy.draftKey)).toBeNull(); expect(api.observations.commands).toEqual([]); expect(api.observations.prepares).toEqual([]);
  const queriesBefore = api.observations.queries.length; await page.reload();
  await expect.poll(() => api.observations.queries.length).toBeGreaterThan(queriesBefore);
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().checking)).toBe(false);
  expect((await page.evaluate(() => window.sessionDraftClient.storage.read()))?.submission).toMatchObject({ operationId, state: 'unknown', command: null });
  expect(api.observations.queries.every(id => id === operationId)).toBe(true); expect(api.observations.commands).toEqual([]);
  await page.getByRole('button', { name: 'Continue editing', exact: true }).click(); await page.getByRole('textbox').fill('legacy successor retained'); await page.evaluate(() => window.sessionDraftClient.client.imageDrafts.flush());
  api.setQuery('provider_accepted'); await page.locator('.session-draft-attachments').getByRole('button', { name: 'Check status', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sessionDraftClient.client.imageDrafts.getSnapshot().submission)).toBeNull();
  await expect(page.getByRole('textbox')).toHaveValue('legacy successor retained'); expect(api.observations.commands).toEqual([]);
  expect((await page.evaluate(() => window.sessionDraftClient.storage.read()))?.editable?.text).toBe('legacy successor retained');
  await info.attach('native-legacy-unknown', { body: JSON.stringify({ boundary, imported, settled: await page.evaluate(() => window.sessionDraftClient.storage.read()), observations: api.observations }), contentType: 'application/json' });
});

test('keeps concurrent selections ordered while an earlier original read is delayed', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); await openDraft(page);
  const encoded = pngImage(3, 2).toString('base64');
  await page.evaluate(bytes => {
    const first = new File([Uint8Array.from(atob(bytes), x => x.charCodeAt(0))], 'Slow.png', { type: 'image/png' });
    window.sessionDraftHarness.holdOriginalRead();
    window.draftSelectionProbe = { first: window.sessionDraftHarness.controller.addFiles([first], 'ordered concurrent selection'), second: null };
  }, encoded);
  await expect.poll(() => page.evaluate(() => window.sessionDraftHarness.originalReads().length)).toBe(1);
  const pending = (await saved(page))!.editable!.items[0]!;
  expect(pending).toMatchObject({ label: 'Slow.png', validation: 'pending' });
  expect(pending.blobId).not.toBeNull();
  expect((await page.evaluate(() => window.sessionDraftHarness.originals()))[0]!.sha256).toBe(sha256(pngImage(3, 2)));
  await page.evaluate(bytes => {
    const second = new File([Uint8Array.from(atob(bytes), x => x.charCodeAt(0))], 'Later.png', { type: 'image/png' });
    const probe = window.draftSelectionProbe;
    probe.second = window.sessionDraftHarness.controller.addFiles([second], 'ordered concurrent selection');
  }, encoded);
  // Activation waits for earlier validation before admitting another selection.
  expect((await current(page)).items.map(item => item.label)).toEqual(['Slow.png']);
  expect(await page.evaluate(() => window.sessionDraftHarness.originalReads())).toEqual([pending.draftImageId]); expect(api.observations.prepares).toEqual([]);
  await page.evaluate(async () => { const probe = window.draftSelectionProbe; window.sessionDraftHarness.releaseOriginalRead(); await Promise.all([probe.first, probe.second]); });
  await ready(page, 2);
  expect(await page.evaluate(() => window.sessionDraftHarness.originalReads())).toEqual((await current(page)).items.map(item => item.draftImageId));
  const ordered = (await current(page)).items.map(item => ({ label: item.label, imageId: item.imageId }));
  expect(ordered.map(item => item.label)).toEqual(['Slow.png', 'Later.png']);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => api.observations.commands.length).toBe(1);
  const command = api.observations.commands[0]!; if (command.kind !== 'send_message') throw new Error('Expected the complete ordered image message.');
  expect(command.payload.content.filter(part => part.type === 'image').map(part => part.imageId)).toEqual(ordered.map(item => item.imageId));
  expect(api.observations.completes.map(id => api.uploads.get(id)!.spec.name)).toEqual(['Slow.png', 'Later.png']);
  expect(await page.evaluate(() => window.sessionDraftHarness.pageErrors)).toEqual([]);
  await info.attach('concurrent-selection-order', { body: JSON.stringify({ boundary: `${boundary} The first persisted Blob.arrayBuffer passed to production createLocalAsset is delayed without changing its bytes or metadata; native IndexedDB holds that pending original, and production validation, decoding and upload serialize the later selection.`, ordered, observations: api.observations }), contentType: 'application/json' });
});

test('preserves picker, clipboard and drop order while respecting IME and slash commands', async ({ page, context }) => {
  const api = await installDraftAPI(context); await openDraft(page);
  await page.locator('input[type=file]').setInputFiles([file('Picker A.png'), file('Picker B.png')]); await ready(page, 2);
  const encoded = pngImage(3, 2).toString('base64');
  await page.getByRole('textbox').fill('before after'); await page.getByRole('textbox').evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(7, 7));
  await page.getByRole('textbox').evaluate((input, bytes) => {
    const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(bytes), x => x.charCodeAt(0))], 'Clipboard.png', { type: 'image/png' })); data.setData('text/plain', 'pasted ');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, encoded); await ready(page, 3);
  await expect(page.getByRole('textbox')).toHaveValue('before pasted after');
  await page.getByRole('textbox').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(page.getByRole('textbox')).toHaveValue('before after');
  expect((await current(page)).items).toHaveLength(3);
  await page.locator('form.session-composer').evaluate((form, bytes) => {
    const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(bytes), x => x.charCodeAt(0))], 'Dropped.png', { type: 'image/png' }));
    form.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, encoded); await ready(page, 4);
  expect((await current(page)).items.map(item => item.label)).toEqual(['Picker A.png', 'Picker B.png', 'Clipboard.png', 'Dropped.png']);
  await page.getByRole('textbox').evaluate((input, bytes) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(bytes), x => x.charCodeAt(0))], 'IME.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  }, encoded);
  await expect(page.getByText('Finish composing text, then paste the images again.')).toBeVisible(); expect((await current(page)).items).toHaveLength(4);
  await page.getByRole('textbox').fill('/review'); await expect(page.getByRole('listbox')).toBeVisible();
  const previewTrigger = page.getByRole('button', { name: 'View image: Picker A.png', exact: true });
  await previewTrigger.click(); await expect(page.locator('dialog img')).toHaveJSProperty('naturalWidth', 3); await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(page.locator('dialog')).not.toBeVisible(); await expect(previewTrigger).toBeFocused();
  await page.getByRole('textbox').focus(); await page.getByRole('textbox').press('Enter');
  await expect(page.getByText('Images cannot be used with commands. Remove the images before choosing a command.')).toBeVisible();
  expect(api.observations.commands).toEqual([]); expect(await page.evaluate(() => window.sessionDraftHarness.plainCommands)).toEqual([]);
  await page.getByRole('textbox').fill('/path'); await page.evaluate(() => window.sessionDraftHarness.controller.flush());
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => api.observations.commands.length).toBe(1);
  const command = api.observations.commands[0]!; expect(command.kind).toBe('send_message');
  if (command.kind === 'send_message') expect(command.payload.content.map(part => part.type)).toEqual(['text', 'image', 'image', 'image', 'image']);
});

for (const width of [390, 320]) test(`keeps local previews usable offline with focus and Escape at ${width}px`, async ({ page, context }, info) => {
  const api = await installDraftAPI(context); await page.setViewportSize({ width, height: 844 }); await openDraft(page);
  await page.locator('input[type=file]').setInputFiles(file('Long original name with spaces.png', pngImage(480, 320))); await ready(page, 1);
  await context.setOffline(true);
  const trigger = page.getByRole('button', { name: 'View image: Long original name with spaces.png', exact: true }); await trigger.click();
  const dialog = page.locator('dialog.session-image-preview'), stage = dialog.locator('.session-image-preview-stage');
  await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 480);
  await expect(dialog.getByRole('button', { name: 'Close image preview' })).toBeFocused();
  expect(await stage.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`draft-preview-fit-${width}.png`) });
  await dialog.getByRole('button', { name: 'Original size' }).click();
  await expect.poll(() => dialog.locator('img').evaluate(node => node.getBoundingClientRect().width)).toBe(480);
  expect(await stage.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await stage.evaluate(node => { node.scrollLeft = 100; }); await expect.poll(() => stage.evaluate(node => node.scrollLeft)).toBe(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
  await page.screenshot({ path: info.outputPath(`draft-preview-original-${width}.png`) });
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
  expect((await current(page)).items).toHaveLength(1); expect(api.observations.commands).toEqual([]);
});

test('resolves cross-tab CAS conflicts without losing either local text or original bytes', async ({ page, context }, info) => {
  await installDraftAPI(context); await openDraft(page); await page.locator('input[type=file]').setInputFiles(file()); await ready(page, 1);
  const peer = await context.newPage(); await openDraft(peer); await ready(peer, 1);
  await page.evaluate(() => { window.sessionDraftHarness.holdWrites(); window.sessionDraftHarness.controller.setText('first tab'); });
  await peer.evaluate(() => { window.sessionDraftHarness.holdWrites(); window.sessionDraftHarness.controller.setText('second tab'); });
  await expect.poll(() => page.evaluate(() => window.sessionDraftHarness.writesArrived())).toBe(1);
  await expect.poll(() => peer.evaluate(() => window.sessionDraftHarness.writesArrived())).toBe(1);
  await page.evaluate(() => window.sessionDraftHarness.releaseWrites());
  await expect.poll(async () => (await saved(page))?.editable?.text).toBe('first tab');
  await peer.evaluate(() => window.sessionDraftHarness.releaseWrites());
  await expect.poll(async () => (await current(peer)).conflict).toBe(true);
  await expect(peer.getByRole('textbox')).toHaveValue('second tab'); expect((await saved(peer))?.editable?.text).toBe('first tab');
  await peer.getByRole('button', { name: 'Replace with this window’s draft' }).click();
  await expect.poll(async () => (await saved(peer))?.editable?.text).toBe('second tab');
  await expect.poll(async () => (await current(peer)).conflict).toBe(false);
  expect((await peer.evaluate(() => window.sessionDraftHarness.originals()))[0]!.sha256).toBe(sha256(file().buffer));
  await info.attach('cross-tab-CAS', { body: JSON.stringify({ boundary, saved: await saved(peer), local: await current(peer) }), contentType: 'application/json' });
});

test('refuses a second tab while the native send lock is held and sends once after release', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); await openDraft(page); await page.locator('input[type=file]').setInputFiles(file()); await ready(page, 1);
  const peer = await context.newPage(); await openDraft(peer); await ready(peer, 1);
  await page.evaluate(() => window.sessionDraftHarness.holdLock('send'));
  const locks = await page.evaluate(() => navigator.locks.query()); expect(locks.held).toHaveLength(1);
  await peer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await current(peer)).error).toBe('image_another_window_busy'); expect(api.observations.commands).toEqual([]);
  await page.evaluate(() => window.sessionDraftHarness.releaseLock());
  await peer.evaluate(() => window.sessionDraftHarness.controller.send());
  await expect.poll(() => api.observations.commands.length).toBe(1);
  await expect.poll(async () => (await saved(peer))?.submission).toBeNull();
  await info.attach('native-send-lock', { body: JSON.stringify({ boundary, locks, commands: api.observations.commands }), contentType: 'application/json' });
});

test('reopens a claimed dispatch by querying the original operation and retains unknown after HTTP 404', async ({ page, context }, info) => {
  const api = await installDraftAPI(context); api.setDispatch('held'); api.setQuery('404');
  try {
    await openDraft(page); await page.locator('input[type=file]').setInputFiles(file('Frozen.png')); await ready(page, 1);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => api.observations.commands.length).toBe(1);
    const before = await saved(page), operationId = api.observations.commands[0]!.operationId;
    expect(before?.submission?.state).toBe('dispatch_claimed'); expect(before?.submission?.operationId).toBe(operationId);
    await page.close(); await api.cleanup(); const peer = await context.newPage(); await openDraft(peer);
    await expect.poll(() => api.observations.queries.length).toBeGreaterThan(0);
    await expect.poll(async () => (await current(peer)).checking).toBe(false);
    const recovered = await saved(peer); expect(recovered?.submission?.operationId).toBe(operationId); expect(recovered?.submission?.state).toBe('unknown');
    expect(api.observations.commands).toHaveLength(1); expect(api.observations.queries.every(id => id === operationId)).toBe(true);
    await peer.getByRole('button', { name: 'Continue editing', exact: true }).click(); await peer.getByRole('textbox').fill('successor retained'); await peer.evaluate(() => window.sessionDraftHarness.controller.flush());
    api.setQuery('confirmed'); await peer.getByRole('button', { name: 'Check status', exact: true }).click();
    await expect.poll(async () => (await saved(peer))?.submission).toBeNull(); await expect(peer.getByRole('textbox')).toHaveValue('successor retained');
    await info.attach('claimed-dispatch-recovery', { body: JSON.stringify({ boundary, before, recovered, settled: await saved(peer), observations: api.observations }), contentType: 'application/json' });
  } finally { await api.cleanup(); }
});

for (const count of [8, 9]) test(`${count} selected originals preserve the full candidate decision`, { tag: '@capacity' }, async ({ page, context }) => {
  const api = await installDraftAPI(context); await openDraft(page);
  await page.locator('input[type=file]').setInputFiles(Array.from({ length: count }, (_, index) => file(`${index + 1}.png`)));
  if (count === 8) { await ready(page, 8); expect(api.observations.prepares).toHaveLength(8); }
  else {
    await expect.poll(async () => (await current(page)).items.filter(item => item.validation === 'valid').length).toBe(8);
    expect((await current(page)).rejectedCandidates).toHaveLength(1); expect(api.observations.prepares).toEqual([]);
    await page.reload(); await expect.poll(async () => (await current(page)).rejectedCandidates.length).toBe(1);
    expect((await current(page)).canSend).toBe(false); expect(api.observations.prepares).toEqual([]);
  }
});

const smallerProfile = { maxImageBytes: '1024', maxMessageImageBytes: '1536', maxImagesPerMessage: 2 };
for (const item of [
  { title: '8 MiB plus one byte', sizes: [8 * 1_048_576 + 1], eligible: true },
  { title: '10 MiB minus one byte', sizes: [10 * 1_048_576 - 1], eligible: true },
  { title: '10 MiB exactly', sizes: [10 * 1_048_576], eligible: true },
  { title: '10 MiB plus one byte', sizes: [10 * 1_048_576 + 1], eligible: false },
  { title: '20 MiB minus one byte', sizes: [10 * 1_048_576, 10 * 1_048_576 - 1], eligible: true },
  { title: '20 MiB exactly', sizes: [10 * 1_048_576, 10 * 1_048_576], eligible: true },
  { title: '20 MiB plus one byte', sizes: [10 * 1_048_576, 10 * 1_048_576 - 127, 128], eligible: false },
  { title: 'smaller profile image limit minus one byte', sizes: [1023], eligible: true, profile: smallerProfile },
  { title: 'smaller profile image limit exactly', sizes: [1024], eligible: true, profile: smallerProfile },
  { title: 'smaller profile image limit plus one byte', sizes: [1025], eligible: false, profile: smallerProfile, issue: 'image_byte_limit' },
  { title: 'smaller profile message limit minus one byte', sizes: [768, 767], eligible: true, profile: smallerProfile },
  { title: 'smaller profile message limit exactly', sizes: [768, 768], eligible: true, profile: smallerProfile },
  { title: 'smaller profile message limit plus one byte', sizes: [768, 769], eligible: false, profile: smallerProfile, issue: 'image_message_limit' },
  { title: 'smaller profile image count plus one', sizes: [128, 128, 128], eligible: false, profile: smallerProfile, issue: 'image_count_limit' },
]) test(`valid PNG originals enforce ${item.title}`, { tag: '@capacity' }, async ({ page, context }, info) => {
  const api = await installDraftAPI(context, 'profile' in item ? item.profile : {}); await openDraft(page);
  const files = item.sizes.map((size, index) => file(`${index}.png`, exactPng(size)));
  await page.locator('input[type=file]').setInputFiles(files);
  if (item.eligible) {
    await ready(page, files.length);
    expect((await page.evaluate(() => window.sessionDraftHarness.originals())).map(value => value.size)).toEqual(item.sizes);
    expect(api.observations.completes).toHaveLength(files.length);
  } else {
    if ('issue' in item) await expect.poll(async () => (await current(page)).disabledReason).toBe(item.issue);
    else await expect.poll(async () => { const view = await current(page); return view.items.length === files.length && (view.error !== null || view.items.some(image => image.error !== null) || view.disabledReason === 'image_message_limit'); }).toBe(true);
    expect((await current(page)).canSend).toBe(false); expect(api.observations.prepares).toEqual([]);
  }
  expect((await current(page)).items.map(image => image.label)).toEqual(files.map(image => image.name));
  expect(api.observations.commands).toEqual([]);
  await info.attach('input-byte-boundary', { body: JSON.stringify({ boundary, title: item.title, sizes: item.sizes, profile: 'profile' in item ? item.profile : null, view: await current(page), observations: api.observations }), contentType: 'application/json' });
});

test('keeps a smaller model profile authoritative before any upload', async ({ page, context }) => {
  const api = await installDraftAPI(context, { maxImageBytes: '1024', maxMessageImageBytes: '1536', maxImagesPerMessage: 2 });
  await openDraft(page); await page.locator('input[type=file]').setInputFiles([file('small A.png', exactPng(1024)), file('small B.png', exactPng(1024))]);
  await expect.poll(async () => (await current(page)).items.filter(item => item.validation === 'valid').length).toBe(2);
  await expect.poll(async () => (await current(page)).saving).toBe(false);
  expect((await current(page)).disabledReason).toBe('image_message_limit'); expect(api.observations.prepares).toEqual([]);
  await page.getByRole('button', { name: 'Remove image: small B.png', exact: true }).click(); await ready(page, 1);
  expect(api.observations.prepares).toHaveLength(1);
});

declare global { interface Window { draftSelectionProbe: { first: Promise<void>; second: Promise<void> | null } } }
