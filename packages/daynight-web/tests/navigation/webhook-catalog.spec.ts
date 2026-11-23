import { expect, test, type Locator } from '@playwright/test';
import { inboxEndpointId, installCatalog, normalId, projectId, taskId } from './webhook-catalog-fixture';

const ordinaryOrder = ['task.status_changed', 'task.created', 'task.deleted', 'task.step_updated', 'task.thread_posted', 'task.paused'];
const inboxOrder = ['Task created', 'Task status changed', 'Task paused', 'Task deleted', 'Task step changed', 'Discussion message'];
const ordinaryEvents = (dialog: Locator) => dialog.locator('.event-checks label strong');

for (const includeSteps of [false, true]) {
  test(`ordinary create and subscription edit use the ${includeSteps ? 'six' : 'five'}-event catalog`, async ({ page }) => {
    const state = await installCatalog(page, includeSteps);
    await page.goto('/webhooks?owner=personal');
    await page.getByRole('button', { name: 'New webhook', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(ordinaryEvents(dialog)).toHaveText(ordinaryOrder.filter(event => includeSteps || event !== 'task.step_updated'));
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Created receiver');
    await dialog.getByRole('textbox', { name: 'Endpoint URL', exact: true }).fill('https://receiver.example/new');
    await dialog.getByRole('checkbox', { name: /Alpha/ }).check();
    await dialog.getByRole('checkbox', { name: /^task.created/ }).check();
    await dialog.getByRole('button', { name: 'Create webhook', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.writes[0]).toMatchObject({ method: 'POST', path: '/api/v1/me/webhooks', body: { subscriptions: [{ id: null, projectId, eventTypes: ['task.created'] }] } });
    await page.goto(`/webhooks?owner=personal&endpointId=${normalId}&tab=subscriptions`);
    await page.getByRole('button', { name: 'Edit subscription Alpha', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: /^task.created/ })).toBeChecked();
    await expect(ordinaryEvents(dialog)).toHaveText(ordinaryOrder.filter(event => includeSteps || event !== 'task.step_updated'));
    await dialog.getByRole('checkbox', { name: /^task.paused/ }).check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.writes[1]).toMatchObject({ method: 'PATCH', path: `/api/v1/me/webhooks/${normalId}`, body: { ifVersion: '1', subscriptions: [{ projectId, eventTypes: ['task.created', 'task.paused'] }] } });
    expect(state.unexpected).toEqual([]);
  });

  for (const existing of [false, true]) test(`Inbox ${existing ? 'edits' : 'creates'} with the ${includeSteps ? 'six' : 'five'}-event catalog`, async ({ page }) => {
    const state = await installCatalog(page, includeSteps, existing);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/bots/tasks/${taskId}?tab=inbox`);
    const panel = page.locator('.assistant-task-subscriptions');
    if (!existing) await panel.getByRole('checkbox', { name: 'Alpha', exact: true }).check();
    const group = panel.getByRole('group', { name: 'Event types for Alpha', exact: true });
    await expect(group.locator('label span')).toHaveText(inboxOrder.filter(event => includeSteps || event !== 'Task step changed'));
    if (existing) await expect(group.getByRole('checkbox', { name: 'Task created', exact: true })).toBeChecked();
    else await group.getByRole('checkbox', { name: 'Task created', exact: true }).check();
    await group.getByRole('checkbox', { name: 'Task paused', exact: true }).check();
    await panel.getByRole('button', { name: existing ? 'Save subscription' : 'Create subscription', exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0]).toMatchObject({ method: existing ? 'PATCH' : 'POST', path: existing ? `/api/v1/me/webhooks/${inboxEndpointId}` : '/api/v1/me/webhooks', body: { subscriptions: [{ projectId, eventTypes: ['task.created', 'task.paused'] }] } });
    await expect(panel.getByRole('button', { name: 'Save subscription', exact: true })).toBeEnabled();
    await expect(group.getByRole('checkbox', { name: 'Task paused', exact: true })).toBeChecked();
    expect(state.unexpected).toEqual([]);
  });
}
