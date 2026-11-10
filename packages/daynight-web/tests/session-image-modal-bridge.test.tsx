import { createRef } from 'react';
import { expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { TaskConfirmation } from '../src/features/task-detail/TaskConfirmation';
import { ImagePreviewController, imagePreviewModalSnapshot } from '../src/features/task-agent-session/images/image-preview';

it('suspends image top-layer ownership before a Task confirmation takes focus and resumes on exit', () => {
  const owner = createRef<HTMLElement>(), fallback = createRef<HTMLButtonElement>();
  const root = document.createElement('section'), opener = document.createElement('button');
  root.append(opener); document.body.append(root); owner.current = root; fallback.current = opener; opener.focus();
  const controller = new ImagePreviewController(() => true);
  const suspend = vi.fn(() => { expect(document.activeElement).toBe(opener); expect(root).not.toHaveAttribute('inert'); });
  const detach = controller.attach({ suspend, close: vi.fn(), focus: vi.fn() });
  try {
    const view = createLocaleRender('en')(<TaskConfirmation title="Confirm" question="Continue?" explanation="" taskTitle="Task" confirmLabel="Continue" cancelLabel="Cancel" closeLabel="Close" owner={owner} fallbackFocus={fallback} onCancel={() => {}} onConfirm={() => {}} />);
    expect(suspend).toHaveBeenCalledOnce();
    expect(imagePreviewModalSnapshot()).toBe(true);
    expect(view.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    view.unmount();
    expect(imagePreviewModalSnapshot()).toBe(false);
    expect(opener).toHaveFocus();
  } finally { detach(); root.remove(); }
});
