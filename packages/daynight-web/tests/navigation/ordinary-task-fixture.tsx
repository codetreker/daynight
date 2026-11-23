import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { browserNavigation } from '../../src/app/navigation';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { OrdinaryTaskRelations } from '../../src/features/task-detail/OrdinaryTaskRelations';
import type { TaskDetail, TaskStatus } from '../../src/api/types';
import '../../src/styles/typography.css';
import '../../src/styles/task-detail.css';
import '../../src/features/task-detail/task-organization.css';

const project = '10000000-0000-4000-8000-000000000001';
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = (n: number, status: TaskStatus = 'todo'): TaskDetail => ({ id: id(n), projectId: project, type: 'task', parentId: null, parentTaskId: n > 1 && n <= 6 ? id(n - 1) : n > 6 ? id(1) : null, title: `Task ${n}`, description: '', status, version: 1n, properties: {}, tags: [], dependsOn: [], externalDependsOn: [], blockedBy: [], ready: status === 'todo', allowAgents: false, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: status === 'cancelled' ? '2026-01-01T00:00:00Z' : null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const tasks = [task(1), task(2, 'proposed'), task(3), task(4, 'in_progress'), task(5, 'done'), task(6, 'cancelled'), task(7, 'todo'), task(8, 'in_progress'), task(9, 'done'), task(10, 'cancelled')];
let fail = new URLSearchParams(location.search).has('fail');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? Number(v) : v), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': '30000000-0000-4000-8000-000000000001', 'Daynight-Task-Epoch': '40000000-0000-4000-8000-000000000001' } });
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (init?.method === 'POST' && url.pathname.endsWith('/tasks')) {
    const body = JSON.parse(String(init.body)); const created = { ...task(11, body.status ?? 'proposed'), parentTaskId: body.parentTaskId, title: body.title, description: body.description, assignedTo: body.assignedTo, tags: [] };
    tasks.push(created); return json(created, 201);
  }
  if (url.pathname.endsWith('/tasks')) {
    if (fail) { fail = false; return json({ error: { code: 'unavailable', message: 'Unavailable' } }, 503); }
    return json({ items: tasks.filter(item => item.parentTaskId === url.searchParams.get('parentTaskId')), nextCursor: null });
  }
  const found = tasks.find(item => url.pathname.endsWith(item.id)); return found === undefined ? json({ error: { code: 'not_found' } }, 404) : json(found);
};
const navigation = browserNavigation();
const App = () => {
  const location = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  const selected = tasks.find(item => location.pathname.endsWith(item.id)) ?? tasks[0]!;
  return <main><h1>{selected.title}</h1><p>A long description for the parent Task.</p><OrdinaryTaskRelations key={selected.id} projectId={project} detail={selected} history={1} active onRefreshGraph={() => {}} /></main>;
};
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: new URLSearchParams(location.search).has('zh') ? 'zh-CN' : 'en', issue: null }}><App /></LocaleProvider>);
