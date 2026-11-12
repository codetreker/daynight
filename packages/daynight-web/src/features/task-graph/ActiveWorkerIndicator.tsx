import type { WorkerClaim } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';

export const ActiveWorkerIndicator = ({ memberIds, workerMachines }: { readonly memberIds: ReadonlySet<string>; readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, 'state' | 'machine'>> }) => {
  const { messages: { graph } } = useI18n();
  if (![...memberIds].some((id) => workerMachines.get(id)?.state === 'active')) return null;
  return <span className="chain-worker-active"><span className="chain-worker-active-dot" aria-hidden="true" />{graph.automaticExecutionActive}</span>;
};
