import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CurrentAccountProvider } from '../../src/app/CurrentAccountContext';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { TaskAssigneesProvider } from '../../src/features/task-assignees/TaskAssignees';
import { createTaskCacheScope, TaskCacheProvider } from '../../src/features/task-cache/TaskCacheProvider';
import { ProjectDraftHost } from '../../src/features/task-detail/TaskDraftNavigation';
import { TaskDetailDialog } from '../../src/features/task-detail/TaskDetailDialog';
import type { GraphSnapshot } from '../../src/features/projects/useTaskGraph';
import { admitTaskGraph } from '../helpers/taskSessions';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { taskSyncEpoch, TEST_VIEWER_ID } from '../helpers/taskSync';
import '../../src/styles/app.css';
import '../../src/styles/task-detail.css';
import '../../src/styles/attachments.css';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const goal = new URLSearchParams(location.search).get('resource') === 'goal';
const detail = detailFixture(projectId, taskId, goal ? { type: 'goal', title: 'Target goal', version: 5n, ready: false } : { title: 'Target task', version: 5n });
const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: () => { throw new Error('Unexpected identity'); } });
let directReads = 0;
const beginTaskRead = scope.beginTaskRead.bind(scope);
scope.beginTaskRead = (...args) => { directReads++; return beginTaskRead(...args); };

const project = await admitTaskGraph(scope, graphFixture([detail]), { epoch: taskSyncEpoch(projectId), versionForTask: () => detail.version, propertiesForTask: () => detail.properties });
const snapshot = (revision: number): GraphSnapshot => {
  const common = { graph: project.graph, index: project.index, summaries: project.summaries,
    workerMachines: project.workerMachines, pausedTaskIds: project.pausedTaskIds, receivedMonotonic: performance.now() };
  return revision === 0
    ? { ...common, observedAt: null, receivedAt: null, revision: 0, localTime: Date.now() }
    : { ...common, observedAt: project.graph.observedAt, receivedAt: Date.now(), revision };
};

const Fixture = () => {
  const [revision, setRevision] = useState<number | null>(null);
  const [source, setSource] = useState<'direct' | 'summary'>(goal ? 'direct' : 'summary');
  useEffect(() => {
    (window as unknown as { summaryDetailFixture: { setRevision(value: number | null): void; setSource(value: 'direct' | 'summary'): void; directReads(): number } }).summaryDetailFixture = { setRevision, setSource, directReads: () => directReads };
  }, []);
  const graph = revision === null ? null : snapshot(revision);
  return <LocaleProvider initial={{ locale: 'en', issue: null }}><CurrentAccountProvider user={{ id: TEST_VIEWER_ID, name: 'Reader' }} admissionBlocked={false}>
    <output data-testid="summary-fixture-stage">{source}:{revision === null ? 'none' : revision}</output>
    <TaskCacheProvider scope={scope}><TaskAssigneesProvider><ProjectDraftHost projectId={projectId} taskId={taskId} source={source} summaryType={graph === null ? undefined : graph.summaries.get(taskId)?.type ?? null} insideProjectGraph={false} graphWitness={null}>
      <TaskDetailDialog projectId={projectId} taskId={taskId} snapshot={graph} observation={source === 'direct' ? { kind: 'direct' } : { kind: 'project-summary', revision: revision ?? 0, task: graph?.index.nodes.get(taskId) }}
        onClose={() => {}} onRestoreFocus={() => {}} onSelectTask={() => {}} onRefreshGraph={() => {}} />
    </ProjectDraftHost></TaskAssigneesProvider></TaskCacheProvider>
  </CurrentAccountProvider></LocaleProvider>;
};
createRoot(document.getElementById('root')!).render(<Fixture />);
