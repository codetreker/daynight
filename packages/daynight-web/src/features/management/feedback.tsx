import { useRef, useState } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { ApiError } from '../../api/client';
import { ManagementDialog } from './ManagementDialog';

export const ManagementError = ({ error, retry }: { readonly error: unknown; readonly retry?: () => void }) => {
  const { messages: { auth: { management: { common: m } }, common } } = useI18n();
  return <div className="notice error" role="alert">
  <p>{error instanceof ApiError && error.status === 401 ? m.unauthenticated
    : error instanceof ApiError && error.status === 404 ? m.notFound
      : m.operationFailed}</p>
  {error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId}<code>{error.requestId}</code></p>}
  {retry && <button className="button" type="button" onClick={retry}>{m.retry}</button>}
</div>;
};

export const identityName = (user: { readonly name: string | null; readonly email: string | null; readonly userId?: string; readonly id?: string }): string =>
  user.name ?? user.email ?? user.userId ?? user.id!;

const IdentityAvatar = ({ src, initials }: { readonly src: string | null; readonly initials: string }) => {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  return <span className="avatar management-avatar" aria-hidden="true">
    {state !== 'loaded' && initials}
    {src !== null && src !== '' && state !== 'failed' && <img src={src} alt="" hidden={state !== 'loaded'} onLoad={() => setState('loaded')} onError={() => setState('failed')} />}
  </span>;
};

export const Identity = ({ user, self = false }: { readonly user: { readonly name: string | null; readonly email: string | null; readonly avatarUrl: string | null; readonly userId?: string; readonly id?: string }; readonly self?: boolean }) => {
  const { messages: { auth: { management: { common } } } } = useI18n();
  return <div className="person">
  <IdentityAvatar key={JSON.stringify([user.userId ?? user.id, user.avatarUrl])} src={user.avatarUrl} initials={Array.from(identityName(user)).slice(0, 2).join('').toUpperCase()} />
  <div><div className="person-name">{identityName(user)}{self && <span className="muted small">{common.self}</span>}</div>{user.email !== null && <div className="person-meta">{user.email}</div>}</div>
</div>;
};

export const DateLabel = ({ value }: { readonly value: string }) => {
  const { format } = useI18n();
  return <time dateTime={value}>{format.dateTime(value)}</time>;
};

export const SecretDialog = ({ kind, secret, onClose, suspended = false }: { readonly kind: 'token' | 'invitation'; readonly secret: string; readonly onClose: () => void; readonly suspended?: boolean }) => {
  const { messages: { auth: { management: { secret: m, members } } } } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [warning, setWarning] = useState(false);
  const value = useRef<HTMLTextAreaElement>(null);
  const invitation = kind === 'invitation';
  const close = () => setWarning(true);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      if (value.current === null) return;
      setCopied(true); setFailed(false);
    } catch {
      if (value.current === null) return;
      setCopied(false); setFailed(true);
      value.current.focus(); value.current.select();
    }
  };
  return <ManagementDialog title={invitation ? m.invitationTitle : m.tokenTitle} suspended={suspended} onClose={close} footer={<>
    {warning ? <><button className="button" type="button" onClick={() => setWarning(false)}>{m.returnSave}</button><button className="button primary" type="button" onClick={onClose}>{m.confirmClose}</button></>
      : <button className="button primary" type="button" onClick={onClose}>{m.savedClose}</button>}
  </>}>
    <p>{invitation ? m.invitationBody : m.tokenBody}</p>
    <div className="credential"><textarea ref={value} aria-label={invitation ? m.invitationLabel : m.tokenLabel} readOnly value={secret} rows={3} /><button className="button" type="button" onClick={() => { void copy(); }}>{invitation ? m.copyLink : m.copy}</button></div>
    {copied && <p role="status">{m.copied}</p>}
    {failed && <p className="notice" role="status">{m.copyFailed}</p>}
    {invitation && <div className="notice">{members.inviteTerms}</div>}
    <div className="one-time">{invitation ? m.invitationOneTime : m.tokenOneTime}</div>
    {warning && <p className="notice error" role="alert">{invitation ? m.invitationCloseWarning : m.tokenCloseWarning}</p>}
  </ManagementDialog>;
};
