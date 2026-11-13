import { useMemo, useRef, useState } from "react";

export type ProjectManagementOwner = "settings" | "github" | "transfer" | "delete";

export type ProjectManagementGuard = {
  readonly tryAcquire: (owner: ProjectManagementOwner) => boolean;
  readonly release: (owner: ProjectManagementOwner) => void;
  readonly isBlocked: (owner: ProjectManagementOwner) => boolean;
};

// Acquisition is synchronous: two handlers in the same render cannot both
// dispatch before React has had an opportunity to render the disabled state.
export const useProjectManagementGuard = (): ProjectManagementGuard => {
  const owner = useRef<ProjectManagementOwner | null>(null);
  const [, update] = useState(0);
  return useMemo(() => ({
    tryAcquire: (next: ProjectManagementOwner) => {
      if (owner.current !== null) return false;
      owner.current = next; update((value) => value + 1); return true;
    },
    release: (current: ProjectManagementOwner) => {
      if (owner.current !== current) return;
      owner.current = null; update((value) => value + 1);
    },
    isBlocked: (current: ProjectManagementOwner) => owner.current !== null && owner.current !== current,
  }), []);
};
