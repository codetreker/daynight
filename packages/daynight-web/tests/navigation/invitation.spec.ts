import { expect, test } from '@playwright/test';

const user = {
  personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal', name: null },
  id: '00000000-0000-4000-8000-000000000001', name: 'Test User',
  email: 'test@example.com', emailVerified: true, avatarUrl: null,
};
const team = { id: '00000000-0000-4000-8000-000000000010', kind: 'ordinary', name: 'Invited Team' };
const catalog = {
  items: ['task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted'].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: 'project' })),
  service: { configurationExpansionAvailable: true, dispatchEnabled: false },
  limits: { policyVersion: '1', requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86400, maxManualOperations: 3, payloadRetentionSeconds: 2592000, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 },
};

for (const scope of ['project', 'team'] as const) {
  for (const blocked of [false, true]) {
    test(`${scope} invitation stays out of browser history with session storage ${blocked ? 'blocked' : 'available'}`, async ({ page }) => {
      const inspections: string[] = [];
      const accepts: string[] = [];
      const unexpected: string[] = [];
      await page.addInitScript((storageBlocked) => {
        localStorage.setItem('daynight.web.locale', 'en');
        const writes: string[] = [];
        Object.defineProperty(window, 'invitationHistoryWrites', { value: writes });
        for (const name of ['pushState', 'replaceState'] as const) {
          const original = history[name];
          history[name] = function (state, ...args) {
            writes.push(JSON.stringify(state));
            return original.call(this, state, ...args);
          };
        }
        if (storageBlocked) {
          for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
            const original = Storage.prototype[method];
            Object.defineProperty(Storage.prototype, method, { configurable: true, value: function (this: Storage, ...args: string[]) {
              if (this === sessionStorage) throw new DOMException('Owned session-storage test fault', 'SecurityError');
              return Reflect.apply(original, this, args);
            } });
          }
        }
      }, blocked);
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        let body: unknown;
        if (path === '/api/v1/me') body = user;
        else if (path === '/api/v1/auth/providers') body = { providers: ['github'] };
        else if (request.method() === 'GET' && path === '/api/v1/teams') body = { items: [], nextCursor: null };
        else if (request.method() === 'GET' && path === '/api/v1/webhook-event-types') body = catalog;
        else if (path === '/api/v1/invitations/inspect') {
          inspections.push(request.postDataJSON().token);
          body = { projectId: team.id, projectName: 'Invited project', directGrant: null, access: null };
        } else if (path === '/api/v1/team-invitations/inspect') {
          inspections.push(request.postDataJSON().token);
          body = { team, membership: null };
        } else if (path.endsWith('/accept')) {
          accepts.push(path);
          body = {};
        } else if (path.startsWith('/api/v1/projects')) body = { items: [], nextCursor: null };
        else {
          unexpected.push(path);
          body = {};
        }
        await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Daynight-User-ID': user.id }, body: JSON.stringify(body) });
      });
      const serializedHistory = () => page.evaluate(() => JSON.stringify({
        state: window.history.state,
        writes: (window as unknown as { invitationHistoryWrites: readonly string[] }).invitationHistoryWrites,
      }));
      const path = scope === 'project' ? '/invitations' : '/team-invitations';
      const token = `synthetic-${scope}-invitation`;
      await page.goto(`${path}#${token}`);
      await expect(page.getByRole('button', { name: 'Accept invitation and join', exact: true })).toBeVisible();
      expect(new URL(page.url()).hash).toBe('');
      expect(await serializedHistory()).not.toContain(token);
      expect(inspections).toEqual([token]);

      await page.getByRole('button', { name: 'Not now', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Invitation unavailable', exact: true })).toBeVisible();
      expect(new URL(page.url()).hash).toBe('');
      expect(await serializedHistory()).not.toContain(token);
      expect(inspections).toEqual([token]);

      const nativeToken = `synthetic-native-${scope}`;
      await page.evaluate((fragment) => { location.hash = fragment; }, nativeToken);
      await expect(page.getByRole('button', { name: 'Accept invitation and join', exact: true })).toBeVisible();
      expect(new URL(page.url()).hash).toBe('');
      expect(await serializedHistory()).not.toContain(nativeToken);
      expect(await page.evaluate(() => window.history.state?.__daynightNavigation)).toBeUndefined();
      expect(inspections).toEqual([token, nativeToken]);
      expect(accepts).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
}
