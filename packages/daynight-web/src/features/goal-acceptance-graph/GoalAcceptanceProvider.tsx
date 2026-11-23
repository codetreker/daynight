import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { OverlayOwnerContext } from '../../app/overlay';
import type { GraphSnapshot } from '../projects/useTaskGraph';
import { useTaskGraph } from '../projects/useTaskGraph';
import { ProjectAccessBoundary } from '../projects/ProjectAccess';
import { GoalAcceptanceHost } from './GoalAcceptanceHost';
import { GoalAcceptanceOwnerContext, type GoalAcceptanceEntry as Entry, type GoalAcceptanceOwner } from './GoalAcceptanceContext';

type Source = { readonly snapshot: GraphSnapshot | null; readonly detailSnapshot: GraphSnapshot | null; readonly graphError: unknown; readonly onRefreshGraph: () => void };
const SourceContext = createContext<ReadonlyMap<string, Source>>(new Map());
const canRestore = (element: HTMLElement | null): element is HTMLElement => element !== null && element.isConnected &&
  !element.closest('[hidden], [inert]') && !element.matches(':disabled') && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';

export const GoalAcceptanceProvider = ({ projectId, snapshot, detailSnapshot, graphError, onRefreshGraph, children }: {
  readonly projectId: string;
  readonly snapshot: GraphSnapshot | null;
  readonly detailSnapshot: GraphSnapshot | null;
  readonly graphError: unknown;
  readonly onRefreshGraph: () => void;
  readonly children: ReactNode;
}) => {
  const inheritedSources = useContext(SourceContext);
  const source = useMemo<Source>(() => ({ snapshot, detailSnapshot, graphError, onRefreshGraph }), [snapshot, detailSnapshot, graphError, onRefreshGraph]);
  const sources = useMemo(() => new Map([...inheritedSources, [projectId, source]]), [inheritedSources, projectId, source]);
  const [entry, setEntry] = useState<Entry | null>(null);
  const currentEntry = useRef(entry); currentEntry.current = entry;
  const preferHeading = useRef(false);
  const attached = useRef(new Map<string, { owner: Entry['owner']; fallback: Entry['fallback'] }>());
  const close = useCallback(() => setEntry(null), []);
  const attach = useCallback((goalId: string, owner: Entry['owner'], fallback: Entry['fallback']) => {
    attached.current.set(goalId, { owner, fallback });
    setEntry(current => current === null || current.goalId !== goalId || current.owner === owner ? current : { ...current, owner, fallback });
  }, []);
  const retire = useCallback((goalId: string) => {
    if (currentEntry.current?.goalId === goalId) preferHeading.current = true;
    setEntry(current => current?.goalId === goalId ? null : current);
  }, []);
  const canOpen = useCallback((goalId: string) => snapshot !== null && detailSnapshot !== null && detailSnapshot.summaries.get(goalId)?.type === 'goal', [snapshot, detailSnapshot]);
  const open = useCallback((next: Entry) => { if (next.projectId === projectId && canOpen(next.goalId)) { preferHeading.current = false; setEntry(next); } }, [projectId, canOpen]);
  const renderRelated = useCallback((relatedProjectId: string, content: ReactNode) => {
    const existing = sources.get(relatedProjectId);
    return existing === undefined
      ? <ProjectAccessBoundary projectId={relatedProjectId} initialRead><RelatedGoalScope projectId={relatedProjectId}>{content}</RelatedGoalScope></ProjectAccessBoundary>
      : <GoalAcceptanceProvider projectId={relatedProjectId} {...existing}>{content}</GoalAcceptanceProvider>;
  }, [sources]);
  const value = useMemo<GoalAcceptanceOwner>(() => ({ projectId, canOpen, open, attach, retire, renderRelated }), [projectId, canOpen, open, attach, retire, renderRelated]);
  useLayoutEffect(() => {
    if (snapshot === null || entry !== null && (entry.projectId !== projectId || detailSnapshot !== null && detailSnapshot.summaries.get(entry.goalId)?.type !== 'goal')) { preferHeading.current = true; close(); }
  }, [projectId, snapshot, detailSnapshot, entry, close]);
  return <SourceContext value={sources}><GoalAcceptanceOwnerContext value={value}>{children}{entry !== null && entry.projectId === projectId && snapshot !== null && (detailSnapshot === null || detailSnapshot.summaries.get(entry.goalId)?.type === 'goal') && <OverlayOwnerContext value={entry.owner}>
    <GoalAcceptanceHost projectId={projectId} snapshot={snapshot} detailSnapshot={detailSnapshot} initialSelectedId={entry.goalId} trigger={entry.trigger}
      onRestoreFocus={() => {
        const fallback = attached.current.get(entry.goalId)?.fallback ?? entry.fallback;
        const control = !preferHeading.current && canRestore(entry.trigger) ? entry.trigger : fallback.current;
        if (canRestore(control)) control.focus({ preventScroll: true });
      }}
      onClose={close} onSourceUnavailable={() => retire(entry.goalId)} onRefreshGraph={onRefreshGraph} graphError={graphError} />
  </OverlayOwnerContext>}</GoalAcceptanceOwnerContext></SourceContext>;
};

const RelatedGoalScope = ({ projectId, children }: { readonly projectId: string; readonly children: ReactNode }) => {
  const graph = useTaskGraph(projectId);
  return <GoalAcceptanceProvider projectId={projectId} snapshot={graph.syncedSnapshot} detailSnapshot={graph.snapshot} graphError={graph.error} onRefreshGraph={graph.refresh}>{children}</GoalAcceptanceProvider>;
};
