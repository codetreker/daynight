import { useEffect, useState } from 'react';
import { createDateWindow } from './date-window';

export function useDateWindow(active: boolean) {
  const [dateWindow, setWindow] = useState(() => createDateWindow());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const next = createDateWindow();
      setWindow(previous => previous.endDate === next.endDate && previous.encoded === next.encoded ? previous : next);
      clearTimeout(timer);
      const now = Date.now();
      const boundary = next.segments.find(segment => segment.startMillis > now)?.startMillis;
      timer = setTimeout(update, Math.max(1, Math.min(60_000, (boundary ?? now + 60_000) - now + 1)));
    };
    const visible = () => { if (document.visibilityState === 'visible') update(); };
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', visible); };
  }, [active]);
  return dateWindow;
}
