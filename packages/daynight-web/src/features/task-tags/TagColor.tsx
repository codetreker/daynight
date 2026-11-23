import type { CSSProperties, ReactNode } from 'react';
import type { ProjectTagColor } from '../../api/task-tags';
import { ApiError } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTagColors } from './useTagColors';
import './task-tags.css';

// A pale tint keeps the text readable for every RGB value. The original color
// remains in the dot; its outline separates even a white dot from the tint.
export const tagColorStyle = (color: string): CSSProperties => {
  const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
  const blend = (white: number) => `rgb(${channels.map(channel => Math.round(channel * (1 - white) + 255 * white)).join(', ')})`;
  return { backgroundColor: blend(.9), borderColor: blend(.65), color: '#172132' };
};

export const TagColorChip = ({ name, item, children, className = '' }: { readonly name: string; readonly item: ProjectTagColor | undefined; readonly children?: ReactNode; readonly className?: string }) => {
  const { locale } = useI18n();
  const found = item?.state === 'found';
  const missing = item?.state === 'missing';
  return <span className={`task-tag${missing ? ' task-tag-missing' : ''}${className ? ` ${className}` : ''}`} style={found ? tagColorStyle(item.color) : undefined}>
    {found && <span className="task-tag-dot" style={{ backgroundColor: item.color }} aria-hidden="true" />}
    <span>{name}{missing ? (locale === 'zh-CN' ? ' · 已不可用' : ' · unavailable') : ''}</span>{children}
  </span>;
};

export const TagColorFeedback = ({ projectId, ids, onRetry }: { readonly projectId: string; readonly ids: readonly string[]; readonly onRetry?: () => void }) => {
  const { locale } = useI18n();
  const colors = useTagColors(projectId, ids);
  if (ids.length === 0) return null;
  const missing = ids.some(id => colors.items.get(id)?.state === 'missing');
  const initial = ids.some(id => !colors.items.has(id));
  const denied = colors.error instanceof ApiError && (colors.error.status === 403 || colors.error.status === 404 || colors.error.code === 'permission_denied');
  const text = colors.error !== null ? denied ? (locale === 'zh-CN' ? '无法访问标签颜色。' : 'Tag colors are inaccessible.') : (locale === 'zh-CN' ? '无法读取标签颜色。' : 'Could not load tag colors.') : missing ? (locale === 'zh-CN' ? '部分标签已不可用，请刷新核对。' : 'Some tags are unavailable. Refresh to check them.') : initial && colors.loading ? (locale === 'zh-CN' ? '正在读取标签颜色…' : 'Loading tag colors…') : null;
  if (text === null) return null;
  return <span className="task-tag-color-feedback" role={colors.error !== null || missing ? 'alert' : 'status'}>{text}{(colors.error !== null || missing) && <> <button type="button" onClick={() => { colors.retry(); onRetry?.(); }}>{locale === 'zh-CN' ? '重试' : 'Retry'}</button></>}</span>;
};
