import { ListPagination } from "./ListPagination";
import { StandaloneTaskRow } from "./StandaloneTaskRow";
import type { PaginationState } from "./usePagination";
import { useLayoutEffect, useRef } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import type { TaskSummary } from "../../api/types";
import type { GraphIndex } from "../task-graph/model";

type StandaloneListProps = {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly summaries?: ReadonlyMap<string, TaskSummary>;
  readonly taskIds: readonly string[];
  readonly allTaskIds: readonly string[];
  readonly onSelectTask: (id: string, trigger: HTMLElement) => void;
  readonly pagination?: PaginationState;
};

export const StandaloneList = ({ projectId, index, summaries, taskIds, allTaskIds, onSelectTask, pagination }: StandaloneListProps) => {
  const { messages: { workspace: { standalone: m }, assignment } } = useI18n();
  const container = useRef<HTMLElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (focusedControl.current !== null && !focusedControl.current.isConnected && document.activeElement === document.body) {
      (container.current?.querySelector<HTMLElement>(".standalone-row") ?? container.current)?.focus({ preventScroll: true });
    }
  }, [taskIds]);
  return (
    <section id="project-standalone-list" data-list-empty={allTaskIds.length === 0} tabIndex={-1} aria-label={m.list} ref={container} onFocusCapture={(event) => { focusedControl.current = event.target; }}>
      <div className="task-view-toolbar">
        <span className="task-view-summary" aria-label={m.summaryLabel({ visible: pagination === undefined ? taskIds.length : pagination.total, total: allTaskIds.length })}>{m.summary({ visible: pagination === undefined ? taskIds.length : pagination.total, total: allTaskIds.length })}</span>
      </div>
      {allTaskIds.length === 0 ? (
        <div className="state-box"><h3>{m.empty}</h3><p>{m.emptyDetail}</p></div>
      ) : taskIds.length === 0 ? (
        <div className="state-box"><h3>{assignment.noMatches}</h3></div>
      ) : (
        <ul className="standalone-list">{taskIds.map((id) => <StandaloneTaskRow key={id} projectId={projectId} task={index.nodes.get(id)!} {...(summaries?.get(id) === undefined ? {} : { tags: summaries.get(id)!.tags })} instanceId={`standalone-task-${id}`} onSelectTask={onSelectTask} />)}</ul>
      )}
      {pagination !== undefined && <ListPagination label={m.list} {...pagination} />}
    </section>
  );
};
