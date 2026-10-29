import { useI18n } from '../../i18n/LocaleProvider';
import '../../styles/task-attention.css';

export const TaskAttentionBadge = ({ needsAttention, compact = false }: { readonly needsAttention: boolean; readonly compact?: boolean }) => {
  const { messages: { inspection: m } } = useI18n();
  return needsAttention ? <span className={`task-attention-badge${compact ? ' task-attention-compact' : ''}`}>{m.needsAttention}</span> : null;
};

export const TaskAttentionNotice = ({ signaling }: { readonly signaling: string }) => {
  const { messages: { inspection: m } } = useI18n();
  return signaling === '' ? null : <section className="task-attention-notice" aria-label={m.needsAttention}>
    <strong>{m.needsAttention}</strong>
    <p>{signaling}</p>
  </section>;
};
