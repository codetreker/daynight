import { useEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { AssistantTaskWriteUnknown, createAssistantTask, enableWatchdog, getAssistantTask, type CreateAssistantTaskInput } from '../../api/assistant-tasks';
import type { BotDefinition } from '../../api/bots';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { assistantTaskAdmission, loadAssistantTasks } from './assistant-task-data';
import { AssistantTaskDialog } from './AssistantTaskDialog';
import { useAssistantTaskMessages } from './messages';
type Pending = { readonly kind:'ordinary'; readonly input:CreateAssistantTaskInput } | { readonly kind:'watchdog'; readonly input:{readonly id:string;readonly targetBotId:string} };
const pendingMemory=new Map<string,Pending>(), active=new Set<string>();
function saved(key:string):Pending|null {
  const memory=pendingMemory.get(key); if(memory)return memory;
  try { const data=JSON.parse(sessionStorage.getItem(key)??'null') as Pending|null; if(data && ['ordinary','watchdog'].includes(data.kind) && typeof data.input?.id==='string'){pendingMemory.set(key,data);return data;} } catch { /* Memory still protects the mounted application if storage is unavailable. */ }
  return null;
}
function remember(key:string,value:Pending|null) {
  if(value)pendingMemory.set(key,value);else pendingMemory.delete(key);
  try {if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);}catch { /* The in-memory original identity remains available. */ }
}
export function AssistantTaskCreate({watchdog,bots,enabled,onClose,onCreated}: {readonly watchdog:boolean;readonly bots:readonly BotDefinition[];readonly enabled:boolean;readonly onClose:()=>void;readonly onCreated:(id:string)=>void}) {
  const m=useAssistantTaskMessages(), scope=useTaskCacheScope(), key=`daynight:assistant-task-create:${scope.userId}:${watchdog?'watchdog':'ordinary'}`;
  const [pending,setPending]=useState(()=>saved(key)),[id]=useState(()=>saved(key)?.input.id??crypto.randomUUID());
  const draft=pending?.kind==='ordinary'?pending.input:null;
  const [name,setName]=useState(draft?.name??''),[purpose,setPurpose]=useState(draft?.purpose??''),[range,setRange]=useState(draft?.scope??''),[body,setBody]=useState(draft?.manual.body??''),[kind,setKind]=useState<'continuous'|'once'>(draft?.kind??'continuous'),[botId,setBotId]=useState(pending?.kind==='watchdog'?pending.input.targetBotId:bots[0]?.id??'');
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[checked,setChecked]=useState(false),[checkedTarget,setCheckedTarget]=useState<string|null>(null);
  const live=useRef(true), gate=useRef(enabled);gate.current=enabled;
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const allowed=()=>live.current && gate.current && !scope.isInvalidated && !authRequestsPaused();
  const admission=assistantTaskAdmission(scope);
  const submit=async()=>{
    if(!allowed()||active.has(key)||saved(key))return;
    const request:Pending=watchdog?{kind:'watchdog',input:{id,targetBotId:botId}}:{kind:'ordinary',input:{id,name,purpose,scope:range,kind,takeover:'manual',application:'',trigger:null,manual:{body,rules:[]}}};
    active.add(key);setBusy(true);setError(null);
    try {
      await scope.ready(scope.signal);if(!allowed())return;
      // Preserve the original identity before dispatch, including across reloads.
      remember(key,request);setPending(request);
      const task=request.kind==='watchdog'?await enableWatchdog(request.input,scope.signal,admission):await createAssistantTask(request.input,scope.signal,admission);
      remember(key,null);
      if(allowed()){setPending(null);onCreated(task.id);}
    } catch(failure) {
      if(!(failure instanceof AssistantTaskWriteUnknown)){remember(key,null);if(allowed())setPending(null);}
      if(allowed())setError(failure);
    } finally {active.delete(key);if(live.current)setBusy(false);}
  };
  const check=async()=>{
    const request=saved(key);if(!request||!allowed()||active.has(key))return;
    setBusy(true);setError(null);setChecked(false);setCheckedTarget(null);
    try {
      await scope.ready(scope.signal);if(!allowed())return;
      const task=request.kind==='watchdog'?(await loadAssistantTasks(scope,scope.signal)).find(t=>t.application==='watchdog'):await getAssistantTask(request.input.id,scope.signal,admission);
      if(allowed()){setCheckedTarget(task?.id??null);setChecked(true);}
    } catch(failure){if(allowed()){setError(failure);if(failure instanceof ApiError&&failure.status===404)setChecked(true);}}
    finally{if(live.current)setBusy(false);}
  };
  const close=()=>{if(!busy)onClose();};
  return <AssistantTaskDialog title={watchdog?m.watchdog:m.create} onClose={close}><form onSubmit={event=>{event.preventDefault();void submit();}}>
    <div className="dialog-body assistant-task-form">{watchdog ? <><p>{m.watchdogDescription}</p><label>{m.selectBot}<select value={botId} onChange={event=>setBotId(event.target.value)} required><option value="" disabled>{m.selectBot}</option>{bots.map(bot=><option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>{!bots.length?<p>{m.noBots}</p>:null}</> : <>
      <label>{m.name}<input required maxLength={200} value={name} onChange={event=>setName(event.target.value)} /></label>
      <label>{m.purpose}<textarea required value={purpose} onChange={event=>setPurpose(event.target.value)} /></label>
      <label>{m.scope}<textarea required value={range} onChange={event=>setRange(event.target.value)} /></label>
      <label>{m.kind}<select value={kind} onChange={event=>setKind(event.target.value as 'continuous'|'once')}><option value="continuous">{m.continuous}</option><option value="once">{m.once}</option></select></label>
      <label>{m.body}<textarea required rows={8} value={body} onChange={event=>setBody(event.target.value)} /></label>
    </>}
    {pending ? <div role="alert" className="notice"><p>{m.unknown}</p><code>{pending.input.id}</code><button className="button" type="button" disabled={!enabled||busy} onClick={()=>void check()}>{m.check}</button>{checked?<><p>{m.checked}</p><button className="button" type="button" disabled={!enabled} onClick={()=>{remember(key,null);setPending(null);setError(null);if(checkedTarget)onCreated(checkedTarget);}}>{m.reviewed}</button></>:null}</div>:null}
    {error && !(error instanceof AssistantTaskWriteUnknown) ? <p role="alert">{watchdog && error instanceof ApiError && [404,405,501].includes(error.status??0)?m.watchdogUnavailable:m.writeError}</p>:null}</div>
    <footer className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={close}>{m.cancel}</button><button type="submit" className="button primary" disabled={!enabled||busy||pending!==null||active.has(key)||watchdog&&!botId}>{watchdog?m.watchdog:m.create}</button></footer>
  </form></AssistantTaskDialog>;
}
