import { useLayoutEffect, useRef, useState } from 'react';
import { useOptionalAccountSession } from '../../app/AccountSessionProvider';
import { AccountChangeBanner } from './AccountChangeBanner';

/** Present the refresh action only in the currently operable header. */
export function AccountRefreshNotice() {
  const account = useOptionalAccountSession();
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    if (!account?.requiresRefresh) { setActive(false); return; }
    const update = () => {
      const element = root.current;
      if (!element || element.closest('[inert], [hidden]')) { setActive(false); return; }
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') { setActive(false); return; }
      }
      // Native modal dialogs isolate the rest of the document without setting inert.
      const modals = document.querySelectorAll('dialog:modal');
      const top = modals.item(modals.length - 1);
      setActive(top === null || top.contains(element));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['inert', 'hidden', 'open', 'class', 'style'] });
    return () => observer.disconnect();
  }, [account?.requiresRefresh]);
  if (!account?.requiresRefresh) return null;
  return <div className="account-refresh-notice" data-active={account.requiresRefresh && active} ref={root}><AccountChangeBanner active={account.requiresRefresh && active} onReload={account.reloadCurrentPage} /></div>;
}
