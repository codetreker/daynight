import { fireEvent, screen, within } from '@testing-library/react';
import { vi } from 'vitest';

export const assistantNameInput = () => screen.getByRole('textbox', { name: /^(Name|名称)$/ });

export function assistantCreateSubmit() {
  const form = (assistantNameInput() as HTMLInputElement).form;
  if (!form) throw new Error('The assistant name must belong to its creation form.');
  return within(form).getByRole('button', { name: /^(Create assistant|创建助手)$/ });
}

export function openAssistantCreation() {
  const opener = screen.getByRole('button', { name: /^(Create assistant|创建助手)$/ });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

export function expandAssistantAdvancedSettings() {
  fireEvent.click(screen.getByText(/^(Advanced settings|高级设置)$/));
}

export function assistantDetailsOpener(name: string) {
  return screen.queryByRole('button', { name: /^(Assistant details|Details|助手详情|详情)$/ })
    ?? screen.getByRole('button', { name });
}

export function pressAssistantEscape(target: Element = document.activeElement ?? document.body) {
  const unhandled = fireEvent.keyDown(target, { key: 'Escape', code: 'Escape' });
  // JSDOM has no native Escape default action. Only supply cancel when an
  // application key handler has not handled Escape and a native dialog is open.
  const modal = target.closest('dialog[open]') ?? document.querySelector('dialog[open]');
  if (unhandled && modal) fireEvent(modal, new Event('cancel', { bubbles: false, cancelable: true }));
}

export function mockWideAssistantWorkspace() {
  vi.stubGlobal('innerWidth', 1440);
  // JSDOM has no layout. Supply generous content width without changing height,
  // so focus/state tests do not accidentally exercise a zero-width drawer.
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const measured = rect.call(this);
    return new DOMRect(measured.x, measured.y, 1040, measured.height);
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1040);
}
