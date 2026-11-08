import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

type Position = {
  readonly left: number;
  readonly top: number;
  readonly containers: readonly { readonly element: HTMLElement; readonly left: number; readonly top: number }[];
};

export const useWebhookListPosition = (list: RefObject<HTMLElement | null>, entryKey: string, detailOpen: boolean, loaded: boolean) => {
  const positions = useRef(new Map<string, Position>()), current = useRef({ entryKey, detailOpen }), previous = useRef<{ readonly entryKey: string; readonly detailOpen: boolean } | null>(null), pending = useRef<string | null>(null);
  current.current = { entryKey, detailOpen };
  const capture = () => {
    if (current.current.detailOpen || list.current === null) return;
    const containers: Position["containers"][number][] = [];
    for (let element: HTMLElement | null = list.current; element !== null && element !== document.body; element = element.parentElement) {
      const overflow = getComputedStyle(element).overflowY;
      if (overflow === "auto" || overflow === "scroll") containers.push({ element, left: element.scrollLeft, top: element.scrollTop });
    }
    positions.current.set(current.current.entryKey, { left: window.scrollX, top: window.scrollY, containers });
  };
  const captureRef = useRef(capture); captureRef.current = capture;
  useEffect(() => {
    const scrolled = () => captureRef.current();
    window.addEventListener("scroll", scrolled, true);
    return () => window.removeEventListener("scroll", scrolled, true);
  }, []);
  useLayoutEffect(() => {
    const old = previous.current;
    if (!detailOpen && (old === null || old.detailOpen || old.entryKey !== entryKey)) pending.current = entryKey;
    previous.current = { entryKey, detailOpen };
    if (detailOpen || !loaded || pending.current !== entryKey) return;
    pending.current = null;
    const position = positions.current.get(entryKey);
    if (position === undefined) return;
    for (const container of position.containers) if (container.element.isConnected) { container.element.scrollLeft = container.left; container.element.scrollTop = container.top; }
    window.scrollTo({ left: position.left, top: position.top, behavior: "instant" });
  }, [entryKey, detailOpen, loaded]);
  return () => captureRef.current();
};
