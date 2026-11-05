import { useId, type ReactNode } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { DateLabel } from './feedback';

type Invitation = { readonly id: string; readonly createdAt: string; readonly expiresAt: string };

export const InvitationList = <T extends Invitation>({ invitations, disabled, canRevoke, onRevoke, action }: {
  readonly invitations: readonly T[] | null;
  readonly disabled: boolean;
  readonly canRevoke?: (invitation: T) => boolean;
  readonly onRevoke: (invitation: T) => void;
  readonly action?: ReactNode;
}) => {
  const { messages: { auth: { management: { members: m, common } } } } = useI18n();
  const titleId = useId();
  return <section className="panel" aria-labelledby={titleId}><div className="panel-heading"><div><h2 id={titleId}>{m.invitesTitle}</h2><p>{m.invitesDescription}</p></div>{action}</div>
    {invitations !== null && (invitations.length === 0 ? <div className="empty-inline">{m.invitesEmpty}</div> : invitations.map((invitation) => <div className="row" key={invitation.id}><div><div className="person-name">{m.newInvitation}</div><div className="person-meta"><code>{invitation.id}</code> · {common.createdAt} <DateLabel value={invitation.createdAt} /></div></div><div className="row-detail">{common.expiresAt} <DateLabel value={invitation.expiresAt} /></div><div className="actions"><button className="button quiet" type="button" aria-label={m.revokeLabel({ id: invitation.id })} disabled={disabled || canRevoke?.(invitation) === false} onClick={() => onRevoke(invitation)}>{common.revoke}</button></div></div>))}
  </section>;
};
