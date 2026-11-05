import { test } from './fixtures';
import { verifySessionFooter } from './session-footer';

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? 'Touch Session footer' : 'Mouse Session footer', () => {
    test.use({ hasTouch });
    test('keeps semantic rows, complete controls and keyboard order on actual Task pages', {
      annotation: { type: 'scenario', description: hasTouch ? 'session-footer-touch' : 'session-footer-mouse' },
    }, async ({ page, api, baseURL, allowBrowserWrites }, info) => {
      await verifySessionFooter(page, api, baseURL!, info, allowBrowserWrites);
    });
  });
}
