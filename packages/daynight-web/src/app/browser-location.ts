import { useSyncExternalStore } from "react";
import { browserNavigation } from './navigation';

export const useBrowserLocation = () => {
  const owner = browserNavigation();
  return useSyncExternalStore(owner.subscribe, owner.snapshot);
};
