import { useLayoutEffect } from "react";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import { ProjectsPage } from "./ProjectsPage";
import { ProjectsProvider, useProjectList } from "./ProjectsProvider";

type RegisterRefresh = (refresh: () => void) => () => void;

const SharedDirectory = ({ registerRefresh, eyebrow, title, subtitle, emptyDetail }: {
  readonly registerRefresh: RegisterRefresh;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
  readonly emptyDetail: string;
}) => {
  const { refresh } = useProjectList();
  useLayoutEffect(() => registerRefresh(refresh), [registerRefresh, refresh]);
  return <ProjectsPage eyebrow={eyebrow} title={title} subtitle={subtitle} emptyDetail={emptyDetail} />;
};

export const SharedProjectsPage = ({ admission, admissionBlocked, registerRefresh, eyebrow, title, subtitle, emptyDetail }: {
  readonly admission: TaskCacheScope;
  readonly admissionBlocked: boolean;
  readonly registerRefresh: RegisterRefresh;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
  readonly emptyDetail: string;
}) => <ProjectsProvider scope={{ kind: "shared" }} admission={admission} admissionBlocked={admissionBlocked}>
  <SharedDirectory registerRefresh={registerRefresh} eyebrow={eyebrow} title={title} subtitle={subtitle} emptyDetail={emptyDetail} />
</ProjectsProvider>;
