import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { ImageScope } from './image-store';
import { ImagePreviewController, imagePreviewModalSnapshot, subscribeImagePreviewModals } from './image-preview';
import { ImagePreviewHost } from './ImagePreviewHost';
import './session-images.css';

export { suspendSessionImagePreviews, type ImagePreviewRequest, type PreviewCloseReason } from './image-preview';
type ImageContext = { readonly scope: ImageScope | null; readonly active: boolean; readonly suspended: boolean; readonly readAdmitted: boolean; readonly previewAssetKey: string | null; readonly preview: ImagePreviewController; readonly rootRef: RefObject<HTMLElement | null> };
const Context = createContext<ImageContext | null>(null);
export const useSessionImageScope = (): ImageContext | null => useContext(Context);

/** Mount inside the actual Session/record root, around its timeline and composer. */
export function SessionImageScope({ scope, rootRef, active, suspended = false, readAdmitted = true, onPreviewChange, children }: {
  readonly scope: ImageScope | null; readonly rootRef: RefObject<HTMLElement | null>; readonly active: boolean;
  readonly suspended?: boolean; readonly readAdmitted?: boolean; readonly onPreviewChange?: (open: boolean) => void; readonly children: ReactNode;
}) {
  const globalSuspended = useSyncExternalStore(subscribeImagePreviewModals, imagePreviewModalSnapshot);
  const state = useRef({ scope, active, suspended, readAdmitted }); state.current = { scope, active, suspended, readAdmitted };
  const preview = useMemo(() => new ImagePreviewController(candidate => state.current.scope === candidate && state.current.active && !state.current.suspended && state.current.readAdmitted && candidate.valid), []);
  const request = useSyncExternalStore(preview.subscribe, preview.snapshot);
  useLayoutEffect(() => {
    if (request && request.scope !== scope) preview.close('identity_changed');
    else if (!active) preview.close('owner_inactive');
  }, [scope, active, preview, request]);
  useLayoutEffect(() => scope?.subscribeInvalidation(() => preview.close('access_revoked')), [scope, preview]);
  useLayoutEffect(() => () => { preview.close('host_disposed'); }, [preview]);
  const paused = suspended || globalSuspended;
  const displayed = request !== null && request.scope === scope && active && !paused;
  useLayoutEffect(() => { onPreviewChange?.(displayed); return () => { if (displayed) onPreviewChange?.(false); }; }, [displayed, onPreviewChange]);
  const previewAssetKey = request?.asset.key ?? null;
  const value = useMemo(() => ({ scope, active, suspended: paused, readAdmitted, previewAssetKey, preview, rootRef }), [scope, active, paused, readAdmitted, previewAssetKey, preview, rootRef]);
  return <Context value={value}>{children}<ImagePreviewHost controller={preview} rootRef={rootRef} active={active} suspended={paused} readAdmitted={readAdmitted} /></Context>;
}
