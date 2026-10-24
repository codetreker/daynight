import { createContext, useContext, type ReactNode } from "react";
import { TaskCacheScope } from "./project-cache";
export { createTaskCacheScope, TaskCacheScope } from "./project-cache";

const Context = createContext<TaskCacheScope | null>(null);
export const TaskCacheProvider = ({ scope, children }: { readonly scope: TaskCacheScope; readonly children: ReactNode }) =>
  <Context.Provider value={scope}>{children}</Context.Provider>;
export const useTaskCacheScope = (): TaskCacheScope => {
  const scope = useContext(Context);
  if (scope === null) throw new Error("An authenticated task cache scope is required.");
  return scope;
};
