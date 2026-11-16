import type { TaskDetail, TaskSummary, TaskTag } from '../../api/types';
import { TagColorChip, TagColorFeedback } from './TagColor';
import { useTagColors } from './useTagColors';
import './task-tags.css';

type Props = { readonly projectId: string; readonly tags: readonly TaskTag[]; readonly id?: string; readonly feedback?: boolean; readonly active?: boolean };

export const TaskTagList = (props: Props) => props.tags.length === 0 ? null : <PopulatedTaskTagList {...props} />;

const PopulatedTaskTagList = ({ projectId, tags, id, feedback = true, active = true }: Props) => {
  const ids = active ? tags.map(tag => tag.id) : [];
  const colors = useTagColors(projectId, ids);
  return <span className="task-tag-list" id={id}>{tags.map(tag => <TagColorChip key={tag.id} name={tag.name} item={colors.items.get(tag.id)} />)}{feedback && active && <TagColorFeedback projectId={projectId} ids={ids} />}</span>;
};

export const currentTaskTags = (detail: TaskDetail, summary: TaskSummary | undefined): readonly TaskTag[] =>
  summary !== undefined && summary.id === detail.id && summary.version > detail.version ? summary.tags : detail.tags;
