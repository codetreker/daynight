import { createContext, useContext, type ReactNode } from "react";
import { useProjects } from "./useProjects";

const ProjectsContext = createContext<ReturnType<typeof useProjects> | null>(null);

export const ProjectsProvider = ({ children }: { readonly children: ReactNode }) => {
  const projects = useProjects();
  return <ProjectsContext.Provider value={projects}>{children}</ProjectsContext.Provider>;
};

export const useProjectList = () => {
  const projects = useContext(ProjectsContext);
  if (projects === null) throw new Error("Project browsing requires a ProjectsProvider.");
  return projects;
};
