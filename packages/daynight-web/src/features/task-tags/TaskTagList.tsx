import type { TaskDetail, TaskSummary, TaskTag } from '../../api/types';
import './task-tags.css';

export const TaskTagList = ({ tags, id }: { readonly tags: readonly TaskTag[]; readonly id?: string }) => {
  if (tags.length === 0) return null;
  return <span className="task-tag-list" id={id}>{tags.map((tag) => <span className="task-tag" key={tag.id}>{tag.name}</span>)}</span>;
};

export const currentTaskTags = (detail: TaskDetail, summary: TaskSummary | undefined): readonly TaskTag[] =>
  summary !== undefined && summary.id === detail.id && summary.version > detail.version ? summary.tags : detail.tags;
