import { useCallback, useState, useEffect, useRef } from 'react';
import type { BotDefinition } from '../../api/bots';
import { type AssistantTask, getAssistantTask, getAssistantTaskManual, listAssistantTaskAppendices, listAssistantTaskManuals, listAssistantTaskProposals, listAssistantTaskEvents, listAssistantTaskItems, updateAssistantTask, deleteAssistantTask, transferAssistantTask, releaseAssistantTask, updateAssistantTaskAppendix, deleteAssistantTaskAppendix, decideAssistantTaskProposal, rollbackAssistantTaskManual } from '../../api/assistant-tasks';
import { navigate } from '../../app/router';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useBotRead } from './useBotRead';
import { assistantTaskAdmission, assistantTaskEventItem, assistantTaskState, assistantTaskUrl, collectAssistantPages } from './assistant-task-data';
import { useAssistantTaskMessages } from './messages';
import { AssistantTaskManual } from './AssistantTaskManual';
import { AssistantTaskRecords } from './AssistantTaskRecords';
import { AssistantTaskProposalPanel } from './AssistantTaskProposalPanel';
import { AssistantTaskDialog } from './AssistantTaskDialog';
import { useAssistantTaskMutation } from './useAssistantTaskMutation';
import { ApiError } from '../../api/client';
export function AssistantTaskDetail({taskId,tab='manual',recordId,eventId,enabled,bots,onChanged}: {readonly taskId:string;readonly tab?:'manual'|'records'|'proposals';readonly recordId?:string;readonly eventId?:string;readonly enabled:boolean;readonly bots:readonly BotDefinition[];readonly onChanged:()=>void}) {
  const m=useAssistantTaskMessages(), scope=useTaskCacheScope(), admission=assistantTaskAdmission(scope);
  const [dialog,setDialog]=useState<{kind:'transfer'|'release'|'delete';task:AssistantTask}|null>(null),[target,setTarget]=useState('');
  const load=useCallback(async(owner:TaskCacheScope,signal:AbortSignal)=>{
    const access=assistantTaskAdmission(owner),task=await getAssistantTask(taskId,signal,access);
    if(task.state==='deleted') return {task,manual:null,appendices:[],histories:[],proposals:[],events:[],items:[]};
    const [manual,appendices,histories,proposals,events,items]=await Promise.all([
      getAssistantTaskManual(taskId,signal,access),
      collectAssistantPages(cursor=>listAssistantTaskAppendices(taskId,{limit:200,...(cursor?{cursor}:{})},signal,access),value=>value.id),
      collectAssistantPages(cursor=>listAssistantTaskManuals(taskId,{limit:200,...(cursor?{cursor}:{})},signal,access),value=>value.version),
      collectAssistantPages(cursor=>listAssistantTaskProposals(taskId,{limit:200,...(cursor?{cursor}:{})},signal,access),value=>value.id),
      collectAssistantPages(cursor=>listAssistantTaskEvents({taskId,limit:200,...(cursor?{cursor}:{})},signal,access),value=>value.id),
      collectAssistantPages(cursor=>listAssistantTaskItems(taskId,{limit:200,...(cursor?{cursor}:{})},signal,access),value=>value.id),
    ]);
    // These separately versioned reads must agree before the user decides a write.
    const confirmed = await getAssistantTask(taskId,signal,access);
    if(manual.version!==task.manualVersion || confirmed.version!==task.version) throw new ApiError('protocol');
    return {task,manual,appendices,histories,proposals,events,items};
  },[taskId]);
  const read=useBotRead(`assistant-task:${taskId}`,enabled,load);
  const reload=async()=>{await load(scope,scope.signal);read.refresh();onChanged();};
  const mutation=useAssistantTaskMutation(taskId,enabled && !read.stale && !!read.value,reload);
  const value=read.value,task=value?.task;
  const focusedEvent=useRef<string|null>(null);
  useEffect(()=>{
    if(!eventId){focusedEvent.current=null;return;}
    if(!enabled || tab!=='records' || focusedEvent.current===eventId)return;
    const node=document.getElementById(`assistant-event-${eventId}`);
    if(node){node.scrollIntoView?.({block:'center'});node.focus({preventScroll:true});focusedEvent.current=eventId;}
  },[enabled,tab,eventId,value]);
  const unavailable=read.error instanceof ApiError && [403,404,410].includes(read.error.status??0) || task?.state==='deleted';
  const changeTab=(next:typeof tab)=>navigate(assistantTaskUrl(taskId,next));
  const showRecords=(id:string)=>navigate(assistantTaskUrl(taskId,'records',id));
  if(unavailable) return <section className="assistant-task-detail"><a href="/bots" onClick={event=>{event.preventDefault();navigate('/bots');}}>{m.back}</a><p role="status">{m.unavailable}</p>{mutation.notice}</section>;
  return <section className="assistant-task-detail" aria-label={task?.name ?? m.title}>
    <header className="assistant-task-heading"><div className="assistant-task-title"><a className="button quiet" href="/bots" onClick={event=>{event.preventDefault();navigate('/bots');}} aria-label={m.back}>←</a><h1>{task?.name ?? m.loading}</h1><button type="button" className="button quiet" onClick={read.refresh} aria-busy={read.busy}>{m.refresh}</button></div>
      {task ? <><div className="assistant-task-meta"><span className="assistant-task-badge">{m[assistantTaskState(task)]}</span><span>{task.kind==='continuous'?m.continuous:m.once}</span></div><p>{task.purpose}</p><p className="assistant-task-meta">{task.scope}</p>
      <dl className="assistant-task-registry"><div><dt>{m.holder}</dt><dd>{task.holderBotId ? <a href={`/bots/${task.holderBotId}`} onClick={event=>{event.preventDefault();navigate(`/bots/${task.holderBotId}`);}}>{bots.find(bot=>bot.id===task.holderBotId)?.name ?? task.holderBotId}</a>:m.unowned}</dd></div>{[[m.claimed,task.claimedAt],[m.renewed,task.renewedAt],[m.expires,task.leaseUntil]].map(([label,date])=><div key={label}><dt>{label}</dt><dd>{date?<time dateTime={date}>{new Date(date).toLocaleString()}</time>:'—'}</dd></div>)}</dl>
      <div className="assistant-task-actions"><button className="button" type="button" disabled={mutation.blocked} onClick={()=>{setTarget(bots.find(bot=>bot.id!==task.holderBotId)?.id??'');setDialog({kind:'transfer',task});}}>{task.claimState==='unowned'||task.claimState==='expired'?m.assign:m.transfer}</button><button className="button" type="button" disabled={mutation.blocked} onClick={()=>void mutation.run(signal=>updateAssistantTask(taskId,{ifVersion:task.version,state:task.state==='paused'?'active':'paused'},signal,admission))}>{task.state==='paused'?m.resume:m.pause}</button>{task.holderBotId?<button className="button" type="button" disabled={mutation.blocked} onClick={()=>setDialog({kind:'release',task})}>{m.release}</button>:null}<button className="button danger" type="button" disabled={mutation.blocked} onClick={()=>setDialog({kind:'delete',task})}>{m.remove}</button></div>
      <nav className="assistant-task-tabs" aria-label={m.title}>{(['manual','records','proposals'] as const).map(item=><button className="button quiet" type="button" key={item} aria-pressed={tab===item} onClick={()=>changeTab(item)}>{m[item]}{item==='proposals'&&value.proposals.some(p=>p.status==='pending')?` (${value.proposals.filter(p=>p.status==='pending').length})`:''}</button>)}</nav></>:null}
    </header>
    <div className="assistant-task-body">{mutation.notice}{read.error?<div className="notice error" role="alert"><p>{m.error}</p><button className="button" type="button" onClick={read.refresh}>{m.retry}</button></div>:null}
      {task && value?.manual ? <>
        <div hidden={tab!=='manual'}><AssistantTaskManual task={task} manual={value.manual} appendices={value.appendices} histories={value.histories} proposals={value.proposals} disabled={mutation.blocked} onAppendixEdit={(entry,text,ifVersion)=>mutation.run(signal=>updateAssistantTaskAppendix(taskId,entry.id,{ifVersion,text,sourceRecords:entry.sourceRecords},signal,admission))} onAppendixDelete={(entry,ifVersion)=>mutation.run(signal=>deleteAssistantTaskAppendix(taskId,entry.id,ifVersion,signal,admission))} onRollback={(version,ifVersion)=>mutation.run(signal=>rollbackAssistantTaskManual(taskId,{ifVersion,manualVersion:version},signal,admission))} onRecords={showRecords} /></div>
        <div hidden={tab!=='records'}>{value.events.filter(event=>['escalation','result_unknown'].includes(event.type) && event.state!=='expired' && !value.items.some(item=>item.id===assistantTaskEventItem(event.payload)&&item.state==='closed')).map(event=><article className="assistant-task-entry" id={`assistant-event-${event.id}`} key={event.id} tabIndex={-1}><h3>{event.type==='escalation'?m.escalation:m.unknownResult}</h3><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time><p>{event.payload && typeof event.payload==='object' && !Array.isArray(event.payload) && 'text' in event.payload && typeof event.payload.text==='string' ? event.payload.text : m.pendingDecisions}</p><p>{value.items.find(item=>item.id===assistantTaskEventItem(event.payload))?.key}</p></article>)}<AssistantTaskRecords taskId={taskId} enabled={enabled && tab==='records'} bots={bots} {...(recordId?{recordId}:{})} /></div>
        <div hidden={tab!=='proposals'}><AssistantTaskProposalPanel taskVersion={task.version} proposals={value.proposals} disabled={mutation.blocked} onDecide={(proposal,decision,ifVersion)=>mutation.run(signal=>decideAssistantTaskProposal(taskId,proposal.id,{ifVersion,...decision},signal,admission))} onRecords={showRecords} /></div>
      </>:null}
    </div>
    {dialog && task ? <AssistantTaskDialog title={dialog.kind==='delete'?m.remove:dialog.kind==='release'?m.release:m.transfer} onClose={()=>setDialog(null)}><form onSubmit={event=>{event.preventDefault();void (async()=>{
      const ok=await mutation.run(signal=>dialog.kind==='delete'?deleteAssistantTask(taskId,dialog.task.version,signal,admission):dialog.kind==='release'?releaseAssistantTask(taskId,{operationId:crypto.randomUUID(),ifVersion:dialog.task.version,expectedGeneration:dialog.task.claimGeneration},signal,admission):transferAssistantTask(taskId,{operationId:crypto.randomUUID(),ifVersion:dialog.task.version,expectedGeneration:dialog.task.claimGeneration,targetBotId:target},signal,admission));
      if(ok){setDialog(null);if(dialog.kind==='delete')navigate('/bots');}
    })();}}><div className="dialog-body assistant-task-form"><p>{dialog.kind==='delete'?m.confirmDelete:dialog.kind==='release'?m.confirmRelease:m.confirmTransfer}</p>{dialog.kind==='transfer'?<label>{m.selectBot}<select value={target} onChange={event=>setTarget(event.target.value)} required><option value="" disabled>{m.selectBot}</option>{bots.filter(bot=>bot.id!==task.holderBotId).map(bot=><option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>:null}{mutation.notice}</div><footer className="dialog-footer"><button type="button" className="button" onClick={()=>setDialog(null)}>{m.cancel}</button><button type="submit" className="button primary" disabled={mutation.blocked || dialog.kind==='transfer'&&!target}>{m.confirm}</button></footer></form></AssistantTaskDialog>:null}
  </section>;
}
