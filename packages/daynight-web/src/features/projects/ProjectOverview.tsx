import type { TaskGraph } from "../../api/types";
import { useI18n } from "../../i18n/LocaleProvider";

export const ProjectOverview = ({ summary }: { readonly summary: TaskGraph["summary"] }) => {
  const { messages: { workspace: { project: m, sections }, common }, format } = useI18n();
  const completion = summary.total === 0 ? 0 : Math.round(summary.done * 100 / summary.total);
  return <>
    <div className="project-section-heading"><h2>{sections.overview}</h2><p>{sections.overviewDescription}</p></div>
    <section className="stats" aria-label={m.statistics}>
      <div className="stat"><p className="stat-label">{m.totalTasks}</p><p className="stat-number">{format.number(summary.total)}</p><p className="stat-foot">{m.uniqueTasks}</p></div>
      <div className="stat done"><p className="stat-label">{common.status.done}</p><p className="stat-number">{format.number(summary.done)}</p><p className="stat-foot">{m.completion({ percent: completion })}</p></div>
      <div className="stat"><p className="stat-label">{common.status.todo}</p><p className="stat-number">{format.number(summary.todo)}</p><p className="stat-foot">{m.waiting}</p></div>
      <div className="stat active"><p className="stat-label">{common.status.in_progress}</p><p className="stat-number">{format.number(summary.inProgress)}</p><p className="stat-foot">{m.advancing}</p></div>
      <div className="stat ready"><p className="stat-label">{m.ready}</p><p className="stat-number">{format.number(summary.ready)}</p><p className="stat-foot">{m.todoSubset}</p></div>
      <div className="stat blocked"><p className="stat-label">{m.blocked}</p><p className="stat-number">{format.number(summary.blocked)}</p><p className="stat-foot">{m.todoSubset}</p></div>
    </section>
  </>;
};
