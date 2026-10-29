import { readProjectSnapshot } from './project-snapshot';
import { closeChain, expectClosedChain, expectOpenChain, openChain } from './chain-dialog';
import { selectTaskList } from './project-view';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { evidenceDirectory, expect, test, updateTask } from './fixtures';
import { seedCapacity, seedNodeLimit, type CapacityFixture, type CapacityKind } from './capacity-data';
import { withCapacityTrace } from './capacity-trace';
import { panPoint } from './graph-pan';
import { captureStableDependencyGeometry, checkDependencyGeometry, type GeometryExpectation } from './dependency-geometry';
import { expectedBatch, expectedDependencyTopology, expectedNodeHeights, expectedOverview, type ChainTopology } from './visible-topology';

// Repeated DOM snapshots of capacity views add controller work between
// measured interactions. Dedicated CDP timelines and scenario PNGs retain the
// rendering evidence alongside Playwright's action and network trace.
test.use({ trace: 'off' });

type ExpansionMeasurement = { openMs: number; layoutMs: number; renderMs: number };
type Measurement = ExpansionMeasurement & { selectMs: number; detailMs: number; detailNetworkMs: number; zoomMs: number; panMs: number };
type VisibilityMeasurement = { repetition: number; selectedId: string; overviewNodes: number; overviewEdges: number; hiddenUpstream: number; addedNodes: number; addedEdges: number; expandedNodes: number; expandedEdges: number; resetNodes: number; resetEdges: number };
type Dataset = {
  scenario: string; nodes: 1000; edges: number; result: 'running' | 'passed' | 'failed';
  networkMs?: number; coldOpenMs?: number; measurements: Measurement[]; visibility: VisibilityMeasurement[]; feedbackDiagnostics: FeedbackDiagnostic[]; error?: string;
  syncReads?: { initial: number; periodic: number; network: number };
  controllerDurations: { fixtureMs?: number; snapshotMs?: number; repetitions: { interactionMs: number; totalMs: number }[] };
};
type Limit = { status: number; nodeCount: number; edgeCount: number; maxNodes: number; maxEdges: number };
const receipt: {
  schemaVersion: 1; result: 'running' | 'passed' | 'failed'; datasets: Dataset[];
  limits: { node?: Limit; edge?: Limit };
  timing: { start: string; end: string; panStart: string };
} = {
  schemaVersion: 1, result: 'running', datasets: [], limits: {},
  timing: {
    start: 'trusted browser input event.timeStamp', end: 'DOM condition and two requestAnimationFrame callbacks',
    panStart: 'first primary-button pointermove',
  },
};
let mergeFixture: CapacityFixture | undefined;

const persist = async () => {
  const path = join(evidenceDirectory(), 'performance.json');
  await mkdir(evidenceDirectory(), { recursive: true });
  await writeFile(`${path}.next`, `${JSON.stringify(receipt, null, 2)}\n`);
  await rename(`${path}.next`, path);
};

const withScreenshot = async (page: Page, info: TestInfo, name: string, operation: () => Promise<void>) => {
  let failure: unknown;
  try { await operation(); } catch (error) { failure = error; }
  try {
    const path = join(evidenceDirectory(), `${name}.png`);
    await page.screenshot({ path, fullPage: false });
    await info.attach(name, { path, contentType: 'image/png' });
  } catch (error) {
    failure = failure === undefined ? error : new AggregateError([failure, error], 'Capacity scenario and screenshot both failed.');
  }
  if (failure !== undefined) throw failure;
};

const painted = (page: Page) => page.evaluate(() => new Promise<number>((resolve) => {
  requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(performance.now()); }); });
}));
const count = (value: number): string => new Intl.NumberFormat('zh-CN').format(value);
const transform = (page: Page) => page.locator('.react-flow__viewport').evaluate((element) => (element as HTMLElement).style.transform);

type TimingCondition =
  | { kind: 'open'; rootId: string; nodes: number; edges: number }
  | { kind: 'select'; rootId: string }
  | { kind: 'detail'; rootId: string }
  | { kind: 'zoom' | 'pan'; previousTransform: string };
type BrowserTiming = {
  status: 'armed' | 'running' | 'finished' | 'failed'; start: number | null;
  capturedAt: number | null; conditionAt: number | null; frame1At: number | null; frame2At: number | null;
  end: number | null; error: string | null; cleanup: () => void;
};
type FeedbackDiagnostic = {
  key: string; kind: TimingCondition['kind']; repetition: number; status: BrowserTiming['status'];
  start: number | null; capturedAt: number | null; conditionAt: number | null; frame1At: number | null; frame2At: number | null;
  end: number | null; error: string | null;
  phases: { inputQueueMs: number | null; conditionMs: number | null; firstFrameMs: number | null; secondFrameMs: number | null };
};
type TimingWindow = Window & { __daynightCapacityTiming?: Record<string, BrowserTiming> };
type SyncFetchWindow = Window & { __daynightCapacitySyncFetches: { pollingCallback: number | null; start: number }[] };
let timingSequence = 0;

const observeSyncFetches = async (page: Page, projectId: string): Promise<void> => {
  await page.addInitScript(({ projectId }) => {
    const host = window as unknown as SyncFetchWindow;
    host.__daynightCapacitySyncFetches = [];
    let pollingCallback = 0;
    let consumedCallback = 0;
    const nativeInterval = window.setInterval.bind(window);
    const nativeFetch = window.fetch.bind(window);
    // Cache reads can cross IndexedDB tasks before fetch; retain the real polling
    // callback's provenance until its network read consumes it.
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (typeof handler !== 'function' || timeout !== 5_000) return nativeInterval(handler, timeout, ...args);
      return nativeInterval(function (this: Window, ...parameters: unknown[]) {
        pollingCallback += 1;
        return Reflect.apply(handler, this, parameters);
      }, timeout, ...args);
    }) as typeof window.setInterval;
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.origin === window.location.origin && url.pathname === `/api/v1/projects/${projectId}/task-sync` && method.toUpperCase() === 'GET') {
        const callback = pollingCallback > consumedCallback ? pollingCallback : null;
        host.__daynightCapacitySyncFetches.push({ pollingCallback: callback, start: performance.now() });
        if (callback !== null) consumedCallback = callback;
      }
      return nativeFetch(input, init);
    };
  }, { projectId });
};


const measureBrowserFeedback = async (page: Page, condition: TimingCondition, action: () => Promise<void>, dataset: Dataset, repetition: number) => {
  const key = `${dataset.scenario}:repetition-${repetition}:${condition.kind}:${++timingSequence}`;
  await page.evaluate(({ key, condition }) => {
    const host = window as TimingWindow;
    if (host.__daynightCapacityTiming === undefined) host.__daynightCapacityTiming = {};
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    let finishing = false;
    let countsDirty = true;
    let countsReady = false;
    const state: BrowserTiming = {
      status: 'armed', start: null, capturedAt: null, conditionAt: null, frame1At: null, frame2At: null, end: null, error: null,
      cleanup: () => {
        observer.disconnect();
        document.removeEventListener(eventType, start, true);
        if (firstFrame !== null) cancelAnimationFrame(firstFrame);
        if (secondFrame !== null) cancelAnimationFrame(secondFrame);
      },
    };
    host.__daynightCapacityTiming[key] = state;

    const ready = (): boolean => {
      if (condition.kind === 'select') return document.querySelector(`.react-flow__node[data-id="${condition.rootId}"] .task-node[data-inspection="selected"] .task-node-body[aria-pressed="true"]`) !== null;
      if (condition.kind === 'detail') {
        const dialog = document.querySelector('.task-detail-dialog');
        if (dialog === null) return false;
        const bounds = dialog.getBoundingClientRect();
        const style = getComputedStyle(dialog);
        return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }
      const viewport = document.querySelector('.react-flow__viewport') as HTMLElement | null;
      if (viewport === null) return false;
      if (condition.kind !== 'open') return viewport.style.transform !== condition.previousTransform;
      if (countsDirty) {
        const svg = document.querySelector<SVGSVGElement>('.task-dependency-edges');
        const expectedPaintPieces = svg?.getAttribute('data-paint-piece-count');
        const validPaintCount = expectedPaintPieces !== null && expectedPaintPieces !== undefined
          && /^(0|[1-9]\d*)$/.test(expectedPaintPieces) && Number.isSafeInteger(Number(expectedPaintPieces));
        countsReady = document.querySelectorAll('.react-flow__node').length === condition.nodes
          && document.querySelectorAll('.react-flow__node .task-node').length === condition.nodes
          && document.querySelectorAll('.react-flow__edge-path').length === condition.edges
          && document.querySelectorAll('.react-flow__edge-path[marker-end]').length === condition.edges
          && validPaintCount && svg!.querySelectorAll('.task-dependency-paint-piece').length === Number(expectedPaintPieces);
        countsDirty = false;
      }
      if (!countsReady) return false;
      const canvas = document.querySelector('.task-graph-canvas');
      const source = document.querySelector(`.react-flow__node[data-id="${condition.rootId}"] .task-node`);
      if (canvas === null || source === null) return false;
      const bounds = canvas.getBoundingClientRect();
      const node = source.getBoundingClientRect();
      const zoom = Number(/scale\(([^)]+)\)/.exec(viewport.style.transform)?.[1]);
      return zoom >= 0.8 && zoom <= 1 && node.left >= bounds.left && node.top >= bounds.top
        && node.right <= bounds.right && node.bottom <= bounds.bottom;
    };
    const check = () => {
      if (state.status !== 'running' || finishing) return;
      try {
        if (!ready()) return;
        if (state.conditionAt === null) {
          state.conditionAt = performance.now();
          performance.mark(`daynight:${key}:condition`, { startTime: state.conditionAt });
        }
        finishing = true;
        firstFrame = requestAnimationFrame(() => {
          if (state.frame1At === null) {
            state.frame1At = performance.now();
            performance.mark(`daynight:${key}:raf1`, { startTime: state.frame1At });
          }
          secondFrame = requestAnimationFrame(() => {
            if (state.frame2At === null) {
              state.frame2At = performance.now();
              performance.mark(`daynight:${key}:raf2`, { startTime: state.frame2At });
            }
            try {
              finishing = false;
              if (!ready()) return;
              state.end = performance.now();
              performance.mark(`daynight:${key}:end`, { startTime: state.end });
              state.status = 'finished';
              state.cleanup();
            } catch (error) {
              state.status = 'failed';
              state.error = error instanceof Error ? error.message : 'Browser feedback observer failed.';
              state.cleanup();
            }
          });
        });
      } catch (error) {
        state.status = 'failed';
        state.error = error instanceof Error ? error.message : 'Browser feedback observer failed.';
        state.cleanup();
      }
    };
    const eventType = condition.kind === 'pan' ? 'pointermove' : 'click';
    const start = (event: Event) => {
      if (state.status !== 'armed' || !event.isTrusted || !(event.target instanceof Element)) return;
      const selector = condition.kind === 'open' ? `#task-chain-graph-${condition.rootId}`
        : condition.kind === 'detail' ? `.react-flow__node[data-id="${condition.rootId}"] .task-node-details`
          : condition.kind === 'select' ? `.react-flow__node[data-id="${condition.rootId}"] .task-node-body`
          : condition.kind === 'zoom' ? '.react-flow__controls-zoomin' : '.react-flow__pane';
      if (event.target.closest(selector) === null) return;
      if (condition.kind === 'pan' && (!(event instanceof PointerEvent) || event.buttons !== 1 || !event.isPrimary)) return;
      const capturedAt = performance.now();
      if (!Number.isFinite(event.timeStamp) || event.timeStamp < 0 || event.timeStamp > capturedAt) {
        state.status = 'failed';
        state.error = 'Trusted browser input timestamp does not use the performance clock.';
        state.cleanup();
        return;
      }
      state.start = event.timeStamp;
      state.capturedAt = capturedAt;
      performance.mark(`daynight:${key}:event`, { startTime: state.start });
      performance.mark(`daynight:${key}:capture`, { startTime: capturedAt });
      state.status = 'running';
      queueMicrotask(check);
    };
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === 'childList')) countsDirty = true;
      check();
    });
    const target = condition.kind === 'open' || condition.kind === 'detail' ? document.body : document.querySelector('.react-flow__viewport')!;
    observer.observe(target, condition.kind === 'detail' ? { childList: true, subtree: true } : {
      childList: condition.kind === 'open', subtree: condition.kind === 'open' || condition.kind === 'select',
      attributes: true, attributeFilter: condition.kind === 'select' ? ['data-inspection', 'aria-pressed', 'class'] : ['style'],
    });
    document.addEventListener(eventType, start, true);
  }, { key, condition });
  let original: unknown;
  try {
    await action();
    await page.waitForFunction((key) => {
      const state = (window as TimingWindow).__daynightCapacityTiming?.[key];
      return state?.status === 'finished' || state?.status === 'failed';
    }, key);
    const result = await page.evaluate((key) => {
      const state = (window as TimingWindow).__daynightCapacityTiming![key]!;
      return { start: state.start, capturedAt: state.capturedAt, end: state.end, error: state.error };
    }, key);
    if (result.error !== null || result.start === null || result.capturedAt === null || result.end === null) {
      throw new Error(result.error ?? 'Browser feedback timing is incomplete.');
    }
    expect(result.capturedAt).toBeGreaterThanOrEqual(result.start);
    expect(result.end).toBeGreaterThanOrEqual(result.capturedAt);
    return { start: result.start, end: result.end, duration: result.end - result.start };
  } catch (error) {
    original = error;
    throw error;
  } finally {
    let diagnosticsFailure: unknown;
    try {
      const diagnostic = await page.evaluate((key) => {
        const state = (window as TimingWindow).__daynightCapacityTiming![key]!;
        const difference = (end: number | null, start: number | null): number | null => end === null || start === null ? null : end - start;
        return {
          status: state.status, start: state.start, capturedAt: state.capturedAt, conditionAt: state.conditionAt,
          frame1At: state.frame1At, frame2At: state.frame2At, end: state.end, error: state.error,
          phases: { inputQueueMs: difference(state.capturedAt, state.start), conditionMs: difference(state.conditionAt, state.capturedAt),
            firstFrameMs: difference(state.frame1At, state.conditionAt), secondFrameMs: difference(state.frame2At, state.frame1At) },
        };
      }, key);
      dataset.feedbackDiagnostics.push({ key, kind: condition.kind, repetition, ...diagnostic });
      await persist();
    } catch (error) { diagnosticsFailure = error; }
    try {
      await page.evaluate((key) => {
        const host = window as TimingWindow;
        host.__daynightCapacityTiming?.[key]?.cleanup();
        delete host.__daynightCapacityTiming?.[key];
      }, key);
    } catch (error) {
      diagnosticsFailure = diagnosticsFailure === undefined ? error : new AggregateError([diagnosticsFailure, error], 'Browser feedback diagnostics and observer cleanup failed.');
    }
    if (diagnosticsFailure !== undefined) {
      if (original !== undefined) throw new AggregateError([original, diagnosticsFailure], 'Browser feedback measurement and diagnostics failed.');
      throw diagnosticsFailure;
    }
  }
};

const visibleGraph = async (page: Page, rootId: string, overview: GeometryExpectation) => {
  await expect(page.locator('.react-flow__node')).toHaveCount(overview.nodes.length);
  await expect(page.locator('.react-flow__node .task-node')).toHaveCount(overview.nodes.length);
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(overview.edges.length);
  await expect(page.locator('.react-flow__edge-path[marker-end]')).toHaveCount(overview.edges.length);
  await page.waitForFunction((id) => {
    const svg = document.querySelector<SVGSVGElement>('.task-dependency-edges');
    const count = svg?.getAttribute('data-paint-piece-count');
    if (count === null || count === undefined || !/^(0|[1-9]\d*)$/.test(count) || !Number.isSafeInteger(Number(count)) || svg!.querySelectorAll('.task-dependency-paint-piece').length !== Number(count)) return false;
    const canvas = document.querySelector('.task-graph-canvas'); const source = document.querySelector(`.react-flow__node[data-id="${id}"] .task-node`);
    if (canvas === null || source === null) return false;
    const bounds = canvas.getBoundingClientRect(); const node = source.getBoundingClientRect();
    const viewport = document.querySelector('.react-flow__viewport') as HTMLElement;
    const zoom = Number(/scale\(([^)]+)\)/.exec(viewport.style.transform)?.[1]);
    return zoom >= 0.8 && zoom <= 1 && node.left >= bounds.left && node.top >= bounds.top && node.right <= bounds.right && node.bottom <= bounds.bottom;
  }, rootId);
  return painted(page);
};

const assertVisibleTopology = async (page: Page, expected: GeometryExpectation, full: ChainTopology) => {
  const actual = await page.evaluate(() => ({ stats: { shown: document.querySelector<HTMLElement>('.task-graph')!.dataset.visibleTaskCount, total: document.querySelector<HTMLElement>('.task-graph')!.dataset.totalTaskCount, counts: document.querySelector('.graph-counts')!.textContent }, nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => ({ id: node.dataset.id!, height: node.style.height })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...document.querySelectorAll<SVGGElement>('.task-dependency-edge')].map((edge) => { const path = edge.querySelector<SVGPathElement>('.react-flow__edge-path')!; return { id: edge.dataset.id!, source: path.dataset.source!, target: path.dataset.target!, external: edge.getAttribute('data-external') === 'true' }; }).sort((a, b) => a.id.localeCompare(b.id)) }));
  const external = new Set(full.nodes.filter((node) => !full.memberIds.includes(node.id)).map((node) => node.id));
  expect(actual, 'Every visible task, induced dependency and full projection statistic exactly matches the API graph').toEqual({ stats: { shown: String(expected.nodes.length), total: String(full.nodes.length), counts: `链内 ${count(full.nodes.length - external.size)} · 外部 ${count(external.size)} · 任务 ${count(expected.nodes.length)}/${count(full.nodes.length)} · 依赖 ${count(expected.edges.length)}/${count(full.edges.length)}` }, nodes: expectedNodeHeights(full, expected.nodes.map(({ id }) => id)).map(({ id, height }) => ({ id, height: `${height}px` })).sort((a, b) => a.id.localeCompare(b.id)), edges: [...expected.edges].sort((a, b) => a.id.localeCompare(b.id)) });
};
const ancestorClosure = (fixture: CapacityFixture, selectedId: string): Set<string> => {
  const tasks = new Map(fixture.tasks.map((task) => [task.id, task])); const closure = new Set([selectedId]); const pending = [selectedId];
  while (pending.length > 0) for (const id of tasks.get(pending.pop()!)!.dependsOn) if (!closure.has(id)) { closure.add(id); pending.push(id); }
  return closure;
};

const expectedCapacityGeometry = (fixture: CapacityFixture): ChainTopology => expectedDependencyTopology(fixture.tasks, fixture.root.id);
const stableGeometry = (page: Page) => page.evaluate(captureStableDependencyGeometry);
const bodyGeometry = (snapshot: Awaited<ReturnType<typeof stableGeometry>>) => ({ nodes: snapshot.geometry.nodes, paths: snapshot.geometry.paths, pieces: snapshot.geometry.pieces });

const assertInspection = async (page: Page, fixture: CapacityFixture, selectedId: string | null, visible: GeometryExpectation) => {
  const tasks = new Map(fixture.tasks.map((task) => [task.id, task]));
  const closure = new Set<string>(selectedId === null ? [] : [selectedId]); const pending = [...closure];
  while (pending.length > 0) for (const id of tasks.get(pending.pop()!)!.dependsOn) if (!closure.has(id)) { closure.add(id); pending.push(id); }
  const geometry = expectedCapacityGeometry(fixture);
  const external = new Set(geometry.nodes.filter((node) => !geometry.memberIds.includes(node.id)).map((node) => node.id));
  const states = { todo: { label: '待处理', color: 'rgb(114, 126, 144)' }, in_progress: { label: '进行中', color: 'rgb(72, 103, 181)' }, done: { label: '已完成', color: 'rgb(40, 116, 84)' } };
  const expected = {
    nodes: fixture.tasks.filter((task) => visible.nodes.some((node) => node.id === task.id)).map((task) => ({
      id: task.id, state: selectedId === null ? 'normal' : task.id === selectedId ? 'selected' : closure.has(task.id) ? 'prerequisite' : 'unrelated', pressed: String(task.id === selectedId),
      background: selectedId === null ? external.has(task.id) ? 'rgb(246, 247, 250)' : 'rgb(255, 255, 255)' : task.id === selectedId ? 'rgb(240, 239, 255)' : closure.has(task.id) ? 'rgb(247, 246, 255)' : 'rgb(249, 250, 252)',
      bodyTag: 'BUTTON', bodyType: 'button', bodyPopup: null, detailsTag: 'BUTTON', detailsType: 'button', detailsPopup: 'dialog',
      status: states[task.status].label, statusColor: states[task.status].color, borderColor: states[task.status].color, borderStyle: external.has(task.id) ? 'dashed' : 'solid',
    })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: visible.edges.map((edge) => {
      const highlighted = closure.has(edge.source) && closure.has(edge.target); const color = selectedId === null ? 'rgb(171, 178, 199)' : highlighted ? 'rgb(103, 98, 206)' : 'rgb(199, 205, 219)';
      return { id: edge.id, source: edge.source, target: edge.target, state: selectedId === null ? 'normal' : highlighted ? 'highlighted' : 'unrelated', color,
        markerStroke: color, markerFill: color, markerLocal: true, external: String(edge.external), role: 'img', focusable: 'false',
        stroke: edge.external ? 'none' : color, dashed: edge.external, hasPaint: edge.external, paintValid: true, passive: true };
    }).sort((a, b) => a.id.localeCompare(b.id)),
  };
  // One atomic observation and exact comparison retain every identity and field
  // without emitting a separate Playwright trace step for each graph element.
  const actual = await page.evaluate(() => ({
    nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => {
      const card = node.querySelector<HTMLElement>('.task-node')!; const body = card.querySelector<HTMLButtonElement>('.task-node-body')!;
      const details = card.querySelector<HTMLButtonElement>('.task-node-details')!; const status = card.querySelector<HTMLElement>('.graph-status')!; const style = getComputedStyle(card);
      return { id: node.dataset.id!, state: card.dataset.inspection, pressed: body.getAttribute('aria-pressed'), background: style.backgroundColor,
        bodyTag: body.tagName, bodyType: body.getAttribute('type'), bodyPopup: body.getAttribute('aria-haspopup'), detailsTag: details.tagName, detailsType: details.getAttribute('type'), detailsPopup: details.getAttribute('aria-haspopup'),
        status: status.textContent, statusColor: getComputedStyle(status).color, borderColor: style.borderLeftColor, borderStyle: style.borderLeftStyle };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...document.querySelectorAll<SVGGElement>('.task-dependency-edge')].map((edge) => {
      const path = edge.querySelector<SVGPathElement>('.react-flow__edge-path')!; const style = getComputedStyle(path); const color = getComputedStyle(edge.querySelector('.task-dependency-body')!).stroke;
      const markerUrl = path.getAttribute('marker-end')!; const markerId = /#([^#)]+)\)/.exec(markerUrl)?.[1];
      const marker = markerId === undefined ? null : document.getElementById(markerId)?.querySelector('polyline'); const markerStyle = marker === null || marker === undefined ? null : getComputedStyle(marker);
      const pieces = [...edge.querySelectorAll<SVGGraphicsElement>('.task-dependency-paint-piece')];
      const dash = (value: string) => { const parts = value.match(/[-+\d.]+/g)?.map(Number); return parts?.length === 2 && parts[0] === 5 && parts[1] === 4; };
      return { id: edge.dataset.id!, source: path.dataset.source!, target: path.dataset.target!, state: edge.dataset.inspection, color,
        markerStroke: markerStyle?.stroke, markerFill: markerStyle?.fill, markerLocal: marker !== null && marker !== undefined && edge.closest('svg')!.contains(marker), external: edge.getAttribute('data-external'),
        role: edge.getAttribute('role'), focusable: edge.getAttribute('focusable'), stroke: style.stroke, dashed: pieces.length > 0 && pieces.every((piece) => dash(getComputedStyle(piece).strokeDasharray)), hasPaint: pieces.length > 0,
        paintValid: pieces.every((piece) => { const paint = getComputedStyle(piece); return paint.stroke === color && dash(paint.strokeDasharray) && Number.parseFloat(paint.strokeWidth) === 1.5
          && paint.strokeLinecap === 'butt' && paint.strokeLinejoin === 'miter' && paint.pointerEvents === 'none'
          && piece.getAttribute('aria-hidden') === 'true' && piece.getAttribute('focusable') === 'false'; }),
        passive: path.getAttribute('aria-hidden') === 'true' && style.pointerEvents === 'none' };
    }).sort((a, b) => a.id.localeCompare(b.id)),
  }));
  expect(actual, 'Every visible node and dependency exactly matches the full upstream closure and rendered inspection semantics').toEqual(expected);
  const shown = new Set(visible.nodes.map(({ id }) => id));
  const hidden = [...closure].filter((id) => !shown.has(id)).length;
  await expect(page.locator('.task-graph')).toHaveAttribute('data-hidden-upstream-count', String(hidden));
  if (hidden > 0) await expect(page.locator('.graph-hidden-prerequisites')).toHaveText(`另有${hidden}个上游未展开`);
  else await expect(page.locator('.graph-hidden-prerequisites')).toHaveText('');
  return hidden;
};

type LocalFeedback = { detailMs: number; detailNetworkMs: number; zoomMs: number; panMs: number };
const measureDetailsZoomPan = async (page: Page, fixture: CapacityFixture, taskId: string, dataset: Dataset, repetition: number, expected: GeometryExpectation, full: ChainTopology): Promise<LocalFeedback> => {
  const dialog = page.locator('.task-detail-backdrop').getByRole('dialog');
  const detailResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/projects/${fixture.project.id}/tasks/${taskId}`));
  const detail = await measureBrowserFeedback(page, { kind: 'detail', rootId: taskId }, () =>
    page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-details`).click(), dataset, repetition);
  await expect(dialog).toBeVisible();
  const response = await detailResponse;
  expect(response.status()).toBe(200);
  await response.finished();
  const timing = response.request().timing();
  const detailNetworkMs = timing.responseEnd - timing.requestStart;
  await expect(page.locator('.task-detail-title')).toHaveText(fixture.tasks.find((task) => task.id === taskId)!.title);
  await assertVisibleTopology(page, expected, full);
  await dialog.locator('.task-detail-header').getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const beforeZoom = await transform(page);
  const zoom = await measureBrowserFeedback(page, { kind: 'zoom', previousTransform: beforeZoom }, () =>
    page.locator('.react-flow__controls').getByRole('button', { name: '放大', exact: true }).click(), dataset, repetition);

  const point = await panPoint(page);
  await page.mouse.move(point.x, point.y);
  const beforePan = await transform(page);
  const pan = await measureBrowserFeedback(page, { kind: 'pan', previousTransform: beforePan }, async () => {
    await page.mouse.down();
    try { await page.mouse.move(point.x + 40, point.y + 24); }
    finally { await page.mouse.up(); }
  }, dataset, repetition);
  return { detailMs: detail.duration, detailNetworkMs, zoomMs: zoom.duration, panMs: pan.duration };
};

const measureInteractions = async (page: Page, fixture: CapacityFixture, expansion: ExpansionMeasurement, dataset: Dataset, repetition: number, info: TestInfo, overview: GeometryExpectation, full: ChainTopology, snapshotOrder: readonly string[]): Promise<Measurement> => {
  await assertVisibleTopology(page, overview, full);
  expect(overview.nodes.length).toBeLessThanOrEqual(50); expect(overview.edges.length).toBeLessThanOrEqual(100);
  await assertInspection(page, fixture, null, overview);
  const initialGeometry = await stableGeometry(page);
  expect(await checkDependencyGeometry(page, overview, info), 'Every overview dependency has independent complete geometry').toEqual({ total: 0, examples: [] });
  // The root stays accessible in the initial overview. Keep the original
  // details-close-immediate-zoom/pan sequence before changing inspection.
  const normal = await measureDetailsZoomPan(page, fixture, fixture.root.id, dataset, repetition, overview, full);
  await assertVisibleTopology(page, overview, full);
  const normalGeometry = await stableGeometry(page);
  expect(bodyGeometry(normalGeometry), 'Normal Details and navigation retain every visible node and route').toEqual(bodyGeometry(initialGeometry));
  expect(await checkDependencyGeometry(page, overview, info), 'All normal dependencies retain complete geometry after immediate zoom and pan').toEqual({ total: 0, examples: [] });

  const selectedId = [...overview.nodes].sort((a, b) => ancestorClosure(fixture, b.id).size - ancestorClosure(fixture, a.id).size || a.id.localeCompare(b.id))[0]!.id;
  const body = page.locator(`.react-flow__node[data-id="${selectedId}"] .task-node-body`);
  await page.keyboard.press('Tab'); await body.focus(); await painted(page);
  const beforeSelection = await stableGeometry(page);
  const selection = await measureBrowserFeedback(page, { kind: 'select', rootId: selectedId }, () => body.click(), dataset, repetition);
  const hiddenUpstream = await assertInspection(page, fixture, selectedId, overview);
  await assertVisibleTopology(page, overview, full);
  expect((await stableGeometry(page)).geometry, 'Selection never expands hidden tasks or changes nodes, routes, paint geometry or viewport').toEqual(beforeSelection.geometry);
  expect(await checkDependencyGeometry(page, overview, info), 'All visible highlighted dependencies retain their native geometry and paint').toEqual({ total: 0, examples: [] });
  await expect(page.locator('.task-detail-dialog')).toHaveCount(0);
  await expectOpenChain(page, fixture.root.id);
  const highlighted = await measureDetailsZoomPan(page, fixture, selectedId, dataset, repetition, overview, full);
  expect(bodyGeometry(await stableGeometry(page)), 'Highlighted Details and navigation retain every visible node and route').toEqual(bodyGeometry(beforeSelection));
  expect(await checkDependencyGeometry(page, overview, info), 'All highlighted dependencies retain complete geometry after immediate zoom and pan').toEqual({ total: 0, examples: [] });
  await assertInspection(page, fixture, selectedId, overview);
  await assertVisibleTopology(page, overview, full);

  const currentIds = overview.nodes.map(({ id }) => id);
  const batches = overview.nodes.flatMap((node) => (['upstream', 'downstream'] as const).map((direction) => ({
    id: node.id, direction, expanded: expectedBatch(full, currentIds, node.id, direction, snapshotOrder),
  }))).filter((batch) => batch.expanded.nodes.length > overview.nodes.length).sort((a, b) => b.expanded.edges.length - a.expanded.edges.length || b.expanded.nodes.length - a.expanded.nodes.length || a.id.localeCompare(b.id));
  const batch = batches[0]; if (batch === undefined) throw new Error('A bounded overview of this connected capacity graph must expose a hidden direct neighbor.');
  const addedNodes = batch.expanded.nodes.length - overview.nodes.length; const addedEdges = batch.expanded.edges.length - overview.edges.length;
  const direction = batch.direction === 'upstream' ? 'prerequisites' : 'successors'; const label = batch.direction === 'upstream' ? '前置' : '后续';
  const control = page.locator(`.react-flow__node[data-id="${batch.id}"] .task-node-expand[data-direction="${direction}"]`);
  await expect(control).toHaveAttribute('data-added-tasks', String(addedNodes)); await expect(control).toHaveAttribute('data-added-edges', String(addedEdges));
  const current = new Set(currentIds);
  const totalHidden = full.edges.filter((edge) => batch.direction === 'upstream' ? edge.target === batch.id && !current.has(edge.source) : edge.source === batch.id && !current.has(edge.target)).length;
  const remaining = totalHidden - addedNodes;
  await expect(control).toHaveAttribute('data-remaining', String(remaining));
  await expect(control).toHaveAccessibleName(`展开${label} ${count(addedNodes)} 个任务、${count(addedEdges)} 条依赖${remaining > 0 ? `，剩余 ${count(remaining)} 个${label}未展开` : ''}`);
  expect(addedNodes).toBeGreaterThan(0); expect(addedNodes).toBeLessThanOrEqual(20);
  await page.keyboard.press('Tab'); await control.focus(); await control.click();
  await expect(page.locator('.react-flow__node')).toHaveCount(batch.expanded.nodes.length);
  await assertVisibleTopology(page, batch.expanded, full);
  await expect(page.locator(`.react-flow__node[data-id="${batch.id}"] .task-node-body`)).toBeFocused();
  expect(await checkDependencyGeometry(page, batch.expanded, info), 'Explicit expansion paints every newly induced API relation without an edge limit').toEqual({ total: 0, examples: [] });
  await assertInspection(page, fixture, selectedId, batch.expanded);
  await page.locator('.graph-reset-overview').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(overview.nodes.length);
  await visibleGraph(page, fixture.root.id, overview);
  await expect(page.locator('.graph-reset-overview')).toBeFocused();
  await assertVisibleTopology(page, overview, full);
  expect((await stableGeometry(page)).geometry, 'Reset restores the deterministic overview and reframes its original viewport').toEqual(initialGeometry.geometry);
  expect(await checkDependencyGeometry(page, overview, info), 'Reset retains complete visible graph geometry').toEqual({ total: 0, examples: [] });
  dataset.visibility.push({ repetition, selectedId, overviewNodes: overview.nodes.length, overviewEdges: overview.edges.length, hiddenUpstream, addedNodes, addedEdges,
    expandedNodes: batch.expanded.nodes.length, expandedEdges: batch.expanded.edges.length, resetNodes: overview.nodes.length, resetEdges: overview.edges.length });
  return { ...expansion, selectMs: selection.duration,
    detailMs: Math.max(normal.detailMs, highlighted.detailMs), detailNetworkMs: Math.max(normal.detailNetworkMs, highlighted.detailNetworkMs),
    zoomMs: Math.max(normal.zoomMs, highlighted.zoomMs), panMs: Math.max(normal.panMs, highlighted.panMs) };
};

const checkMeasurement = (measurement: Measurement) => {
  for (const value of Object.values(measurement)) {
    expect(Number.isFinite(value), 'Measured browser duration is finite').toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(measurement.openMs, 'Collapsed root opens within the supported capacity budget').toBeLessThanOrEqual(3000);
  expect(measurement.selectMs, 'Dependency selection has visible local feedback within budget').toBeLessThanOrEqual(300);
  expect(measurement.detailMs, 'Details has visible local feedback within budget').toBeLessThanOrEqual(300);
  expect(measurement.zoomMs, 'Zoom has visible feedback within budget').toBeLessThanOrEqual(300);
  expect(measurement.panMs, 'Pan has visible feedback within budget').toBeLessThanOrEqual(300);
};

test.describe('fixed capacity and performance @capacity', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(persist);
  test.afterAll(async () => {
    receipt.result = receipt.result !== 'failed' && receipt.datasets.length === 4
      && receipt.datasets.every((dataset) => dataset.result === 'passed' && dataset.measurements.length === 5 && dataset.visibility.length === 5)
      && receipt.limits.node !== undefined && receipt.limits.edge !== undefined ? 'passed' : 'failed';
    await persist();
  });

  for (const kind of ['chain', 'merge', 'shared', 'external'] as const satisfies readonly CapacityKind[]) {
    const scenario = `capacity-${kind}`;
    test(`operates bounded ${kind} views of the complete API graph`, { annotation: { type: 'scenario', description: scenario } }, async ({ page, api: request }, info) => {
      test.setTimeout(240_000);
      const dataset: Dataset = { scenario, nodes: 1000, edges: kind === 'chain' ? 999 : 5000, result: 'running', measurements: [], visibility: [], feedbackDiagnostics: [],
        controllerDurations: { repetitions: [] } };
      receipt.datasets.push(dataset);
      await persist();
      try {
        await withScreenshot(page, info, scenario, async () => {
          const fixtureStart = performance.now();
          const fixture = await seedCapacity(request, kind);
          dataset.controllerDurations.fixtureMs = performance.now() - fixtureStart;
          if (kind === 'merge') mergeFixture = fixture;
          expect(fixture.tasks).toHaveLength(1000);
          if (kind === 'chain') {
            expect(fixture.tasks.slice(1).map((task) => task.dependsOn)).toEqual(fixture.tasks.slice(0, -1).map((task) => [task.id]));
          }
          if (kind === 'external') {
            expect(fixture.tasks.filter((task) => task.dependsOn.includes(fixture.root.id))).toHaveLength(1);
            expect(fixture.tasks.at(-1)!.dependsOn).toHaveLength(108);
          }
          const snapshotStart = performance.now();
          const { graph } = await readProjectSnapshot(request, fixture.project.id);
          expect(graph.summary.total).toBe(1000);
          expect(graph.summary).not.toHaveProperty('proposed');
          expect(graph.summary.todo).toBe(1000);
          expect(graph.tasks).toHaveLength(1000);
          expect(new Set(graph.tasks.map((task) => task.id)).size).toBe(1000);
          expect(graph.tasks.reduce((count, task) => count + task.dependsOn.length, 0)).toBe(dataset.edges);
          expect(new Map(graph.tasks.map((task) => [task.id, [...task.dependsOn].sort()]))).toEqual(
            new Map(fixture.tasks.map((task) => [task.id, [...task.dependsOn].sort()])),
          );
          expect(new Map(graph.tasks.map((task) => [task.id, [...task.externalDependsOn].sort()]))).toEqual(
            new Map(fixture.tasks.map((task) => [task.id, [...task.externalDependsOn].sort()])),
          );
          dataset.controllerDurations.snapshotMs = performance.now() - snapshotStart;
          const snapshotOrder = graph.tasks.map(({ id }) => id);
          const full = expectedDependencyTopology(graph.tasks, fixture.root.id); const overview = expectedOverview(full, fixture.root.id, snapshotOrder);
          expect(full.memberIds).toHaveLength(kind === 'external' ? 2 : 1000);
          let graphRequests = 0;
          const trackGraph = (request: { url: () => string }) => { if (new URL(request.url()).pathname === `/api/v1/projects/${fixture.project.id}/task-sync`) graphRequests++; };
          page.on('request', trackGraph);
          await observeSyncFetches(page, fixture.project.id);
          const graphResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${fixture.project.id}/task-sync`);
          const coldStart = performance.now();
          await page.goto(`/projects/${fixture.project.id}`, { waitUntil: 'domcontentloaded' });
          const total = page.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: /^任务总数$/ }) }).locator('.stat-number');
          await expect(total).toHaveText(count(1000));
          await expect(page.locator('.stats .stat')).toHaveCount(6);
          await expect(page.locator('.stats .stat-label').filter({ hasText: /^待审批$/ })).toHaveCount(0);
          await expect(page.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: /^待处理$/ }) }).locator('.stat-number')).toHaveText(count(1000));
          await selectTaskList(page);
          await expectClosedChain(page, fixture.root.id);
          await openChain(page, fixture.root.id);
          await visibleGraph(page, fixture.root.id, overview);
          await assertVisibleTopology(page, overview, full);
          const externalIds = new Set(full.nodes.filter((node) => !full.memberIds.includes(node.id)).map((node) => node.id));
          await expect(page.locator(`#task-root-${fixture.root.id} .root-progress-label`)).toHaveText(`0/${count(1000 - externalIds.size)} 已完成`);
          await expect(page.locator('.task-node-external')).toHaveCount(overview.nodes.filter((node) => externalIds.has(node.id)).length);
          dataset.coldOpenMs = performance.now() - coldStart;
          const initialResponse = await graphResponse;
          expect(initialResponse.status()).toBe(200);
          await initialResponse.finished();
          dataset.networkMs = await page.evaluate((url) => {
            const entries = performance.getEntriesByName(url, 'resource') as PerformanceResourceTiming[];
            const initial = entries[0];
            if (initial === undefined || initial.initiatorType !== 'fetch') throw new Error('Initial task synchronization network resource timing is missing.');
            return initial.duration;
          }, initialResponse.url());
          expect(Number.isFinite(dataset.networkMs)).toBe(true);
          expect(dataset.networkMs).toBeGreaterThanOrEqual(0);
          const root = page.locator(`#task-chain-graph-${fixture.root.id}`);
          for (let repetition = 0; repetition < 5; repetition++) {
            await expectOpenChain(page, fixture.root.id);
            await closeChain(page);
            await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
            await expectClosedChain(page, fixture.root.id);
            await root.scrollIntoViewIfNeeded();
            const repetitionStart = performance.now();
            let interactionMs!: number;
            await withCapacityTrace(page, info, `${scenario}-repetition-${repetition}`, async () => {
              const interactionStart = performance.now();
              const opened = await measureBrowserFeedback(page, { kind: 'open', rootId: fixture.root.id, nodes: overview.nodes.length, edges: overview.edges.length }, () => root.click(), dataset, repetition);
              const expansion = await page.evaluate(({ rootId, start, paintedTime }) => {
                const measures = (performance.getEntriesByName('daynight:task-layout', 'measure') as PerformanceMeasure[])
                  .filter((measure) => measure.detail?.rootId === rootId && measure.startTime >= start);
                if (measures.length !== 1) throw new Error('Expected exactly one layout measurement for this task-chain modal opening.');
                const measure = measures[0]!;
                return {
                  openMs: paintedTime - start,
                  layoutMs: measure.duration,
                  renderMs: paintedTime - (measure.startTime + measure.duration),
                };
              }, { rootId: fixture.root.id, start: opened.start, paintedTime: opened.end });
              const measurement = await measureInteractions(page, fixture, expansion, dataset, repetition, info, overview, full, snapshotOrder);
              dataset.measurements.push(measurement);
              await persist();
              checkMeasurement(measurement);
              interactionMs = performance.now() - interactionStart;
            });
            dataset.controllerDurations.repetitions.push({ interactionMs, totalMs: performance.now() - repetitionStart });
            await persist();
          }
          let reads!: SyncFetchWindow['__daynightCapacitySyncFetches'];
          let network!: number;
          await expect.poll(async () => {
            reads = await page.evaluate(() => (window as unknown as SyncFetchWindow).__daynightCapacitySyncFetches);
            network = graphRequests;
            return reads.length === network;
          }, { message: 'Every observed task synchronization fetch reaches the real network' }).toBe(true);
          const initial = reads.filter((read) => read.pollingCallback === null).length;
          const periodic = reads.filter((read) => read.pollingCallback !== null).length;
          expect(initial, 'Close and reopen reuse the snapshot; only initial load reads outside the polling callback').toBe(1);
          expect(reads[0]!.pollingCallback).toBeNull();
          expect(new Set(reads.flatMap((read) => read.pollingCallback === null ? [] : [read.pollingCallback])).size).toBe(periodic);
          expect(network, 'Only initial load and actual periodic callbacks read task summaries').toBe(initial + periodic);
          dataset.syncReads = { initial, periodic, network };
          await persist();
          page.off('request', trackGraph);
        });
        dataset.result = 'passed';
      } catch (error) {
        dataset.result = 'failed';
        dataset.error = error instanceof Error ? error.name : 'UnknownError';
        receipt.result = 'failed';
        throw error;
      } finally { await persist(); }
    });
  }

  test('rejects each independent graph capacity limit without partial data', { annotation: { type: 'scenario', description: 'capacity-limits' } }, async ({ page, api: request }, info) => {
    test.setTimeout(240_000);
    const assertRefusal = async (projectId: string, nodes: number, edges: number) => {
      const response = await request.get(`/api/v1/projects/${projectId}/task-sync`, { headers: { 'Daynight-Worker-Protocol': '2' } });
      expect(response.status()).toBe(409);
      const body = await response.json() as { error: { code: string; details: Omit<Limit, 'status'> } };
      expect(body.error.code).toBe('graph_limit_exceeded');
      const observed = { status: response.status(), ...body.error.details };
      expect(observed).toEqual({ status: 409, nodeCount: nodes, edgeCount: edges, maxNodes: 1000, maxEdges: 5000 });
      const browserResponse = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
      await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      expect((await browserResponse).status()).toBe(409);
      await expect(page.getByRole('alert')).toContainText('任务图超过展示上限');
      await expect(page.getByRole('alert')).toContainText(`当前 ${nodes.toLocaleString('zh-CN')} 个任务、${edges.toLocaleString('zh-CN')} 条依赖`);
      await expect(page.getByRole('region', { name: '项目任务统计' })).toHaveCount(0);
      await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
      await expect(page.locator('.root-list')).toHaveCount(0);
      await expect(page.locator('.standalone-list')).toHaveCount(0);
      await expect(page.getByRole('tablist', { name: '项目任务视图', exact: true })).toHaveCount(0);
      return observed;
    };
    try {
      await withScreenshot(page, info, 'capacity-limits', async () => {
        const nodeProject = await seedNodeLimit(request);
        receipt.limits.node = await assertRefusal(nodeProject.id, 1001, 0);
        await persist();
        const nodeScreenshot = join(evidenceDirectory(), 'capacity-limits-node.png');
        await page.screenshot({ path: nodeScreenshot, fullPage: false });
        await info.attach('capacity-limits-node', { path: nodeScreenshot, contentType: 'image/png' });

        if (mergeFixture === undefined || mergeFixture.additionalEdge === undefined) throw new Error('The measured merge fixture is required for the independent edge limit.');
        const { task, predecessorId } = mergeFixture.additionalEdge;
        const projectId = mergeFixture.project.id;
        expect(task.dependsOn).not.toContain(predecessorId);
        const extended = await updateTask(request, projectId, task.id, { version: task.version, dependsOn: [...task.dependsOn, predecessorId] });
        let original: unknown;
        try {
          receipt.limits.edge = await assertRefusal(projectId, 1000, 5001);
        } catch (error) {
          original = error;
          throw error;
        } finally {
          try {
            await updateTask(request, projectId, task.id, { version: extended.version, dependsOn: task.dependsOn });
            const restored = await request.get(`/api/v1/projects/${projectId}/task-sync`, { headers: { 'Daynight-Worker-Protocol': '2' } });
            expect(restored.status()).toBe(200);
            const body = await restored.json() as { tasks: { dependsOn: string[] }[] };
            expect(body.tasks.reduce((count, candidate) => count + candidate.dependsOn.length, 0)).toBe(5000);
          } catch (error) {
            if (original !== undefined) throw new AggregateError([original, error], 'Graph limit assertion and fixture restoration failed.');
            throw error;
          }
        }
      });
    } catch (error) {
      receipt.result = 'failed';
      throw error;
    } finally { await persist(); }
  });
});
