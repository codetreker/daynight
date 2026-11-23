import { useI18n } from '../../i18n/LocaleProvider';

export const TaskAgentPermissionBadge = ({ allowAgents, compact = false }: { readonly allowAgents: boolean; readonly compact?: boolean }) => {
  const { messages: { automation: m } } = useI18n();
  if (!allowAgents) return null;
  return <span className={`task-agent-permission${compact ? ' task-agent-permission-compact' : ''}`}
    aria-label={m.label} title={m.label}>{compact ? m.compactEnabled : m.label}</span>;
};
