import { ApiError } from '../../api/client';
import type { InspectionMessages } from '../../i18n/messages/inspection';
import type { ThreadMessage } from './contract';

export type DiscussionMessages = InspectionMessages['discussion'];
export const accountLabel = (name: string | null, id: string, messages: DiscussionMessages): string => name !== null && name.trim() !== '' ? name : messages.accountName(id);
export const authorLabel = (message: ThreadMessage, messages: DiscussionMessages): string => {
  const name = accountLabel(message.author.displayName, message.author.userId, messages);
  return message.author.Agent ? messages.agentName(name) : name;
};
export const excerpt = (body: string, messages: DiscussionMessages): string => Array.from(body.replace(/```[\s\S]*?```/g, messages.codeSnippet).replace(/[`*]/g, '').replace(/\s+/g, ' ')).slice(0, 160).join('');
export const providerLabel = { codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot' } as const;
const tone = (id: string): string => ['purple', 'green', 'amber'][Array.from(id).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 3]!;

const paths = {
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1.6L20 8M4 16l2.3 2.6A7 7 0 0 0 17.9 17" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  reply: <><path d="m9 10-5 4 5 4" /><path d="M4 14h10a5 5 0 0 0 0-10h-2" /></>,
  bubble: <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />,
  send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
  code: <path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-10-2 20" />,
  up: <path d="m6 14 6-6 6 6" />,
  down: <path d="m6 10 6 6 6-6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  alert: <><path d="m10.3 3.9-8.1 14A2 2 0 0 0 3.9 21h16.2a2 2 0 0 0 1.7-3.1l-8.1-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
  shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z" />,
};
export const ThreadIcon = ({ name, size = 16, spinning = false }: { readonly name: keyof typeof paths; readonly size?: number; readonly spinning?: boolean }) =>
  <svg className={spinning ? 'thread-spin' : undefined} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;

export const ThreadAvatar = ({ id, name, agent = false, participant = false }: { readonly id: string; readonly name: string | null; readonly agent?: boolean; readonly participant?: boolean }) =>
  <span className={`${participant ? 'thread-participant' : 'thread-avatar'} ${agent ? 'agent' : tone(id)}`} aria-hidden="true">{agent ? <ThreadIcon name="bolt" size={13} /> : name === null || name.trim() === '' ? '#' : Array.from(name.trim())[0]}</span>;

const apiCause = (error: Error): ApiError | null => {
  let cause: unknown = error;
  for (let count = 0; count < 4 && cause instanceof Error; count++) {
    if (cause instanceof ApiError) return cause;
    cause = cause.cause;
  }
  return null;
};
export const ThreadErrorDetails = ({ error, messages }: { readonly error: Error; readonly messages: DiscussionMessages }) => {
  const cause = apiCause(error);
  return cause === null ? null : <details className="thread-error-details"><summary>{messages.errorDetails}</summary><code>{cause.code}</code>{cause.requestId !== null && <code>{cause.requestId}</code>}</details>;
};
export const ThreadFailure = ({ error, label, messages, retry }: { readonly error: Error; readonly label: string; readonly messages: DiscussionMessages; readonly retry?: () => void }) =>
  <div className="thread-read-error" role="alert"><div><span>{label}</span><ThreadErrorDetails error={error} messages={messages} /></div>{retry !== undefined && <button className="button" type="button" onClick={retry}>{messages.retry}</button>}</div>;
