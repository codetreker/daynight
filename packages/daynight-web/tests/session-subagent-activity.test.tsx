import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CodexProjection } from '../../daynight/src/commands/controller/providers/projection';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import type { TimelineEntry } from '../src/api/types';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const activity = { type: 'subAgentActivity', id: 'activity-1', kind: 'started', agentPath: '/root/relay_research', agentThreadId: 'child-thread', model: 'gpt-6-astra', reasoningEffort: 'medium', startedAtMs: 1793708973702, completedAtMs: 1793708973702 };
const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };
const show = (entries: TimelineEntry[]) => render(<SessionTimeline state={{ ...emptySessionState(), entries }} {...props} />);
const legacy = (message: string, code = 'unsupported_native_item'): TimelineEntry => ({ kind: 'error', code, message, entryId: '1', entrySeq: '1', revision: '1' });
const prefix = 'Unsupported native timeline item: subAgentActivity. ';

it('renders a projected activity as a collapsed operation without opening the child session', () => {
  const entries: TimelineEntry[] = [];
  new CodexProjection('parent', entry => entries.push({ ...entry, entrySeq: '1' })).item(activity, true);
  const view = show(entries);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Start subagent')).toBeInTheDocument();
  expect(screen.getByText('/root/relay_research')).toBeInTheDocument();
  expect(view.container.querySelector('details')).not.toHaveAttribute('open');
  expect(screen.queryByRole('link')).toBeNull();
});

it('renders a stored misclassification neutrally and keeps metadata available without inventing child status', async () => {
  const view = show([legacy(prefix + JSON.stringify(activity))]);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Start subagent')).toBeInTheDocument();
  expect(screen.getByText('/root/relay_research')).toBeInTheDocument();
  expect(screen.queryByText('Completed')).toBeNull();
  expect(view.container.querySelector('details')).not.toHaveAttribute('open');
  const details = view.container.querySelector('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(view.container.querySelector('pre')).toHaveTextContent('child-thread'));
  expect(screen.queryByRole('link')).toBeNull();
});

it.each([
  [prefix + '{broken', 'unsupported_native_item'],
  [prefix + JSON.stringify({ ...activity, type: 'other' }), 'unsupported_native_item'],
  [prefix + JSON.stringify({ ...activity, id: '' }), 'unsupported_native_item'],
  [prefix + JSON.stringify(activity), 'native_result_error'],
  ['Unsupported native timeline item: other. ' + JSON.stringify(activity), 'unsupported_native_item'],
])('preserves unrelated or malformed errors: %s (%s)', (message, code) => {
  show([legacy(message, code)]);
  expect(screen.getByRole('alert')).toHaveTextContent(code);
});
