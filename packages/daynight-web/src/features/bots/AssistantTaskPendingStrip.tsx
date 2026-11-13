import { useCallback } from 'react';
import type { AssistantTask } from '../../api/assistant-tasks';
import { listAssistantTaskProposals, listAssistantTaskEvents, listAssistantTaskItems } from '../../api/assistant-tasks';
import { navigate } from '../../app/router';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { assistantTaskAdmission, assistantTaskUrl, assistantTaskEventItem, collectAssistantPages } from './assistant-task-data';
import { useBotRead } from './useBotRead';
import { useAssistantTaskMessages } from './messages';
export function AssistantTaskPendingStrip({botId,tasks,enabled}: {readonly botId:string;readonly tasks:readonly AssistantTask[];readonly enabled:boolean}) {
  const m=useAssistantTaskMessages(), ids=tasks.filter(t=>t.holderBotId===botId && t.state!=='deleted').map(t=>t.id).sort().join(',');
  const load=useCallback(async(scope:TaskCacheScope,signal:AbortSignal)=>{
    const admission=assistantTaskAdmission(scope);
    const results=await Promise.all(ids.split(',').filter(Boolean).map(async taskId=>{
      const [proposals,events,items]=await Promise.all([
        collectAssistantPages(cursor=>listAssistantTaskProposals(taskId,{limit:200,...(cursor?{cursor}:{})},signal,admission),p=>p.id),
        collectAssistantPages(cursor=>listAssistantTaskEvents({taskId,limit:200,...(cursor?{cursor}:{})},signal,admission),e=>e.id),
        collectAssistantPages(cursor=>listAssistantTaskItems(taskId,{limit:200,...(cursor?{cursor}:{})},signal,admission),i=>i.id),
      ]);
      return {taskId,proposals:proposals.filter(p=>p.status==='pending').length,events:events.filter(e=>e.state!=='expired' && ['escalation','result_unknown'].includes(e.type) && !items.some(i=>i.id===assistantTaskEventItem(e.payload)&&i.state==='closed'))};
    }));
    return results;
  },[ids]);
  const read=useBotRead(`assistant-pending:${botId}:${ids}`,enabled && !!ids,load);
  if (!ids || !read.error && !read.value?.some(v=>v.proposals || v.events.length)) return null;
  return <div className="assistant-task-pending" aria-label={m.pendingDecisions}>
    {read.error ? <button className="button quiet" type="button" onClick={read.refresh}>{m.error} · {m.retry}</button>:null}
    {read.value?.map(value=><span key={value.taskId}>{value.proposals ? <button type="button" className="button quiet" onClick={()=>navigate(assistantTaskUrl(value.taskId,'proposals'))}>{tasks.find(t=>t.id===value.taskId)?.name} · {m.proposals} ({value.proposals})</button>:null}{value.events.map(event=><button type="button" className="button quiet" key={event.id} onClick={()=>navigate(`${assistantTaskUrl(value.taskId,'records')}&eventId=${event.id}`)}>{tasks.find(t=>t.id===value.taskId)?.name} · {event.type==='escalation'?m.escalation:m.unknownResult}</button>)}</span>)}
  </div>;
}
