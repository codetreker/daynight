import type { ExecutionPlatform } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';

export const TaskPlatformBadge = ({ requiredPlatform, compact = false }: {
  readonly requiredPlatform: ExecutionPlatform | null;
  readonly compact?: boolean;
}) => {
  const { messages: { platform: m } } = useI18n();
  const label = requiredPlatform === null ? m.any : m.names[requiredPlatform];
  return <span className={`task-platform${compact ? ' task-platform-compact' : ''}`} title={`${m.title}: ${label}`}>{label}</span>;
};
