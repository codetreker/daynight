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
it.each([
  ['commandExecution', '/bin/zsh -lc date', 'date'],
  ['commandExecution', 'sh -c echo', 'echo'],
  ['commandExecution', 'sh -c ./bin/check_v1.2-rc:+@%,', './bin/check_v1.2-rc:+@%,'],
  ['commandExecution', "sh -c echo' ok'", 'echo ok'],
  ['commandExecution', "sh -c 'echo 'hello", 'echo hello'],
  ['commandExecution', `sh -c ec"ho"' ok'`, 'echo ok'],
  ['commandExecution', String.raw`sh -c echo\ ok`, 'echo ok'],
  ['commandExecution', "/bin/zsh -lc 'find . -maxdepth 1 -type f | wc -l'", 'find . -maxdepth 1 -type f | wc -l'],
  ['commandExecution', String.raw`/bin/bash -lc "printf '%s\\n' \"hello\" && echo \$HOME"`, String.raw`printf '%s\n' "hello" && echo $HOME`],
  ['commandExecution', String.raw`/usr/bin/dash -c 'printf '\''hello'\'''`, "printf 'hello'"],
  ['commandExecution', `ksh -c 'printf '"'"'hello'"'"''`, "printf 'hello'"],
  ['commandExecution', String.raw`sh -c "printf '\q'"`, String.raw`printf '\q'`],
  ['commandExecution', 'sh -c "echo first\\\nsecond"', 'echo firstsecond'],
  ['commandExecution', '  bash\t-lc\t\'echo first\nsecond\'  ', 'echo first second'],
  ['commandExecution', "sh -c ''", ''],
  ['commandExecution', `bash -lc 'sh -c "echo nested"'`, 'sh -c "echo nested"'],
  ['Bash', JSON.stringify({ command: "bash -lc 'git status --short'", description: 'Read status' }), 'git status --short'],
  ['bash', JSON.stringify({ cmd: "sh -c 'printf done'" }), 'printf done'],
])('shows the command inside the shell wrapper for %s without changing expanded input', async (name, input, summary) => {
  const view = show([{ kind: 'tool_call', entryId: '1', entrySeq: '1', revision: '1', callId: 'c', name, input, output: [], status: 'completed', truncated: false }]);
  expect(view.container.querySelector('.session-tool-summary')?.textContent).toBe(summary);
  await expand(view.container.querySelector('details')!);
  expect(view.container.querySelector('.session-tool-input')?.textContent).toBe(input);
});
it.each([
  'git status --short',
  'sh -c',
  'sh -c echo argument',
  'sh -c $HOME',
  'sh -c $(pwd)',
  'sh -c `pwd`',
  'sh -c ~',
  'sh -c =date',
  'sh -c *.sh',
  'sh -c ?.sh',
  'sh -c [ab].sh',
  'sh -c {a,b}',
  'sh -c date;pwd',
  'sh -c date|cat',
  'sh -c date>output',
  "sh -c 'echo ok' argument",
  "sh -c 'echo ok' && echo extra",
  "sh -c 'echo ok' > output",
  "sh -c 'echo ok'; echo extra",
  "sh -c 'echo ok' # comment",
  "sh -c 'echo ok' unquoted' suffix'",
  "sh -c 'unterminated",
  'sh -c "unterminated',
  'sh -c "echo trailing\\',
  "sh -c 'echo ok'\\",
  'sh -c "echo $HOME"',
  'sh -c "echo $(pwd)"',
  'sh -c "echo `pwd`"',
  "sh -c $'echo ANSI'",
  "sh -c $\"echo translated\"",
  "sh -l -c 'echo flags'",
  "bash -xec 'echo flags'",
  "env sh -c 'echo environment'",
  "fish -c 'echo fish'",
  "/tmp/sh -c 'echo unknown'",
])('keeps uncertain or compound shell invocations intact: %s', (input) => {
  const view = show([{ kind: 'tool_call', entryId: '1', entrySeq: '1', revision: '1', callId: 'c', name: 'commandExecution', input, output: [], status: 'completed', truncated: false }]);
  expect(view.container.querySelector('.session-tool-summary')?.textContent).toBe(input);
});
it.each([
  ['search', "sh -c 'query text'", "sh -c 'query text'"],
  ['search', JSON.stringify({ query: "sh -c 'query text'" }), "sh -c 'query text'"],
  ['commandExecution', JSON.stringify({ description: "sh -c 'description text'" }), "sh -c 'description text'"],
  ['Read', JSON.stringify({ file_path: '/bin/sh -c', command: 123, path: 'ignored' }), '/bin/sh -c'],
  ['Bash', JSON.stringify({ command: 'echo first', cmd: 'echo second' }), 'echo first'],
  ['Bash', JSON.stringify({ command: 123, cmd: "sh -c 'echo second'" }), 'echo second'],
  ['Bash', JSON.stringify({ command: '', cmd: 'ignored' }), ''],
  ['unknown', '{"other":"value"}', '{"other":"value"}'],
  ['unknown', '["value"]', '["value"]'],
  ['unknown', 'null', 'null'],
  ['unknown', '"value"', '"value"'],
  ['unknown', 'plain\n parameters\t here', 'plain parameters here'],
])('preserves JSON field selection and non-command summaries for %s', (name, input, summary) => {
  const view = show([{ kind: 'tool_call', entryId: '1', entrySeq: '1', revision: '1', callId: 'c', name, input, output: [], status: 'completed', truncated: false }]);
  expect(view.container.querySelector('.session-tool-summary')?.textContent).toBe(summary);
});
it('applies the existing summary limit after removing the wrapper', async () => {
  const input = `sh -c 'echo ${'x'.repeat(200)}'`;
  const view = show([{ kind: 'tool_call', entryId: '1', entrySeq: '1', revision: '1', callId: 'c', name: 'commandExecution', input, output: [], status: 'completed', truncated: false }]);
  expect(view.container.querySelector('.session-tool-summary')?.textContent).toBe(`echo ${'x'.repeat(174)}…`);
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
