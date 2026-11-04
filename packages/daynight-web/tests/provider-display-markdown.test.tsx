import { expect, it } from 'vitest';
import { providerDisplayEntry } from '../../daynight/src/commands/controller/provider-display';
import { SessionMarkdown } from '../src/features/task-agent-session/SessionMarkdown';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const base = { entryId: '11111111-1111-4111-8111-111111111111', revision: '1' };
const converted = (kind: 'user_message' | 'assistant_message' | 'reasoning', text: string): string => {
  const entry = providerDisplayEntry(kind === 'reasoning' ? { ...base, kind, text } : { ...base, kind, content: [{ type: 'text', text }] });
  if (entry.kind === 'reasoning') return entry.text;
  if ((entry.kind === 'user_message' || entry.kind === 'assistant_message') && entry.content[0]?.type === 'text') return entry.content[0].text;
  throw new Error('Expected message or reasoning text');
};

it.each(['user_message', 'assistant_message', 'reasoning'] as const)('renders %s escapes literally so illegal characters and original escape text remain distinguishable', kind => {
  const text = converted(kind, 'NUL:\0 literal:\\u0000 surrogate:\ud800 literal:\\ud800');
  const view = render(<SessionMarkdown text={text} />);
  expect(view.container.querySelectorAll('pre code')).toHaveLength(1);
  expect(view.container.querySelector('pre code')?.textContent).toBe('NUL:\\u0000 literal:\\\\u0000 surrogate:\\ud800 literal:\\\\ud800\n');
});

it.each([
  '```\n# literal heading\n```\n~~~\n**literal strong**\n~~~',
  '``````\n~~~\n[link](https://example.com)\n~~~~',
  '~~~\n\t```\n```\n~~~',
])('embedded Markdown delimiters cannot end the literal display block (%#)', raw => {
  const text = converted('assistant_message', '\0\n' + raw);
  const view = render(<SessionMarkdown text={text} />);
  expect(view.container.querySelectorAll('pre code')).toHaveLength(1);
  expect(view.container.querySelector('pre code')?.textContent).toBe('\\u0000\n' + raw + '\n');
  expect(view.container.querySelector('h1, strong, a')).toBeNull();
});

it('large competing delimiter runs remain one bounded literal block after truncation', () => {
  const text = converted('reasoning', '\0\n' + '`'.repeat(70_000) + '\n' + '~'.repeat(70_000) + '\n# must remain literal');
  const view = render(<SessionMarkdown text={text} />);
  expect(text.length).toBeLessThanOrEqual(200_000 + '\n[Output truncated at 200000 characters]'.length);
  expect(view.container.querySelectorAll('pre code')).toHaveLength(1);
  expect(view.container.querySelector('pre code')?.textContent?.endsWith('\n[Output truncated at 200000 characters]\n')).toBe(true);
  expect(view.container.querySelector('h1')).toBeNull();
});

it('ordinary valid messages retain their Markdown rendering', () => {
  const original = '**normal** 中文 😀 \\u0000';
  const text = converted('assistant_message', original);
  expect(text).toBe(original);
  const view = render(<SessionMarkdown text={text} />);
  expect(view.container.querySelector('strong')?.textContent).toBe('normal');
  expect(view.container.querySelector('pre')).toBeNull();
});
