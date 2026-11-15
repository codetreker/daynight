import { useI18n } from '../../i18n/LocaleProvider';

export const TaskAgentPermissionBadge = ({ allowAgents, compact = false }: { readonly allowAgents: boolean; readonly compact?: boolean }) => {
  const { messages: { automation: m } } = useI18n();
  const label = allowAgents ? m.enabled : m.disabled;
  return <span className={`task-agent-permission${allowAgents ? ' task-agent-permission-on' : ''}${compact ? ' task-agent-permission-compact' : ''}`}
    aria-label={label} title={label}>{compact ? allowAgents ? m.compactEnabled : m.compactDisabled : label}</span>;
};
