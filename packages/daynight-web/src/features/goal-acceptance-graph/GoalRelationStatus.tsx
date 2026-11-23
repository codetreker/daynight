import { useI18n } from '../../i18n/LocaleProvider';
import type { GoalRelationSnapshot } from './relation-session';
import { goalAcceptanceMessages } from './messages';

export const GoalRelationStatus = ({ snapshot, onRetry }: { readonly snapshot: GoalRelationSnapshot; readonly onRetry: (id: string) => void }) => {
  const { locale } = useI18n(), m = goalAcceptanceMessages(locale);
  return <div className="goal-relation-status" aria-label={m.reading}>
    {[...snapshot.sources.values()].map(source => <div key={source.goalId} className="goal-relation-source" data-goal-id={source.goalId} data-phase={source.phase}>
      <span>{source.title}</span><span role={source.phase === 'failed' || source.phase === 'conflict' ? 'alert' : 'status'}>{m.sourcePhase[source.phase]}</span>
      {source.hiddenCount > 0 && <span>{m.hidden(source.hiddenCount)}</span>}
      {!['queued', 'loading', 'partial'].includes(source.phase) && <button type="button" className="button secondary" aria-label={m.retryLabel(source.title)} onClick={() => onRetry(source.goalId)}>{m.retry}</button>}
    </div>)}
  </div>;
};
