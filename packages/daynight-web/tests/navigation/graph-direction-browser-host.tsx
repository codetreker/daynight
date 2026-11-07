import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { TaskChainDialog } from '../../src/features/task-graph/TaskChainDialog';
import { buildGraphIndex } from '../../src/features/task-graph/model';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import '../../src/styles/app.css';

const projectA = '00000000-0000-4000-8000-000000000101', projectB = '00000000-0000-4000-8000-000000000102';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const graphA = graphFixture([detailFixture(projectA, id(1), { title: 'Goal A' }), detailFixture(projectA, id(2), { title: 'A child', dependsOn: [id(1)] }), detailFixture(projectA, id(3), { title: 'Goal B' }), detailFixture(projectA, id(4), { title: 'B child', dependsOn: [id(3)] })]);
const graphB = graphFixture([detailFixture(projectB, id(5), { title: 'Other project Goal' }), detailFixture(projectB, id(6), { title: 'Other child', dependsOn: [id(5)] })]);
const indexA = buildGraphIndex(graphA), indexB = buildGraphIndex(graphB);
const Host = () => {
  const [selected, setSelected] = useState<{ projectId: string; rootId: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return <><div><button ref={trigger} onClick={() => setSelected({ projectId: projectA, rootId: id(1) })}>Open Goal A</button>
    <button onClick={() => setSelected({ projectId: projectA, rootId: id(3) })}>Open Goal B</button>
    <button onClick={() => setSelected({ projectId: projectB, rootId: id(5) })}>Open other project</button></div>
    {selected && <TaskChainDialog projectId={selected.projectId} rootId={selected.rootId} index={selected.projectId === projectA ? indexA : indexB}
      onOpenTask={() => {}} onClose={() => setSelected(null)} onRestoreFocus={() => trigger.current?.focus()} />}</>;
};
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'en', issue: null }}><Host /></LocaleProvider>);
