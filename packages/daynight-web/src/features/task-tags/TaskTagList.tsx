import type { TaskDetail, TaskSummary, TaskTag } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import './task-tags.css';

export const TaskTagList = ({ tags, id }: { readonly tags: readonly TaskTag[]; readonly id?: string }) => {
  const { locale } = useI18n();
  return <span className="task-tag-list" id={id}>{tags.length === 0
    ? <span className="task-tag-empty">{locale === 'zh-CN' ? '无标签' : 'Untagged'}</span>
    : tags.map((tag) => <span className="task-tag" key={tag.id}>{tag.name}</span>)}</span>;
};

export const currentTaskTags = (detail: TaskDetail, summary: TaskSummary | undefined): readonly TaskTag[] =>
  summary !== undefined && summary.id === detail.id && summary.version > detail.version ? summary.tags : detail.tags;
