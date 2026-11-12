import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { TaskExecutionClockProvider } from '../../src/features/task-execution/TaskExecutionClock';
import { TaskChainDialog } from '../../src/features/task-graph/TaskChainDialog';
import { buildGraphIndex } from '../../src/features/task-graph/model';
import { completeContextGraph } from '../helpers/graphData';
import '../../src/styles/app.css';

const rootId = '00000000-0000-4000-8000-000000000030';
const index = buildGraphIndex(completeContextGraph);
const Host = () => {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <TaskExecutionClockProvider projectId={completeContextGraph.project.id} snapshot={null}><button ref={trigger} onClick={() => setOpen(true)}>Open graph</button>{open && <TaskChainDialog
    projectId={completeContextGraph.project.id} index={index} rootId={rootId} onOpenTask={() => {}}
    onClose={() => setOpen(false)} onRestoreFocus={() => trigger.current?.focus()} />}</TaskExecutionClockProvider>;
};
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale: 'zh-CN', issue: null }}><Host /></LocaleProvider>);
