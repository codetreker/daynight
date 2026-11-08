import type { SessionEmptySlot } from '../task-agent-session/session-presentation-slots';
import { useBotMessages } from './messages';

export function BotConversationEmpty({ setDraftAndFocus }: SessionEmptySlot) {
  const m = useBotMessages();
  return <div className="bot-conversation-empty">
    <span className="bot-conversation-mark" aria-hidden="true">✦</span>
    <h3>{m.welcomeTitle}</h3>
    <p>{m.welcomeDescription}</p>
    <div className="bot-conversation-starters">
      {m.conversationStarters.map(starter => <button type="button" key={starter.prompt} onClick={() => setDraftAndFocus(starter.prompt)}>
        <span>{starter.label}</span><span aria-hidden="true">→</span>
      </button>)}
    </div>
  </div>;
}
