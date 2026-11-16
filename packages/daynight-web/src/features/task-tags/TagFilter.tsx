import { useId } from 'react';
import type { ProjectTagColor } from '../../api/task-tags';
import { useI18n } from '../../i18n/LocaleProvider';
import { TagColorChip, TagColorFeedback } from './TagColor';
import { tagFilterMessages } from './tag-filter-messages';
import { useTagFilterPopover } from './useTagFilterPopover';
import { useTagColors } from './useTagColors';
import type { TagFilterController } from './useTagFilter';
import './tag-filter.css';

export { emptyTagFilter, matchesTagFilter, useTagFilter, type TagFilterController, type TagFilterValue } from './useTagFilter';

type Messages = (typeof tagFilterMessages)[keyof typeof tagFilterMessages];

const TagFilterCatalog = ({ controller, colors, messages: m, onClearQuery }: {
  readonly controller: TagFilterController;
  readonly colors: ReadonlyMap<string, ProjectTagColor>;
  readonly messages: Messages;
  readonly onClearQuery: () => void;
}) => {
  const { catalog, value, update } = controller;
  const items = catalog.page?.items;
  return <div className="tag-filter-catalog">
    <div className="tag-filter-options">
      {items?.map(tag => <label key={tag.id}>
        <input type="checkbox" checked={value.tagIds.includes(tag.id)} onChange={event => update({ ...value, untagged: false, tagIds: event.target.checked ? [...value.tagIds, tag.id] : value.tagIds.filter(id => id !== tag.id) }, { [tag.id]: tag.name })} />
        <TagColorChip name={tag.name} item={colors.get(tag.id)} />
      </label>)}
      {catalog.error === null && (items === undefined || items.length === 0) && <div className="tag-filter-state" role="status">
        <p>{catalog.loading && catalog.page === null ? m.loading : controller.query ? m.noMatches : m.empty}</p>
        {!catalog.loading && controller.query && <button className="tag-filter-text-button" type="button" onClick={onClearQuery}>{m.clearQuery}</button>}
      </div>}
      {catalog.error !== null && <div className={`tag-filter-catalog-error${items === undefined || items.length === 0 ? ' tag-filter-state' : ''}`} role="alert">
        <p>{m.error}</p><button className="tag-filter-text-button" type="button" onClick={catalog.refresh}>{m.retry}</button>
      </div>}
    </div>
    {(catalog.page?.nextCursor != null || catalog.cursor !== null) && <div className="tag-filter-pages">
      <button className="tag-filter-text-button" type="button" disabled={catalog.cursor === null} onClick={catalog.first}>{m.first}</button>
      <button className="tag-filter-text-button" type="button" disabled={catalog.page?.nextCursor == null} onClick={catalog.next}>{m.next}<span aria-hidden="true"> →</span></button>
    </div>}
  </div>;
};

const TagFilterMatch = ({ controller, messages: m, id }: { readonly controller: TagFilterController; readonly messages: Messages; readonly id: string }) => {
  const { value, update } = controller;
  const disabled = value.untagged || value.tagIds.length < 2;
  const reason = value.untagged ? m.matchUntagged : m.matchSingle;
  return <fieldset className="tag-filter-match" disabled={disabled} aria-describedby={disabled ? `${id}-reason` : undefined}>
    <legend>{m.match}</legend>
    <div className="tag-filter-match-options">{(['all', 'any'] as const).map(mode => <label key={mode}>
      <input type="radio" name={id} value={mode} checked={value.tagMatch === mode} onChange={() => update({ ...value, tagMatch: mode })} />
      <span>{m[mode]}</span>
    </label>)}</div>
    {disabled && <span className="tag-filter-sr-only" id={`${id}-reason`}>{reason}</span>}
  </fieldset>;
};

export const TagFilter = ({ controller, child = false, onManage }: { readonly controller: TagFilterController; readonly child?: boolean; readonly onManage?: () => void }) => {
  const { locale } = useI18n();
  const m = tagFilterMessages[locale];
  const { value, names, invalidIds, catalog, update } = controller;
  const title = child ? m.child : m.title;
  const id = useId();
  const colorIds = [...value.tagIds, ...(controller.open ? catalog.page?.items.map(tag => tag.id) ?? [] : [])];
  const colors = useTagColors(controller.projectId, colorIds);
  const popover = useTagFilterPopover(controller.open, controller.setOpen, locale);
  const clear = () => update({ ...value, tagIds: [], untagged: false });
  const count = value.untagged ? 1 : value.tagIds.length;
  const clearSearch = () => { controller.setQuery(''); popover.search.current?.focus(); };

  return <div ref={popover.wrap} className="tag-filter-wrap">
    <details ref={popover.details} className="tag-filter" open={controller.open} onToggle={event => controller.setOpen(event.currentTarget.open)} onKeyDown={popover.onKeyDown}>
      <summary ref={popover.trigger} className="tag-filter-trigger" aria-expanded={controller.open} aria-controls={`${id}-panel`} onClick={event => { event.preventDefault(); controller.setOpen(!controller.open); }}>
        {title}{count > 0 && <span className="tag-filter-count">{count}</span>}<span className="tag-filter-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div ref={popover.panel} id={`${id}-panel`} className="tag-filter-panel" hidden={!controller.open}>
        <div className="tag-filter-head"><strong>{title}</strong><button className="tag-filter-text-button" type="button" disabled={count === 0} onClick={clear}>{m.clear}</button></div>
        <div className="tag-filter-search">
          <input ref={popover.search} type="search" aria-label={`${title}: ${m.search}`} placeholder={`${m.search}…`} value={controller.query} onChange={event => controller.setQuery(event.target.value)} />
          {controller.query && <button className="tag-filter-search-clear" type="button" aria-label={m.clearSearch} onClick={clearSearch}>×</button>}
        </div>
        <TagFilterCatalog controller={controller} colors={colors.items} messages={m} onClearQuery={clearSearch} />
        <label className="tag-filter-untagged"><input type="checkbox" checked={value.untagged} onChange={event => update({ ...value, untagged: event.target.checked, tagIds: event.target.checked ? [] : value.tagIds })} /><span>{m.untagged}</span></label>
        <TagFilterMatch controller={controller} messages={m} id={`${id}-match`} />
        {!child && onManage !== undefined && <div className="tag-filter-manage"><button className="tag-filter-text-button" type="button" onClick={onManage}>{m.manage}</button></div>}
      </div>
    </details>
    {(value.tagIds.length > 0 || value.untagged) && <div className="tag-filter-selected">{value.tagIds.map(tagId => <TagColorChip className="tag-filter-chip" key={tagId} name={`${names[tagId] ?? tagId}${invalidIds.includes(tagId) && colors.items.get(tagId)?.state !== 'missing' ? ` · ${m.removed}` : ''}`} item={colors.items.get(tagId)}>
      <button type="button" aria-label={`${m.remove} ${names[tagId] ?? tagId}`} onClick={() => update({ ...value, tagIds: value.tagIds.filter(selected => selected !== tagId) })}>×</button>
    </TagColorChip>)}{value.untagged && <span className="tag-filter-chip">{m.untagged}<button type="button" aria-label={`${m.remove} ${m.untagged}`} onClick={() => update({ ...value, untagged: false })}>×</button></span>}</div>}
    <TagColorFeedback projectId={controller.projectId} ids={colorIds} onRetry={catalog.refresh} />
    {controller.invalid && <p className="tag-filter-error" role="alert">{m.invalid}</p>}
    {controller.error !== null && <p className="tag-filter-error" role="alert">{m.resolveError} <button className="tag-filter-text-button" type="button" onClick={controller.retry}>{m.retry}</button></p>}
  </div>;
};
