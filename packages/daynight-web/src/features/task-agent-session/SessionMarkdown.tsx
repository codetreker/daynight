import { ChatMarkdown } from '../../ui/ChatMarkdown';
import { useSessionMessages } from './messages';
import { useTimelineMessages } from './timeline-messages';

export const SessionMarkdown = ({ text }: { readonly text: string }) => {
  const messages = useSessionMessages(), labels = useTimelineMessages();
  return <ChatMarkdown text={text} className="session-markdown" resourceUnavailable={messages.resourceUnavailable} tableLabel={labels.table} />;
};
