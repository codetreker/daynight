import { useLayoutEffect, useRef } from "react";

export const useLandingHeader = () => {
  const pageRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const page = pageRef.current!;
    const header = headerRef.current!;
    let offset = 0;
    const update = () => {
      const height = header.getBoundingClientRect().height;
      const sticky = height <= window.innerHeight / 2;
      const nextOffset = sticky ? height : 0;
      const target = document.getElementById(window.location.hash.slice(1));
      // Native fragment scrolling rounds positions; preserve only an already anchored target.
      const anchored = target !== null && Math.abs(target.getBoundingClientRect().top - offset) <= 2;
      header.dataset.sticky = String(sticky);
      page.style.setProperty("--landing-anchor-offset", `${nextOffset}px`);
      if (anchored && nextOffset > offset) target.scrollIntoView({ block: "start", behavior: "instant" });
      offset = nextOffset;
    };
    update();
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(header);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, []);

  return { pageRef, headerRef };
};
