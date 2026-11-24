import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
const root = fileURLToPath(new URL('../..', import.meta.url));
const stub = fileURLToPath(new URL('./ordinary-task-stubs.tsx', import.meta.url));
const replaceContexts = (): Plugin => ({ name: 'fixture-contexts', enforce: 'pre', configureServer(server) { server.middlewares.use((request, _response, next) => { if (request.url?.startsWith('/projects/')) request.url = '/tests/navigation/ordinary-task-fixture.html'; next(); }); }, resolveId(source, importer) {
  if (importer?.endsWith('/OrdinaryTaskRelations.tsx') && ['../task-cache/TaskCacheProvider', './TaskDetailSession', '../projects/ProjectAccess', '../task-assignment/AssigneePicker', '../task-tags/TagPicker'].includes(source)) return stub;
  if (importer?.endsWith('/OrdinarySubtaskRow.tsx') && source === '../projects/ProjectAccess') return stub;
  if (importer?.endsWith('/TaskAssigneeIdentity.tsx') && source === '../task-assignees/TaskAssignees') return stub;
  if (importer?.endsWith('/TaskRow.tsx') && source === '../usage/useTaskUsage') return stub;
  if ((importer?.endsWith('/TaskTagList.tsx') || importer?.endsWith('/TagColor.tsx')) && source === './useTagColors') return stub;
} });
export default defineConfig({ root, plugins: [replaceContexts(), react()], cacheDir: fileURLToPath(new URL('../../../../.tmp/ordinary-task-browser/cache', import.meta.url)), server: { host: '127.0.0.1', port: 14371, strictPort: true } });
