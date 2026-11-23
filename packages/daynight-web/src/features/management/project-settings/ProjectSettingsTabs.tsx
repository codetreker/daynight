import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { projectSettingsUrl, type ProjectSettingsTab } from '../../../app/project-settings-route';
import { useI18n } from '../../../i18n/LocaleProvider';
import type { ProjectSettingsSectionState } from './section-state';
import { settingsWorkspaceMessages } from './messages';

export const tabs: readonly ProjectSettingsTab[] = ['execution', 'prompts', 'github', 'members', 'management'];
export const ProjectSettingsTabs = ({ projectId, selected, states, onSelect }: {
  readonly projectId: string;
  readonly selected: ProjectSettingsTab | null;
  readonly states: Record<ProjectSettingsTab, ProjectSettingsSectionState>;
  readonly onSelect: (tab: ProjectSettingsTab) => void;
}) => {
  const { locale } = useI18n();
  const m = settingsWorkspaceMessages[locale];
  const nav = useRef<HTMLElement>(null);
  const stateLabels = tabs.map(tab => [states[tab].dirty && m.dirty, states[tab].pending && m.pending, states[tab].needsAttention && m.attention].filter(Boolean).join(' · '));
  const selectedStateLabel = selected === null ? '' : stateLabels[tabs.indexOf(selected)];
  const revealSelected = useCallback(() => {
    const container = nav.current, link = container?.querySelector<HTMLAnchorElement>('[aria-current="page"]');
    if (!container || !link || container.scrollWidth <= container.clientWidth || getComputedStyle(container).flexDirection !== 'row') return;
    const bounds = container.getBoundingClientRect(), selectedBounds = link.getBoundingClientRect();
    const left = bounds.left + container.clientLeft + 4, right = left + container.clientWidth - 8;
    // An oversized item keeps its beginning visible; scrolling by hand can still reveal its end.
    const delta = selectedBounds.width > right - left || selectedBounds.left < left - 1
      ? selectedBounds.left - left
      : selectedBounds.right > right + 1 ? selectedBounds.right - right : 0;
    if (Math.abs(delta) > 1) container.scrollLeft += delta;
  }, []);
  useLayoutEffect(revealSelected, [revealSelected, selected, locale, selectedStateLabel]);
  useLayoutEffect(() => {
    const container = nav.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(revealSelected);
    observer.observe(container, { box: 'border-box' });
    for (const link of container.querySelectorAll('a')) observer.observe(link, { box: 'border-box' });
    return () => observer.disconnect();
  }, [revealSelected]);
  const follow = (event: MouseEvent<HTMLAnchorElement>, tab: ProjectSettingsTab) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onSelect(tab);
    if (tab === selected) revealSelected();
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    const horizontal = window.matchMedia('(max-width: 740px)').matches;
    const previous = horizontal ? 'ArrowLeft' : 'ArrowUp', next = horizontal ? 'ArrowRight' : 'ArrowDown';
    if (![previous, next, 'Home', 'End'].includes(event.key)) return;
    const links = [...(nav.current?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
    const focused = event.target instanceof Element ? event.target.closest('a') : null;
    const current = Math.max(0, focused === null ? tabs.indexOf(selected ?? 'execution') : links.indexOf(focused));
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === next ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    const tab = tabs[index]!;
    onSelect(tab);
    nav.current?.querySelectorAll<HTMLAnchorElement>('a')[index]?.focus({ preventScroll: true });
    if (tab === selected) revealSelected();
  };
  return <nav ref={nav} className="project-settings-tabs" aria-label={m.navigation} onKeyDown={keyDown}>
    {tabs.map((tab, index) => <a key={tab} id={`project-settings-${projectId}-tab-${tab}`} href={projectSettingsUrl(projectId, tab)} aria-controls={`project-settings-${projectId}-section-${tab}`} aria-current={selected === tab ? 'page' : undefined} onClick={event => follow(event, tab)}>
      <span>{m[tab]}</span><span className="project-settings-tab-state">{stateLabels[index]}</span>
    </a>)}
  </nav>;
};
