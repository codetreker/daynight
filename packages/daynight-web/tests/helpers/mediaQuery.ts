import { vi } from "vitest";

const mediaFixture = (media: string, initial: boolean) => {
  const events = new EventTarget(), listeners = new Set<EventListenerOrEventListenerObject>();
  let matches = initial;
  const query: MediaQueryList = {
    media,
    get matches() { return matches; },
    onchange: null,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      if (type === "change" && listener !== null) listeners.add(listener);
      events.addEventListener(type, listener, options);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
      if (type === "change" && listener !== null) listeners.delete(listener);
      events.removeEventListener(type, listener, options);
    },
    dispatchEvent: event => events.dispatchEvent(event),
    addListener: listener => events.addEventListener("change", listener as EventListener),
    removeListener: listener => events.removeEventListener("change", listener as EventListener),
  };
  return {
    query,
    listenerCount: () => listeners.size,
    setNarrow: (next: boolean) => {
      if (next === matches) return;
      matches = next;
      const event = Object.assign(new Event("change"), { matches, media });
      query.dispatchEvent(event); query.onchange?.call(query, event as MediaQueryListEvent);
    },
  };
};

export const mockSidebarMediaQuery = (initiallyNarrow = false) => {
  const sidebar = mediaFixture("(max-width: 740px)", initiallyNarrow), webhook = mediaFixture("(max-width: 1080px)", initiallyNarrow);
  vi.stubGlobal("matchMedia", vi.fn((media: string) => {
    if (media === sidebar.query.media) return sidebar.query;
    if (media === webhook.query.media) return webhook.query;
    throw new Error(`Unexpected media query: ${media}`);
  }));
  return { ...sidebar, webhook, setNarrow: (next: boolean) => { sidebar.setNarrow(next); webhook.setNarrow(next); } };
};
