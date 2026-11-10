import { useEffect, useRef, useState } from 'react';
import type { SessionResource } from '../../api/types';
import { useSessionMessages } from './messages';
import { SessionImageFrame, type ImagePresentation } from './images/SessionImageFrame';

type ResourceProps = {
  readonly resourceAccess?: 'live' | 'none';
  readonly resource: SessionResource | undefined; readonly label: string; readonly active: boolean;
  readonly onLoad: (id: string, signal: AbortSignal) => Promise<Blob>;
  readonly presentation?: ImagePresentation; readonly mediaKey?: string; readonly error?: string;
  readonly onInvalidResource?: () => void;
};
export function SessionResourceView(props: ResourceProps) {
  const { resource, label, active, resourceAccess, presentation, mediaKey, error, onInvalidResource } = props;
  if (!resource || /^image\//i.test(resource.mediaType ?? '')) return <SessionImageFrame resource={resource} label={label} active={active} {...(resourceAccess ? { resourceAccess } : {})} {...(presentation ? { presentation } : {})} {...(mediaKey ? { mediaKey } : {})} {...(error ? { error } : {})} {...(onInvalidResource ? { onInvalidResource } : {})} />;
  return <SessionFileResource {...props} />;
}
function SessionFileResource({ resource, label, active, onLoad, resourceAccess = 'live' }: ResourceProps) {
  const m = useSessionMessages();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const pending = useRef<Promise<string> | null>(null);
  const access = useRef(resourceAccess); access.current = resourceAccess;
  const load = (): Promise<string> => {
    if (access.current === 'none') return Promise.reject(new Error(m.resourceUnavailable));
    if (objectUrl.current) return Promise.resolve(objectUrl.current);
    if (pending.current) return pending.current;
    if (resourceAccess === 'none' || !resource || resource.status !== 'available' || resource.byteLength === null || resource.sha256 === null) return Promise.reject(new Error(m.resourceUnavailable));
    const request = new AbortController(); controller.current = request; setLoading(true); setError(null);
    pending.current = onLoad(resource.resourceId, request.signal).then(async (blob) => {
      const bytes = await blob.arrayBuffer(); request.signal.throwIfAborted();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      request.signal.throwIfAborted();
      if (String(bytes.byteLength) !== resource.byteLength || hash !== resource.sha256) throw new Error('Resource integrity verification failed.');
      const value = URL.createObjectURL(new Blob([bytes], { type: resource.mediaType ?? 'application/octet-stream' }));
      objectUrl.current = value; return value;
    }).catch((cause: unknown) => { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : m.resourceUnavailable); throw cause; })
      .finally(() => { pending.current = null; if (!request.signal.aborted) setLoading(false); });
    return pending.current;
  };
  useEffect(() => () => { controller.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  useEffect(() => {
    if (resourceAccess === 'none') { controller.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }
  }, [resourceAccess]);
  if (resourceAccess === 'none' || !resource || resource.status !== 'available') return <span className="session-resource-unavailable">{label} — {resource?.status === 'pending' ? m.resourcePending : m.resourceUnavailable}</span>;
  return <div className="session-resource">
    <button className="inline-link" disabled={loading || !active} onClick={() => { void load().then((value) => { const link = document.createElement('a'); link.href = value; link.download = resource.name; link.click(); }).catch(() => {}); }}>{loading ? m.loading : `${m.download}: ${label || resource.name}`}</button>
    {error ? <p className="session-error" role="alert">{error}</p> : null}
  </div>;
}
