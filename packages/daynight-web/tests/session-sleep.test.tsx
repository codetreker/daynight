import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CodexProjection } from '../../daynight/src/commands/controller/providers/projection';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import type { TimelineEntry } from '../src/api/types';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };

it('renders native sleep as one expandable tool row through completion and history', async () => {
  let entries: TimelineEntry[] = [];
  const projection = new CodexProjection('native-thread', entry => { entries = [{ ...entry, entrySeq: '1' }]; });
  const sleep = { type: 'sleep', id: 'sleep-call', durationMs: 50000, startedAtMs: 1793708507841 };
  projection.item(sleep, false);
  const view = render(<SessionTimeline state={{ ...emptySessionState(), entries }} {...props} />);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('clock.sleep')).toBeInTheDocument();
  expect(screen.getByText('Running')).toBeInTheDocument();
  expect(screen.getByText('Wait up to 50 seconds (requested)')).toBeInTheDocument();
  const row = view.container.querySelector('[data-entry-key]');
  projection.item({ ...sleep, completedAtMs: 1793708557843 }, true);
  view.rerender(<SessionTimeline state={{ ...emptySessionState(), entries }} {...props} />);
  expect(view.container.querySelectorAll('[data-entry-key]')).toHaveLength(1);
  expect(view.container.querySelector('[data-entry-key]')).toBe(row);
  expect(screen.getByText('Completed')).toBeInTheDocument();
  expect(screen.queryByText('Running')).toBeNull();
  const details = view.container.querySelector('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(view.container.querySelector('.session-tool-input')).toHaveTextContent('Wait up to 50 seconds (requested)'));
  expect(screen.queryByRole('alert')).toBeNull();
  view.unmount();
  render(<SessionTimeline state={{ ...emptySessionState(), entries }} {...props} active={false} />);
  expect(screen.getByText('clock.sleep')).toBeInTheDocument();
  expect(screen.getByText('Completed')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});
