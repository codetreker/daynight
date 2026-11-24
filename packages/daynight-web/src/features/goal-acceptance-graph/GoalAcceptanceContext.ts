import { createContext, useContext, type ReactNode, type RefObject } from 'react';

export type GoalAcceptanceEntry = { readonly projectId: string; readonly goalId: string; readonly trigger: HTMLElement; readonly owner: RefObject<HTMLElement | null>; readonly fallback: RefObject<HTMLElement | null> };
export type GoalAcceptanceOwner = {
  readonly projectId: string;
  readonly canOpen: (goalId: string) => boolean;
  readonly open: (entry: GoalAcceptanceEntry) => void;
  readonly attach: (goalId: string, owner: GoalAcceptanceEntry['owner'], fallback: GoalAcceptanceEntry['fallback']) => void;
  readonly retire: (goalId: string) => void;
  readonly renderRelated: (projectId: string, children: ReactNode) => ReactNode;
};
export const GoalAcceptanceOwnerContext = createContext<GoalAcceptanceOwner | null>(null);
export const useGoalAcceptanceOwner = () => useContext(GoalAcceptanceOwnerContext);
