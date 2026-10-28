import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import type { TimelineEntry } from '../src/api/types';
import { createLocaleRender } from './helpers/renderWithLocale';
const render = createLocaleRender('en');
const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };
const message = (id: string, text: string): TimelineEntry => ({ kind: 'assistant_message', entryId: id, entrySeq: id, revision: '1', content: [{ type: 'text', text }] });
const show = (entries: TimelineEntry[]) => render(<SessionTimeline state={{ ...emptySessionState(), entries }} {...props} />);
it('does not offer empty reasoning disclosures and shows later readable content', () => {
  const empty: TimelineEntry = { kind: 'reasoning', entryId: '2', entrySeq: '2', revision: '1', text: ' \n\t' };
  const view = show([message('1', 'Working'), empty]);
  expect(view.container.querySelector('.session-reasoning')).toBeNull();
  expect(view.container.querySelector('[data-entry-key="2"]')).toBeNull();
  view.rerender(<SessionTimeline state={{ ...emptySessionState(), entries: [message('1', 'Working'), { ...empty, revision: '2', text: 'A readable summary' }] }} {...props} />);
  expect(view.container.querySelector('[data-entry-key="2"] .session-reasoning')).not.toBeNull();
});
it('uses a readable command label while keeping the complete input available on expansion', async () => {
  const input = 'git diff --stat; ' + 'printf detail; '.repeat(50);
  const view = show([{ kind: 'tool_call', entryId: '1', entrySeq: '1', revision: '1', callId: 'c', name: 'commandExecution', input, output: [], status: 'completed', truncated: false }]);
  expect(screen.getByText('Command')).toBeInTheDocument();
  expect(screen.queryByText('commandExecution')).toBeNull();
  await expand(view.container.querySelector('details')!);
  expect(view.container.querySelector('.session-tool-input')?.textContent).toBe(input);
});
async function expand(details: HTMLDetailsElement) { details.open = true; fireEvent(details, new Event('toggle')); await waitFor(() => expect(details.querySelector('pre, .markdown-content')).not.toBeNull()); }
it('preserves raw tool output with keyboard access and an identifiable failure', async () => {
  const output = '# literal\n*literal*\n  indented\n' + 'last\n'.repeat(500);
  const view = show([{ kind: 'tool_call', entryId: '1', entrySeq: '1', revision: '1', callId: 'c', name: 'Bash', input: '{"command":"printf literal"}', output: [{ type: 'text', text: output }], status: 'failed', truncated: true }]);
  expect(screen.getByText('printf literal')).toBeInTheDocument();
  expect(screen.getByText('Failed')).toBeInTheDocument();
  await expand(view.container.querySelector('details')!);
  const result = Array.from(view.container.querySelectorAll('pre')).find(pre => pre.textContent === output);
  expect(result).toBeDefined(); expect(result).toHaveAttribute('tabindex', '0'); expect(result).toHaveClass('session-tool-output');
  expect(view.container.querySelector('h1')).toBeNull(); expect(screen.getByText(/Output is truncated/)).toBeInTheDocument();
});
it('preserves message line breaks and renders expanded reasoning with Markdown', async () => {
  const view = show([message('1', 'first\nsecond'), { kind: 'reasoning', entryId: '2', entrySeq: '2', revision: '1', text: '**Plan**\n\n- inspect\n- verify' }]);
  expect(view.container.querySelector('.assistant_message br')).not.toBeNull();
  await expand(view.container.querySelector('details')!);
  expect(view.container.querySelector('.session-reasoning strong')?.textContent).toBe('Plan'); expect(view.container.querySelectorAll('.session-reasoning li')).toHaveLength(2);
});
it('isolates footnote navigation without enabling file or arbitrary fragment links', () => {
  const text = 'Footnote[^1]\n\n[^1]: note\n\n[unsafe](file:///etc/passwd) [relative](/etc/passwd) [foreign](#elsewhere) [safe](https://example.com)';
  const view = show([message('1', text), message('2', text)]);
  const links = Array.from(view.container.querySelectorAll<HTMLAnchorElement>('a[data-footnote-ref]'));
  expect(links).toHaveLength(2); expect(links[0]!.getAttribute('href')).not.toBe(links[1]!.getAttribute('href'));
  for (const link of links) {
    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    expect(target).not.toBeNull(); expect(link.closest('[data-entry-key]')).toBe(target!.closest('[data-entry-key]'));
    expect(link).not.toHaveAttribute('target'); expect(document.getElementById(link.getAttribute('aria-describedby')!)).not.toBeNull();
  }
  const backlinks = Array.from(view.container.querySelectorAll<HTMLAnchorElement>('a[data-footnote-backref]'));
  expect(backlinks).toHaveLength(2);
  for (const link of backlinks) {
    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    expect(target).not.toBeNull();
    expect(link.closest('[data-entry-key]')).toBe(target!.closest('[data-entry-key]'));
    expect(link).not.toHaveAttribute('target');
  }
  expect(view.container.querySelector('a[href^="file:"], a[href="/etc/passwd"], a[href="#elsewhere"]')).toBeNull();
  expect(screen.getAllByRole('link', { name: 'safe' })[0]).toHaveAttribute('rel', 'noopener noreferrer');
});
it('offers keyboard access to wide Markdown tables', () => {
  show([message('1', '| Name | Value |\n| --- | --- |\n| x | y |')]);
  expect(screen.getByRole('region', { name: 'Markdown table' })).toHaveAttribute('tabindex', '0');
});

it('renders native cancellation diagnostics neutrally while preserving real failures', () => {
  const diagnostic = (id: string, code: string): TimelineEntry => ({ kind: 'error', entryId: id, entrySeq: id, revision: '1', code, message: 'Native diagnostic details' });
  show([diagnostic('1', 'input_cancelled'), diagnostic('2', 'turn_interrupted'), diagnostic('3', 'native_result_error')]);
  expect(screen.getByText('Queued message cancelled')).toBeInTheDocument();
  expect(screen.getByText('Turn interrupted')).toBeInTheDocument();
  expect(screen.getAllByRole('status')).toHaveLength(2);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByRole('alert')).toHaveTextContent('native_result_error');
  expect(screen.getByRole('alert')).toHaveTextContent('Native diagnostic details');
});
