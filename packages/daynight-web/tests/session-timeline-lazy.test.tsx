import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';
const markdown = vi.hoisted(() => vi.fn());
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => { markdown(children); return <p>{children}</p>; } }));
const render = createLocaleRender('en');
it('mounts tool details on expansion and preserves the entry across unrelated receipt updates', async () => {
  const state = { ...emptySessionState(), entries: [{ kind: 'tool_call' as const, entryId: 'tool', entrySeq: '1', revision: '1', callId: 'call', name: 'shell', input: 'pwd', output: [{ type: 'text' as const, text: 'long tool result' }], status: 'completed' as const, truncated: false }] };
  const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };
  const view = render(<SessionTimeline state={state} {...props} />);
  expect(markdown).not.toHaveBeenCalled();
  expect(screen.queryByText('long tool result')).toBeNull();
  const details = screen.getByText('shell').closest('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(screen.getByText('long tool result')).toBeInTheDocument());
  const count = markdown.mock.calls.length;
  view.rerender(<SessionTimeline state={{ ...state, operations: new Map() }} {...props} />);
  expect(markdown).toHaveBeenCalledTimes(count);
  expect(details.open).toBe(true);
});

it('retains the native identifier and input when opening a shortened tool name', async () => {
  const name = 'mcp__workspace_repository__find_current_public_release_notes';
  const state = { ...emptySessionState(), entries: [{ kind: 'tool_call' as const, entryId: 'tool', entrySeq: '1', revision: '1', callId: 'call', name, input: '{"query":"release"}', output: [], status: 'running' as const, truncated: false }] };
  const view = render(<SessionTimeline state={state} active canRespond={false} onRespond={async () => {}} hasOlder={false} loadingOlder={false} onLoadOlder={async () => {}} onLoadResource={async () => new Blob()} />);
  const summary = view.container.querySelector('summary')!;
  expect(summary).toHaveAccessibleName(`${name} · release · Running`);
  expect(summary.querySelector('.session-tool-name-compact')).toHaveTextContent('find_…_release_notes');
  expect(view.container.querySelector('.session-tool-exact-name')).toBeNull();
  const details = summary.closest('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(view.container.querySelector('.session-tool-exact-name')).toHaveTextContent(name));
  expect(view.container.querySelector('.session-tool-input')).toHaveTextContent('{"query":"release"}');
  expect(screen.getByText('No output.')).toBeInTheDocument();
});
