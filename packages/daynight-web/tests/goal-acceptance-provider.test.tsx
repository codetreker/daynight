import { act, fireEvent, screen } from '@testing-library/react';
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { GoalAcceptanceProvider } from '../src/features/goal-acceptance-graph/GoalAcceptanceProvider';
import { useGoalAcceptanceOwner } from '../src/features/goal-acceptance-graph/GoalAcceptanceContext';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';
import { createLocaleRender } from './helpers/renderWithLocale';
import { isTopOverlay, OverlayOwnerContext, registerOverlay } from '../src/app/overlay';
import { useDetailOverlay } from '../src/features/task-detail/DetailFrame';
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { getProjectAccess } from '../src/api/auth';
import { directAccessFixture } from './helpers/taskSync';

const mock = vi.hoisted(() => ({ mounted: [] as string[], source: new Map<string, { snapshot: GraphSnapshot; syncedSnapshot: GraphSnapshot; error: null; refresh: () => void }>(), sequence: 0 }));
vi.mock('../src/features/projects/useTaskGraph', () => ({ useTaskGraph: (projectId: string) => {
  useEffect(() => { mock.mounted.push(projectId); }, []);
  return mock.source.get(projectId)!;
} }));
vi.mock('../src/api/auth', async original => ({ ...await original<typeof import('../src/api/auth')>(), getProjectAccess: vi.fn() }));
vi.mock('../src/features/goal-acceptance-graph/GoalAcceptanceHost', () => ({ GoalAcceptanceHost: (props: {
  projectId: string; initialSelectedId: string; detailSnapshot: GraphSnapshot | null; onClose: () => void; onRestoreFocus: () => void; onSourceUnavailable: () => void;
}) => {
  const instance = useRef(++mock.sequence), restore = useRef(props.onRestoreFocus); restore.current = props.onRestoreFocus;
  const root = useRef<HTMLElement>(null), parent = useContext(OverlayOwnerContext);
  useLayoutEffect(() => registerOverlay(root.current!, parent?.current ?? null), [parent]);
  useEffect(() => () => restore.current(), []);
  return <section ref={root} data-testid={`graph-${props.projectId}`} data-instance={instance.current} data-qualified={props.detailSnapshot !== null}>
    <span>{props.initialSelectedId}</span><button onClick={props.onClose}>Close {props.projectId}</button><button onClick={props.onSourceUnavailable}>Unavailable {props.projectId}</button>
  </section>;
} }));

const a = '00000000-0000-4000-8000-000000000100', b = '00000000-0000-4000-8000-000000000200';
const renderLocale = createLocaleRender('en', { taskCache: true });
const render = (ui: ReactElement) => {
  const wrap = (content: ReactElement) => <ProjectAccessBoundary projectId={a}>{content}</ProjectAccessBoundary>;
  const rendered = renderLocale(wrap(ui));
  return { ...rendered, rerender: (content: ReactElement) => rendered.rerender(wrap(content)) };
};
const accessSessions: ProjectAccessSession[] = [];
const goal = '00000000-0000-4000-8000-000000000001';
const snapshot = (projectId: string) => snapshotFixture([detailFixture(projectId, goal, { type: 'goal', status: 'done', ready: false })]);
const Reader = ({ projectId, hidden = false, target, retired = false }: { projectId: string; hidden?: boolean; target?: string; retired?: boolean }) => {
  const { session, status } = useProjectAccess(projectId);
  useEffect(() => { accessSessions.push(session); }, [session]);
  const owner = useGoalAcceptanceOwner()!, root = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const [related, setRelated] = useState(false);
  useLayoutEffect(() => registerOverlay(root.current!, null), []);
  useLayoutEffect(() => { owner.attach(goal, root, heading); if (retired) owner.retire(goal); }, [owner, projectId, retired]);
  return <section ref={root} data-access-status={status}><h2 tabIndex={-1} ref={heading}>Reader {projectId}</h2><div hidden={hidden}>
    <button disabled={!owner.canOpen(goal)} onClick={event => owner.open({ projectId, goalId: goal, trigger: event.currentTarget, owner: root, fallback: heading })}>Open {projectId}</button>
  </div>{target !== undefined && <button onClick={() => setRelated(true)}>Read {target}</button>}
    {related && owner.renderRelated(target!, <Reader projectId={target!} {...(target === b ? { target: a } : {})} />)}
  </section>;
};
beforeEach(() => {
  mock.mounted.length = 0; mock.source.clear(); mock.sequence = 0; accessSessions.length = 0;
  vi.mocked(getProjectAccess).mockReset().mockImplementation(async projectId => directAccessFixture(projectId));
});

const RecoveryReader = ({ label }: { label: string }) => {
  const acceptance = useGoalAcceptanceOwner()!, root = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
  useDetailOverlay({ root, initialFocus: root, modal: false, fullscreen: false, scope: a, blocked: () => false, onEscape: () => {} });
  useLayoutEffect(() => acceptance.attach(goal, root, heading), [acceptance]);
  return <section ref={root} tabIndex={-1}><h2 ref={heading} tabIndex={-1}>{label}</h2>
    <button disabled={!acceptance.canOpen(goal)} onClick={event => acceptance.open({ projectId: a, goalId: goal, trigger: event.currentTarget, owner: root, fallback: heading })}>Open recovery graph</button>
  </section>;
};

describe('Goal acceptance detail owner', () => {
  it.each([false, true])('hands retired graph focus to the recovered reader unless another control was chosen: %s', moved => {
    const committed = snapshot(a), refresh = vi.fn();
    const view = (phase: string) => <><button>Other control</button><GoalAcceptanceProvider projectId={a} snapshot={phase === 'initial' ? committed : null} detailSnapshot={phase === 'initial' ? committed : null} graphError={null} onRefreshGraph={refresh}><RecoveryReader key={phase} label={phase} /></GoalAcceptanceProvider></>;
    const rendered = render(view('initial'));
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery graph' }));
    rendered.rerender(view('loading'));
    expect(screen.queryByTestId(`graph-${a}`)).toBeNull();
    expect(screen.getByRole('heading', { name: 'loading' })).toHaveFocus();
    if (moved) screen.getByRole('button', { name: 'Other control' }).focus();
    rendered.rerender(view('recovered'));
    expect(screen.queryByTestId(`graph-${a}`)).toBeNull();
    const heading = screen.getByRole('heading', { name: 'recovered' });
    if (moved) expect(heading).not.toHaveFocus();
    else expect(heading).toHaveFocus();
  });

  it('uses the replacement failure heading when attachment and source retirement batch in one layout effect', () => {
    const committed = snapshot(a), refresh = vi.fn();
    const view = (retired: boolean) => <GoalAcceptanceProvider projectId={a} snapshot={committed} detailSnapshot={committed} graphError={null} onRefreshGraph={refresh}><Reader key={String(retired)} projectId={a} retired={retired} /></GoalAcceptanceProvider>;
    const rendered = render(view(false));
    fireEvent.click(screen.getByRole('button', { name: `Open ${a}` }));
    rendered.rerender(view(true));
    expect(screen.queryByTestId(`graph-${a}`)).toBeNull();
    expect(screen.getByRole('heading', { name: `Reader ${a}` })).toHaveFocus();
  });

  it('restores the reader heading when the source read is denied before the original button is hidden', () => {
    const committed = snapshot(a);
    render(<GoalAcceptanceProvider projectId={a} snapshot={committed} detailSnapshot={committed} graphError={null} onRefreshGraph={vi.fn()}><Reader projectId={a} /></GoalAcceptanceProvider>);
    fireEvent.click(screen.getByRole('button', { name: `Open ${a}` }));
    fireEvent.click(screen.getByRole('button', { name: `Unavailable ${a}` }));
    expect(screen.queryByTestId(`graph-${a}`)).toBeNull();
    expect(screen.getByRole('heading', { name: `Reader ${a}` })).toHaveFocus();
    expect(screen.getByRole('button', { name: `Open ${a}` })).toBeVisible();
  });
  it('keeps a committed graph through detail qualification and reattaches a remounted reader', () => {
    const committed = snapshot(a), refresh = vi.fn();
    const view = (qualified: GraphSnapshot | null, key: string) => <GoalAcceptanceProvider projectId={a} snapshot={committed} detailSnapshot={qualified} graphError={null} onRefreshGraph={refresh}><Reader key={key} projectId={a} /></GoalAcceptanceProvider>;
    const rendered = render(view(committed, 'old'));
    fireEvent.click(screen.getByRole('button', { name: `Open ${a}` }));
    const instance = screen.getByTestId(`graph-${a}`).getAttribute('data-instance');
    rendered.rerender(view(null, 'new'));
    expect(screen.getByTestId(`graph-${a}`)).toHaveAttribute('data-instance', instance);
    expect(screen.getByTestId(`graph-${a}`)).toHaveAttribute('data-qualified', 'false');
    expect(isTopOverlay(screen.getByTestId(`graph-${a}`))).toBe(true);
    rendered.rerender(view(committed, 'new'));
    expect(screen.getByTestId(`graph-${a}`)).toHaveAttribute('data-instance', instance);
    fireEvent.click(screen.getByRole('button', { name: `Close ${a}` }));
    expect(screen.getByRole('heading', { name: `Reader ${a}` })).toHaveFocus();
    expect(mock.mounted).toEqual([]);
  });

  it('retires an invalidated baseline and requires a new entry after replacement', () => {
    const committed = snapshot(a), refresh = vi.fn();
    const view = (available: boolean) => <GoalAcceptanceProvider projectId={a} snapshot={available ? committed : null} detailSnapshot={available ? committed : null} graphError={null} onRefreshGraph={refresh}><Reader projectId={a} hidden={!available} /></GoalAcceptanceProvider>;
    const rendered = render(view(true));
    fireEvent.click(screen.getByRole('button', { name: `Open ${a}` }));
    const instance = screen.getByTestId(`graph-${a}`).getAttribute('data-instance');
    rendered.rerender(view(false));
    expect(screen.queryByTestId(`graph-${a}`)).toBeNull();
    expect(screen.getByRole('heading', { name: `Reader ${a}` })).toHaveFocus();
    expect(screen.getByRole('button', { name: `Open ${a}`, hidden: true })).toBeDisabled();
    rendered.rerender(view(true));
    expect(screen.queryByTestId(`graph-${a}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Open ${a}` }));
    expect(screen.getByTestId(`graph-${a}`)).not.toHaveAttribute('data-instance', instance);
  });

  it('allocates a foreign source when its reader opens and reuses ancestor sources for A to B to A', () => {
    const committed = snapshot(a), foreign = snapshot(b), refresh = vi.fn();
    mock.source.set(b, { snapshot: foreign, syncedSnapshot: foreign, error: null, refresh });
    render(<GoalAcceptanceProvider projectId={a} snapshot={committed} detailSnapshot={committed} graphError={null} onRefreshGraph={refresh}><Reader projectId={a} target={b} /></GoalAcceptanceProvider>);
    fireEvent.click(screen.getByRole('button', { name: `Read ${b}` }));
    expect(mock.mounted).toEqual([b]);
    fireEvent.click(screen.getByRole('button', { name: `Open ${b}` }));
    expect(screen.getByTestId(`graph-${b}`)).toHaveTextContent(goal);
    fireEvent.click(screen.getByRole('button', { name: `Read ${a}` }));
    fireEvent.click(screen.getAllByRole('button', { name: `Open ${a}` })[1]!);
    expect(screen.getByTestId(`graph-${a}`)).toHaveTextContent(goal);
    expect(mock.mounted).toEqual([b]);
    expect(accessSessions).toHaveLength(3);
    expect(accessSessions[1]!.projectId).toBe(b);
    expect(accessSessions[1]).not.toBe(accessSessions[0]);
    expect(accessSessions[2]).toBe(accessSessions[0]);
    act(() => accessSessions[0]!.publishMutation(null));
    for (const heading of screen.getAllByRole('heading', { name: `Reader ${a}` })) expect(heading.closest('section')).toHaveAttribute('data-access-status', 'unavailable');
    expect(mock.mounted).toEqual([b]);
  });
});
