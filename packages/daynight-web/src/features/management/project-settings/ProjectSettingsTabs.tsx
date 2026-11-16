import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
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
  useLayoutEffect(() => {
    const container = nav.current, link = container?.querySelector<HTMLAnchorElement>('[aria-current="page"]');
    if (!container || !link || container.scrollWidth <= container.clientWidth) return;
    const left = link.offsetLeft, right = left + link.offsetWidth;
    if (left < container.scrollLeft) container.scrollLeft = left;
    else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth;
  }, [selected]);
  const follow = (event: MouseEvent<HTMLAnchorElement>, tab: ProjectSettingsTab) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onSelect(tab);
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
  };
  return <nav ref={nav} className="project-settings-tabs" aria-label={m.navigation} onKeyDown={keyDown}>
    {tabs.map(tab => <a key={tab} id={`project-settings-${projectId}-tab-${tab}`} href={projectSettingsUrl(projectId, tab)} aria-controls={`project-settings-${projectId}-section-${tab}`} aria-current={selected === tab ? 'page' : undefined} onClick={event => follow(event, tab)}>
      <span>{m[tab]}</span><span className="project-settings-tab-state">{[states[tab].dirty && m.dirty, states[tab].pending && m.pending, states[tab].needsAttention && m.attention].filter(Boolean).join(' · ')}</span>
    </a>)}
  </nav>;
};
