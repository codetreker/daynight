import type { Page } from '@playwright/test';

export async function navigateNativeSelect(page: Page, arrow: 'ArrowDown' | 'ArrowUp', character: string): Promise<void> {
  if (!await page.evaluate(() => navigator.platform.startsWith('Mac'))) {
    await page.keyboard.press(arrow);
    return;
  }

  // Headless macOS arrow navigation does not commit a native selection.
  // CDP character keys preserve native typeahead, including non-ASCII labels.
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character, unmodifiedText: character });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
  } finally {
    await session.detach();
  }
}
