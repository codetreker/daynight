import { useLayoutEffect, useState } from "react";

const currentLocation = () => ({ pathname: window.location.pathname, search: window.location.search });

export const useBrowserLocation = () => {
  const [location, setLocation] = useState(currentLocation);
  useLayoutEffect(() => {
    const changed = () => setLocation(currentLocation());
    window.addEventListener("popstate", changed);
    window.addEventListener("hashchange", changed);
    return () => {
      window.removeEventListener("popstate", changed);
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  return location;
};
