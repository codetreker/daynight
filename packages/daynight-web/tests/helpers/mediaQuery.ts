import { vi } from "vitest";

export const mockSidebarMediaQuery = (initiallyNarrow = false) => {
  const events = new EventTarget();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let narrow = initiallyNarrow;
  const query: MediaQueryList = {
    media: "(max-width: 740px)",
    get matches() { return narrow; },
    onchange: null,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      if (type === "change" && listener !== null) listeners.add(listener);
      events.addEventListener(type, listener, options);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
      if (type === "change" && listener !== null) listeners.delete(listener);
      events.removeEventListener(type, listener, options);
    },
    dispatchEvent: (event) => events.dispatchEvent(event),
    addListener: (listener) => events.addEventListener("change", listener as EventListener),
    removeListener: (listener) => events.removeEventListener("change", listener as EventListener),
  };
  vi.stubGlobal("matchMedia", vi.fn((media: string) => {
    if (media !== query.media) throw new Error(`Unexpected media query: ${media}`);
    return query;
  }));
  return {
    query,
    listenerCount: () => listeners.size,
    setNarrow: (next: boolean) => {
      if (next === narrow) return;
      narrow = next;
      const event = Object.assign(new Event("change"), { matches: narrow, media: query.media });
      query.dispatchEvent(event);
      query.onchange?.call(query, event as MediaQueryListEvent);
    },
  };
};
