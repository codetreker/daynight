import { useOptionalAccountSession } from '../../app/AccountSessionProvider';
import { useI18n } from '../../i18n/LocaleProvider';

export function AccountSyncNotice() {
  const account = useOptionalAccountSession();
  const { messages: { auth: { accountSync } } } = useI18n();
  if (!account || account.sync.status !== 'error') return null;
  return <div className="notice warning" role="alert"><p>{accountSync.error}</p><button className="button" type="button" onClick={account.retryPublication}>{accountSync.retry}</button></div>;
}
