import { createContext, useContext, type ReactNode } from "react";
import { useProjects, type ProjectScope } from "./useProjects";
import type { TaskCacheScope } from "../task-cache/project-cache";
export type { ProjectScope } from "./useProjects";

const ProjectsContext = createContext<ReturnType<typeof useProjects> | null>(null);

export const ProjectsProvider = ({ children, scope, admission, admissionBlocked = false }: { readonly children: ReactNode; readonly scope?: ProjectScope; readonly admission?: TaskCacheScope; readonly admissionBlocked?: boolean }) => {
  const projects = useProjects(scope, admission, admissionBlocked);
  return <ProjectsContext.Provider value={projects}>{children}</ProjectsContext.Provider>;
};

export const useProjectList = () => {
  const projects = useContext(ProjectsContext);
  if (projects === null) throw new Error("Project browsing requires a ProjectsProvider.");
  return projects;
};
